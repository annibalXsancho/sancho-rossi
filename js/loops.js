// Sancho Rossi — générateur de boucles à la demande (rando clef en main)
// Départ = ancre de l'utilisateur (village / route / là où est laissée la moto).
// On charge le réseau de sentiers autour du départ (Overpass), on AIMANTE les
// waypoints d'un anneau sur de vrais nœuds de sentier, puis on route en boucle par
// BRouter (hiking-mountain, altitudes en 3ᵉ coord). On génère plusieurs candidats et
// on garde celui qui retrace le moins (pas d'aller-retour) tout en visant la distance.
import { haversineKm, state } from "./state.js";
import { overpassFetch } from "./api.js";
import { map, addMarker } from "./map.js";
import { renderAll, selectTrail } from "./trails.js";
import { closeDetail } from "./detail.js";
import { saveTraces } from "./storage.js";

const loops = {
  active: false,
  start: null,        // { lat, lon } — l'ancre exacte, jamais déplacée
  targetKm: 12,
  baseAngle: 0,       // orientation de l'anneau (tournée par « Autre proposition »)
  busy: false,
  routed: null,       // dernière boucle retenue { track, eles, distance, retrace }
  nodes: null,        // nœuds de sentier autour du départ (cache Overpass)
  nodesKey: null,
  layer: L.layerGroup(),
  startMarker: null,
  ghost: null,
};

// ---------- Géométrie de l'anneau ----------
function offsetKm(lat, lon, rKm, angleRad) {
  const dLat = (rKm / 111.32) * Math.cos(angleRad);
  const dLon = (rKm / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(angleRad);
  return [lat + dLat, lon + dLon];
}

function ringWaypoints(start, rKm, n, baseAngle) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const ang = baseAngle + (i / n) * 2 * Math.PI;
    const jitter = 0.9 + 0.2 * (0.5 + 0.5 * Math.sin(i * 2.4 + baseAngle));
    pts.push(offsetKm(start.lat, start.lon, rKm * jitter, ang));
  }
  return pts;
}

// ---------- Réseau de sentiers (Overpass) : nœuds sur lesquels aimanter ----------
async function ensureNodes(start, target) {
  const key = `${start.lat.toFixed(3)},${start.lon.toFixed(3)}/${Math.round(target)}`;
  if (loops.nodesKey === key && loops.nodes) return loops.nodes;
  const radiusM = Math.round(Math.max(target / 6 * 1.7, 1.3) * 1000);
  const q =
    `[out:json][timeout:25];` +
    `way["highway"~"^(path|track|footway|bridleway|steps|cycleway)$"]` +
    `(around:${radiusM},${start.lat},${start.lon});out geom;`;
  let nodes = [];
  try {
    const data = await overpassFetch(q);
    for (const el of data.elements || []) {
      if (el.geometry) for (const g of el.geometry) nodes.push([g.lat, g.lon]);
    }
  } catch { nodes = []; } // réseau indisponible : on retombera sur l'anneau géométrique
  // On ne met en cache QUE les succès : un échec transitoire (Overpass 429, fréquent)
  // ne doit pas condamner l'aimantage pour ce départ — la prochaine génération réessaie.
  if (nodes.length) { loops.nodes = nodes; loops.nodesKey = key; }
  return nodes;
}

