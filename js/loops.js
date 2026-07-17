// Sancho Rossi — générateur de boucles à la demande (rando clef en main)
// Départ = ancre de l'utilisateur (village / route / là où est laissée la moto) et
// point SUR la boucle, jamais le centre : la boucle S'OUVRE dans une direction puis
// revient au départ (pas d'encerclement ni d'aller-retour radial). On charge le réseau
// de sentiers autour du départ (Overpass), on AIMANTE les waypoints sur de vrais nœuds,
// puis on route en boucle par BRouter (hiking-mountain, altitudes en 3ᵉ coord). On
// génère plusieurs DIRECTIONS et on garde celle qui retrace le moins en visant la distance.
import { haversineKm, state } from "./state.js";
import { map, addMarker } from "./map.js";
import { renderAll, selectTrail } from "./trails.js";
import { closeDetail } from "./detail.js";
import { saveTraces } from "./storage.js";
import { brouterRoute } from "./brouter.js";
import { computeGain, naismithHours, fmtDuration } from "./metrics.js";
import { fetchRetry } from "./net.js";
import { toast } from "./toast.js";

const loops = {
  active: false,
  start: null,        // { lat, lon } — l'ancre exacte, jamais déplacée
  targetKm: 12,
  baseAngle: 0,       // orientation de l'anneau (tournée par « Autre proposition »)
  busy: false,
  routed: null,       // dernière boucle retenue { track, eles, distance, retrace }
  nodes: null,        // nœuds de sentier autour du départ (cache Overpass)
  nodesKey: null,
  nodesPromise: null, // chargement en cours/terminé (préchauffé dès le ping)
  layer: L.layerGroup(),
  startMarker: null,
  ghost: null,
};

// ---------- Géométrie de la boucle ----------
function offsetKm(lat, lon, rKm, angleRad) {
  const dLat = (rKm / 111.32) * Math.cos(angleRad);
  const dLon = (rKm / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(angleRad);
  return [lat + dLat, lon + dLon];
}

// Le départ est un point SUR la boucle, pas le centre. On place le centre de l'anneau à
// une distance rKm dans la direction `heading` : le départ tombe alors sur le bord proche
// du cercle. On répartit n waypoints sur le RESTE du cercle (créneau du départ laissé
// libre) → la route départ→w1→…→wn→départ trace le tour en s'éloignant dans `heading`
// puis revient, sans rayon aller-retour. Changer `heading` = boucle dans une autre direction.
function loopWaypoints(start, rKm, n, heading) {
  const [cLat, cLon] = offsetKm(start.lat, start.lon, rKm, heading);
  const back = heading + Math.PI; // relèvement centre → départ
  const step = (2 * Math.PI) / (n + 1); // n waypoints + le créneau libre du départ
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const ang = back + i * step;
    const jitter = 0.9 + 0.2 * (0.5 + 0.5 * Math.sin(i * 2.4 + heading));
    pts.push(offsetKm(cLat, cLon, rKm * jitter, ang));
  }
  return pts;
}

