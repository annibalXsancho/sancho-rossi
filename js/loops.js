// Sancho Rossi — générateur de boucles à la demande (rando clef en main)
// Départ + distance cible → anneau de waypoints routé en boucle par BRouter
// (profile=hiking-mountain, suit les sentiers, altitudes en 3ᵉ coord). Distance
// visée pour de vrai (itérations de rayon) ; altitude / D+ / durée affichés tels
// que mesurés — indicatifs, on ne cale pas la rando dessus.
import { haversineKm } from "./state.js";
import { map, addMarker } from "./map.js";
import { renderAll, selectTrail } from "./trails.js";
import { closeDetail } from "./detail.js";
import { saveTraces } from "./storage.js";
import { state } from "./state.js";

export const loops = {
  active: false,
  start: null,        // { lat, lon }
  targetKm: 12,
  baseAngle: 0,       // orientation de l'anneau (tournée par « Autre proposition »)
  busy: false,
  routed: null,       // dernière boucle générée { track, eles, distance }
  layer: L.layerGroup(),
  startMarker: null,
  ghost: null,        // anneau pointillé fantôme pendant le routage
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
    // Légère variation de rayon (déterministe) pour une forme moins mécanique
    const jitter = 0.9 + 0.2 * (0.5 + 0.5 * Math.sin(i * 2.4 + baseAngle));
    pts.push(offsetKm(start.lat, start.lon, rKm * jitter, ang));
  }
  return pts;
}

// ---------- Routage BRouter (boucle en un seul appel) ----------
async function brouterLoop(waypoints) {
  const lonlats = waypoints.map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join("|");
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
  return { track, eles, distance };
}

// Génère une boucle en visant la distance. Le premier essai (rayon D/6) tombe le plus
// souvent dans ±20 % ; sinon UNE passe de rescale. Volontairement borné à 2 appels
// BRouter (serveur partagé, il faut rester « en quelques secondes » et ne pas le marteler).
async function generateLoop() {
  const start = loops.start;
  const target = loops.targetKm;
  const n = target < 8 ? 3 : target < 20 ? 4 : 5;
  let r = target / 6;
  let best = null;
  for (let iter = 0; iter < 2; iter++) {
    const wps = ringWaypoints(start, r, n, loops.baseAngle);
    const loop = [[start.lat, start.lon], ...wps, [start.lat, start.lon]];
    best = await brouterLoop(loop);
    const ratio = best.distance / target;
    if (ratio >= 0.8 && ratio <= 1.2) break; // dans ±20 % : bon
    r = Math.max(0.25, Math.min(r * (target / best.distance), target)); // rescale borné
  }
  return best;
}

// ---------- Métriques ----------
function computeGain(eles) {
  let gain = 0;
  let ref = eles[0];
  for (const e of eles) {
    if (e - ref > 4) { gain += e - ref; ref = e; }  // seuil 4 m : lisse le bruit
    else if (ref - e > 4) ref = e;
  }
  return Math.round(gain);
}

// Naismith/Tobler : ~4,5 km/h à plat + 600 m de montée à l'heure.
function naismithHours(distKm, gainM) {
  return distKm / 4.5 + gainM / 600;
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
  }).addTo(loops.layer);
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
  loops.layer.clearLayers();           // repart propre (évite le fantôme résiduel)
  loops.startMarker = null;
  const line = L.polyline(routed.track, { color: "#ff2d20", weight: 4, opacity: 0.95 }).addTo(loops.layer);
  drawStart();
  map.fitBounds(line.getBounds(), { padding: [50, 50], maxZoom: 15 });
}

// ---------- UI ----------
function el(id) { return document.getElementById(id); }

function renderStartLabel() {
  const s = el("loops-start");
  s.textContent = loops.start
    ? `Départ : ${loops.start.lat.toFixed(4)}, ${loops.start.lon.toFixed(4)}`
    : "Cliquez le départ sur la carte, ou ⌖ ma position";
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
  setBusy(true, "Tracé de la boucle sur les sentiers…");
  drawGhost(true);
  try {
    const routed = await generateLoop();
    loops.routed = routed;
    drawGhost(false);
    drawLoop(routed);
    renderResult();
    const ratio = routed.distance / target;
    setBusy(false, ratio < 0.8 || ratio > 1.2
      ? `Distance obtenue ${routed.distance.toFixed(1)} km (sentiers limités près du départ).`
      : "");
  } catch (e) {
    drawGhost(false);
    loops.routed = null;
    renderResult();
    setBusy(false, "Routage indisponible (BRouter). Réessayez ou déplacez le départ.");
  }
}

export function setStart(latlng) {
  loops.start = { lat: latlng.lat, lon: latlng.lng };
  loops.baseAngle = Math.random() * Math.PI * 2; // orientation de départ variée
  loops.routed = null;
  loops.layer.clearLayers();
  loops.startMarker = null;
  drawStart();
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
      `, suivant les sentiers (BRouter, profil rando-montagne).`,
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
  loops.layer.clearLayers();
  loops.layer.remove();
  el("loops-bar").classList.add("hidden");
  el("btn-loops").classList.remove("active");
}

export function initLoops() {
  el("btn-loops").addEventListener("click", () => {
    if (loops.active) { exitLoops(); return; }
    closeDetail();
    loops.active = true;
    loops.layer.addTo(map);
    el("loops-bar").classList.remove("hidden");
    el("btn-loops").classList.add("active");
    renderStartLabel();
    renderResult();
    setBusy(false, "");
  });

  el("loops-target").addEventListener("input", (e) => {
    loops.targetKm = e.target.value ? Number(e.target.value) : loops.targetKm;
    if (loops.active && !loops.busy) drawGhost(!loops.routed);
  });

  el("loops-generate").addEventListener("click", runGeneration);

  el("loops-another").addEventListener("click", () => {
    loops.baseAngle += (2 * Math.PI) / 5; // rotation de l'anneau : autre variante
    runGeneration();
  });

  el("loops-save").addEventListener("click", saveLoop);
  el("loops-cancel").addEventListener("click", exitLoops);
}