function nearestNode(pt, nodes) {
  let best = null, bd = Infinity;
  for (const n of nodes) {
    const d = haversineKm(pt, n);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

// Aimante les waypoints sur des nœuds de sentier distincts ; garde le point
// géométrique si aucun sentier n'est assez proche (zone sans réseau).
function snapWaypoints(ring, nodes) {
  if (!nodes.length) return ring;
  const out = [];
  const used = new Set();
  for (const p of ring) {
    const n = nearestNode(p, nodes);
    // trop loin d'un sentier (> 1,2 km) : on garde le point brut plutôt qu'un grand détour
    if (!n || haversineKm(p, n) > 1.2) { out.push(p); continue; }
    const k = `${n[0].toFixed(5)},${n[1].toFixed(5)}`;
    if (used.has(k)) continue; // évite deux waypoints sur le même nœud
    used.add(k);
    out.push(n);
  }
  return out;
}

// ---------- Routage BRouter (boucle en un seul appel) ----------
async function brouterLoop(waypoints) {
  // supprime les points consécutifs quasi identiques (BRouter refuse les via nuls)
  const pts = waypoints.filter((p, i) => i === 0 || haversineKm(p, waypoints[i - 1]) > 0.03);
  if (pts.length < 3) throw new Error("waypoints insuffisants");
  const lonlats = pts.map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join("|");
  const url =
    `https://brouter.de/brouter?lonlats=${lonlats}` +
    `&profile=hiking-mountain&alternativeidx=0&format=geojson`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`BRouter ${res.status}`);
  const feat = (await res.json()).features?.[0];
  if (!feat) throw new Error("BRouter : aucune route");
  const track = feat.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  let eles = feat.geometry.coordinates.map((c) => c[2]);
  if (eles.some((v) => v == null) || eles.length !== track.length) eles = null;
  const distance = Number(feat.properties["track-length"]) / 1000;
  if (!(distance > 0) || track.length < 4) throw new Error("BRouter : boucle dégénérée");
  return { track, eles, distance, retrace: retraceFraction(track) };
}

// Fraction du tracé retracée : on ré-échantillonne à ~50 m (sinon la densité des
// points fausse la mesure), puis on compte les cellules ~55 m visitées deux fois.
// 0 = boucle propre, élevé = aller-retour.
function retraceFraction(track) {
  const kept = [];
  let acc = 0;
  for (let i = 0; i < track.length; i++) {
    if (i > 0) acc += haversineKm(track[i - 1], track[i]) * 1000;
    if (i === 0 || acc >= 50) { kept.push(track[i]); acc = 0; }
  }
  const cells = new Map();
  for (const p of kept) {
    const k = Math.round(p[0] / 0.0005) + "_" + Math.round(p[1] / 0.0007);
    cells.set(k, (cells.get(k) || 0) + 1);
  }
  let dup = 0;
  cells.forEach((v) => { if (v > 1) dup += v - 1; });
  return kept.length ? dup / kept.length : 0;
}

// Score d'une boucle : pénalise l'écart de distance ET le retour sur ses pas.
function score(routed, target) {
  return Math.abs(routed.distance - target) / target + routed.retrace * 1.6;
}

// Génère une boucle en deux temps :
//  1) calibre le rayon de l'anneau sur la distance RÉELLE mesurée (en montagne les
//     sentiers serpentent : la longueur vaut 3-4× le périmètre géométrique, un rayon
//     fixe est donc inutilisable — on ajuste sur ce que BRouter renvoie) ;
//  2) essaie quelques orientations et garde la MOINS « aller-retour ».
async function generateLoop() {
  const start = loops.start;
  const target = loops.targetKm;
  const nodes = await ensureNodes(start, target);
  const n = target < 10 ? 4 : 5;
  const anchor = [start.lat, start.lon];
  const routeAt = (rKm, angle) =>
    brouterLoop([anchor, ...snapWaypoints(ringWaypoints(start, rKm, n, angle), nodes), anchor]);

  // Phase 1 — calibration distance (≤ 2 appels)
  let r = target / 7;
  let base = null;
  for (let i = 0; i < 2; i++) {
    try { base = await routeAt(r, loops.baseAngle); } catch { break; }
    const ratio = base.distance / target;
    if (ratio >= 0.8 && ratio <= 1.2) break;
    r = Math.max(0.3, Math.min(r * (target / base.distance), target / 3));
  }
  const candidates = base ? [base] : [];

  // Phase 2 — deux autres orientations au rayon calibré (nœuds déjà en cache)
  for (const a of [loops.baseAngle + (2 * Math.PI) / 3, loops.baseAngle + (4 * Math.PI) / 3]) {
    try { candidates.push(await routeAt(r, a)); } catch { /* candidat perdu */ }
  }
  if (!candidates.length) throw new Error("Aucune boucle routable depuis ce départ.");

  // Parmi les candidats dans la tolérance de distance, on prend le moins retracé.
  const inTol = candidates.filter((c) => Math.abs(c.distance - target) / target <= 0.25);
  const pool = inTol.length ? inTol : candidates;
  pool.sort((a, b) => a.retrace - b.retrace || score(a, target) - score(b, target));
  return pool[0];
}

// ---------- Métriques ----------
function computeGain(eles) {
  let gain = 0, ref = eles[0];
  for (const e of eles) {
    if (e - ref > 4) { gain += e - ref; ref = e; }
    else if (ref - e > 4) ref = e;
  }
  return Math.round(gain);
}

function naismithHours(distKm, gainM) {
  return distKm / 4.5 + gainM / 600; // Naismith/Tobler : ~4,5 km/h + 600 m/h de montée
}

function fmtDuration(h) {
  if (h < 9) return `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
  return `${Math.round(h / 7)} j (est.)`;
}

// ---------- Rendu carte ----------
function drawStart() {
  if (loops.startMarker) loops.startMarker.remove();
  if (!loops.start) return;
  loops.startMarker = L.circleMarker([loops.start.lat, loops.start.lon], {
    radius: 8, color: "#fff", weight: 2.5, fillColor: "#ff2d20", fillOpacity: 1,
  }).addTo(loops.layer).bindTooltip("Départ", { direction: "top", offset: [0, -8] });
}

function drawGhost(on) {
  if (loops.ghost) { loops.ghost.remove(); loops.ghost = null; }
  if (on && loops.start) {
    loops.ghost = L.circle([loops.start.lat, loops.start.lon], {
      radius: (loops.targetKm / 6) * 1000, color: "#ff2d20", weight: 1.5,
      dashArray: "6 8", fill: false, opacity: 0.6,
    }).addTo(loops.layer);
  }
}

function drawLoop(routed) {
  loops.layer.clearLayers();
  loops.startMarker = null;
  const line = L.polyline(routed.track, { color: "#ff2d20", weight: 4, opacity: 0.95 }).addTo(loops.layer);
  drawStart();
  // Cadre la boucle à l'écart de la barre (à gauche sur desktop, en bas sur mobile),
  // pour qu'elle reste toujours visible.
  const bar = document.getElementById("loops-bar");
  const mobile = window.innerWidth < 700;
  map.fitBounds(line.getBounds(), mobile
    ? { paddingTopLeft: [30, 90], paddingBottomRight: [30, (bar?.offsetHeight || 0) + 30], maxZoom: 15 }
    : { paddingTopLeft: [(bar?.offsetWidth || 360) + 40, 40], paddingBottomRight: [50, 50], maxZoom: 15 });
}

// ---------- UI ----------
function el(id) { return document.getElementById(id); }

function renderStartLabel() {
  const s = el("loops-start");
  s.textContent = loops.start
    ? `Départ : ${loops.start.lat.toFixed(4)}, ${loops.start.lon.toFixed(4)}`
    : "Cliquez votre point de départ sur la carte, ou ⌖ ma position";
  s.classList.toggle("muted", !loops.start);
}

function renderResult() {
  const box = el("loops-result");
  const r = loops.routed;
  if (!r) { box.classList.add("hidden"); return; }
  const gain = r.eles ? computeGain(r.eles) : null;
  const altMax = r.eles ? Math.round(Math.max(...r.eles)) : null;
  const dist = Math.round(r.distance * 10) / 10;
  const hours = naismithHours(dist, gain || 0);
  const fr = (v) => v.toLocaleString("fr-FR");
  el("loops-metrics").innerHTML =
    `<div class="loops-metric big"><span>${fr(dist)}</span><label>km de marche</label></div>` +
    `<div class="loops-metric big"><span>${altMax != null ? fr(altMax) : "—"}</span><label>altitude max</label></div>` +
    `<div class="loops-metric"><span>${gain != null ? fr(gain) : "—"}</span><label>m D+ (indic.)</label></div>` +
    `<div class="loops-metric"><span>${fmtDuration(hours)}</span><label>durée estimée</label></div>`;
  box.classList.remove("hidden");
}

function setBusy(on, msg) {
  loops.busy = on;
  el("loops-generate").disabled = on;
  el("loops-generate").textContent = on ? "⏳ routage…" : "Génère";
  ["loops-another", "loops-save"].forEach((id) => { const b = el(id); if (b) b.disabled = on; });
  const status = el("loops-status");
  status.textContent = msg || "";
  status.classList.toggle("hidden", !msg);
}

async function runGeneration() {
  if (loops.busy) return;
  if (!loops.start) { alert("Choisissez d'abord un point de départ (clic sur la carte ou ⌖ ma position)."); return; }
  const target = Number(el("loops-target").value);
  if (!(target >= 2)) { alert("Indiquez une distance de marche (au moins 2 km)."); return; }
  loops.targetKm = target;
  setBusy(true, "Lecture des sentiers puis tracé de la boucle…");
  drawGhost(true);
  try {
    const routed = await generateLoop();
    loops.routed = routed;
    drawGhost(false);
    drawLoop(routed);
    renderResult();
    const ratio = routed.distance / target;
    const notes = [];
    if (ratio < 0.8 || ratio > 1.2) notes.push(`distance ${routed.distance.toFixed(1)} km`);
    if (routed.retrace > 0.3) notes.push("quelques allers-retours (sentiers clairsemés ici)");
    setBusy(false, notes.length ? "⚠ " + notes.join(" · ") : "");
  } catch (e) {
    drawGhost(false);
    loops.routed = null;
    renderResult();
    setBusy(false, "Aucune boucle trouvée ici (BRouter/sentiers). Réessayez ou déplacez le départ.");
  }
}

export function setStart(latlng) {
  loops.start = { lat: latlng.lat, lon: latlng.lng };
  loops.baseAngle = Math.random() * Math.PI * 2;
  loops.routed = null;
  loops.nodes = null;
  loops.nodesKey = null;
  loops.layer.clearLayers();
  loops.startMarker = null;
  drawStart();
  drawGhost(true);
  renderStartLabel();
  renderResult();
}

function saveLoop() {
  const r = loops.routed;
  if (!r) return;
  const gain = r.eles ? computeGain(r.eles) : null;
  const altMax = r.eles ? Math.round(Math.max(...r.eles)) : null;
  const dist = Math.round(r.distance * 10) / 10;
  const hours = naismithHours(dist, gain || 0);
  const track = r.track;
  const trail = {
    id: `boucle-${Date.now()}`,
    imported: true,
    custom: true,
    eles: r.eles && r.eles.length === track.length ? r.eles.map((e) => Math.round(e)) : undefined,
    name: `Boucle ${dist} km — ${new Date().toLocaleDateString("fr-FR")}`,
    location: "Boucle générée",
    region: "Mes boucles",
    difficulty: "personnalisé",
    type: "boucle",
    days: null,
    bivouac: false,
    distance: dist,
    elevationGain: gain,
    altMax,
    duration: fmtDuration(hours),
    center: track[Math.floor(track.length / 2)],
    gradient: "linear-gradient(135deg, #3a3a40, #6a6a72)",
    description:
      `Boucle générée le ${new Date().toLocaleDateString("fr-FR")}, ${dist} km` +
      (gain != null ? ` · ${gain} m D+` : "") +
      `, aimantée sur les sentiers (BRouter, profil rando-montagne).`,
    eau: "—",
    bivouacSpot: "—",
    periode: "—",
    track,
    segments: [track],
  };
  state.imported.unshift(trail);
  saveTraces(state.imported);
  addMarker(trail);
  exitLoops();
  renderAll();
  selectTrail(trail.id);
}

function exitLoops() {
  loops.active = false;
  loops.start = null;
  loops.routed = null;
  loops.busy = false;
  loops.startMarker = null;
  loops.ghost = null;
  loops.nodes = null;
  loops.nodesKey = null;
  loops.layer.clearLayers();
  loops.layer.remove();
  document.body.classList.remove("loops-active");
  el("loops-bar").classList.add("hidden");
  el("btn-loops").classList.remove("active");
}

export function initLoops() {
  el("btn-loops").addEventListener("click", () => {
    if (loops.active) { exitLoops(); return; }
    closeDetail();
    loops.active = true;
    document.body.classList.add("loops-active"); // masque les résultats : la carte reste visible
    loops.layer.addTo(map);
    el("loops-bar").classList.remove("hidden");
    el("btn-loops").classList.add("active");
    renderStartLabel();
    renderResult();
    setBusy(false, "");
  });

  el("loops-target").addEventListener("input", (e) => {
    loops.targetKm = e.target.value ? Number(e.target.value) : loops.targetKm;
    if (loops.active && !loops.busy && !loops.routed) drawGhost(true);
  });

  el("loops-generate").addEventListener("click", runGeneration);

  el("loops-another").addEventListener("click", () => {
    loops.baseAngle += (2 * Math.PI) / 5; // rotation de l'anneau : autre variante
    runGeneration();
  });

  el("loops-save").addEventListener("click", saveLoop);
  el("loops-cancel").addEventListener("click", exitLoops);
}

export { loops };