// ---------- Réseau de sentiers (Overpass) : nœuds sur lesquels aimanter ----------
// On COURSE les deux miroirs Overpass (le plus rapide gagne) avec un plafond de 12 s :
// overpass-api.de est souvent lent/429, kumi plus fiable — attendre l'un puis l'autre en
// série faisait « pendre » la génération ~40 s (cause du ressenti « ça bug »).
function raceOverpass(q) {
  const hit = async (url) => {
    const res = await fetchRetry(url, {
      method: "POST",
      body: "data=" + encodeURIComponent(q),
      timeout: 12000,
      retries: 1,
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const nodes = [];
    for (const el of data.elements || []) {
      if (el.geometry) for (const g of el.geometry) nodes.push([g.lat, g.lon]);
    }
    if (!nodes.length) throw new Error("empty");
    return nodes;
  };
  return Promise.any([
    hit("https://overpass.kumi.systems/api/interpreter"),
    hit("https://overpass-api.de/api/interpreter"),
  ]);
}

// Lance (ou réutilise) le chargement des nœuds de sentier autour du départ. Appelé dès
// le ping (préchauffage) : les sentiers sont ainsi prêts quand l'utilisateur clique Génère.
// En cas d'échec on résout à [] (repli sur l'anneau géométrique), sans jamais bloquer.
function startNodes(start, target) {
  const key = `${start.lat.toFixed(3)},${start.lon.toFixed(3)}/${Math.round(target)}`;
  if (loops.nodesKey === key && loops.nodesPromise) return loops.nodesPromise;
  loops.nodesKey = key;
  // La boucle est décalée dans une direction : son bord lointain atteint ~2·r depuis le
  // départ. On élargit donc le rayon de lecture pour couvrir la moitié éloignée.
  const radiusM = Math.round(Math.max(target / 6 * 2.2, 1.5) * 1000);
  const q =
    `[out:json][timeout:20];` +
    `way["highway"~"^(path|track|footway|bridleway|steps|cycleway)$"]` +
    `(around:${radiusM},${start.lat},${start.lon});out geom;`;
  loops.nodesPromise = raceOverpass(q)
    .then((nodes) => { loops.nodes = nodes; return nodes; })
    .catch(() => { loops.nodes = []; return []; });
  return loops.nodesPromise;
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
// Le client est mutualisé (js/brouter.js). Deux garde-fous restent SPÉCIFIQUES à la
// boucle et ne remontent pas dans le module commun : au moins 3 points de passage
// (une boucle n'est pas un A→B) et le rejet des boucles dégénérées (< 4 points de
// tracé), qui trahissent un anneau écrasé plutôt qu'un vrai tour.
async function brouterLoop(waypoints) {
  if (waypoints.filter((p, i) => i === 0 || haversineKm(p, waypoints[i - 1]) > 0.03).length < 3) {
    throw new Error("waypoints insuffisants");
  }
  const r = await brouterRoute(waypoints, { timeout: 15000 });
  if (r.track.length < 4) throw new Error("BRouter : boucle dégénérée");
  return { ...r, retrace: retraceFraction(r.track) };
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

// Génère une boucle qui part du départ (l'ancre), fait ~la distance demandée et y
// revient, en minimisant l'aller-retour :
//  1) un appel de calibration cale le rayon de l'anneau sur la longueur RÉELLE (en
//     montagne les sentiers serpentent, et le facteur varie — on ajuste sur BRouter) ;
//  2) plusieurs orientations sont routées EN PARALLÈLE (rapide) et on garde celle qui
//     revient le plus proprement au point de départ (le moins retracée).
async function generateLoop() {
  const start = loops.start;
  const target = loops.targetKm;
  const nodes = await startNodes(start, target); // préchauffé au ping : souvent déjà prêt
  const n = target < 10 ? 4 : 5;
  const anchor = [start.lat, start.lon];
  const routeAt = async (rKm, angle) => {
    try { return await brouterLoop([anchor, ...snapWaypoints(loopWaypoints(start, rKm, n, angle), nodes), anchor]); }
    catch { return null; } // candidat perdu (BRouter lent/429) : ignoré
  };

  // 1) Calibration du rayon sur la distance réelle mesurée.
  let r = target / 8;
  const base = await routeAt(r, loops.baseAngle);
  if (base) r = Math.max(0.3, Math.min(r * (target / base.distance), target / 2.5));

  // 2) Quatre directions de sortie en parallèle au rayon calibré.
  const offs = [0, (2 * Math.PI) / 5, (4 * Math.PI) / 5, (6 * Math.PI) / 5];
  const batch = await Promise.all(offs.map((o) => routeAt(r, loops.baseAngle + o)));
  const candidates = [base, ...batch].filter(Boolean);
  if (!candidates.length) throw new Error("Aucune boucle routable depuis ce départ.");

  // Parmi les candidats dans la tolérance de distance, on prend le moins « aller-retour ».
  const inTol = candidates.filter((c) => Math.abs(c.distance - target) / target <= 0.25);
  const pool = inTol.length ? inTol : candidates;
  pool.sort((a, b) => a.retrace - b.retrace || score(a, target) - score(b, target));
  return pool[0];
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
    // Anneau fantôme DÉCALÉ dans la direction de sortie : il effleure le départ et bombe
    // dans le sens où partira la boucle (aperçu de la forme réelle, plus un cercle centré).
    const rKm = loops.targetKm / 6.28;
    const [cLat, cLon] = offsetKm(loops.start.lat, loops.start.lon, rKm, loops.baseAngle);
    loops.ghost = L.circle([cLat, cLon], {
      radius: rKm * 1000, color: "#ff2d20", weight: 1.5,
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
  if (!loops.start) { toast("Choisissez d'abord un point de départ (clic sur la carte ou ⌖ ma position).", { type: "error" }); return; }
  const target = Number(el("loops-target").value);
  if (!(target >= 2)) { toast("Indiquez une distance de marche (au moins 2 km).", { type: "error" }); return; }
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
  loops.nodesPromise = null;
  loops.layer.clearLayers();
  loops.startMarker = null;
  drawStart();
  drawGhost(true);
  renderStartLabel();
  renderResult();
  // Préchauffage : on charge les sentiers tout de suite (le plus souvent prêts quand
  // l'utilisateur clique « Génère »), sans bloquer.
  startNodes(loops.start, Number(el("loops-target")?.value) || loops.targetKm);
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
  loops.nodesPromise = null;
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
