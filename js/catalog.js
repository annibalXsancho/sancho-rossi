// Sancho Rossi — randos balisées chargées À LA DEMANDE (refonte : bouton + filtre qualité)
// Refonte du S3 : le chargement AUTOMATIQUE au déplacement de carte est supprimé — il
// noyait la carte sous des centaines de marqueurs OSM, dont la plupart n'étaient que des
// tronçons/fragments de sentiers, pas des itinéraires exploitables. Désormais la carte est
// propre par défaut et un bouton « Charger les randos » interroge Overpass sur la zone
// VISIBLE, en ne gardant que les VRAIES randos : nommées, rattachées à un balisage officiel,
// de longueur plausible (3–80 km) et à géométrie CONTINUE (pas des bouts disjoints).
// Le cache IndexedDB par cellule est conservé (revisiter une zone = zéro appel réseau).
import { state, catalogTrails, normalizeOsmTrail, trackDistanceKm } from "./state.js";
import { overpassFetch } from "./api.js";
import { map, addMarker, mapZoom, boundsContain } from "./map.js";
import { renderLists } from "./trails.js";
import { loadCatalog, loadZoneKeys, markZone, putCatalogTrails } from "./storage.js";

const CELL = 0.25;               // ~25 km : taille de la cellule de cache
const MIN_ZOOM = 10;             // en dessous, la zone est trop large pour charger
const MAX_CELLS = 12;            // garde-fou anti-batch géant

const fetchedZones = new Set();  // cellules déjà interrogées (clé "i_j"), depuis le cache
const inFlight = new Set();      // cellules en cours de requête
const cached = new Map();        // randos persistées (id → trail) — réaffichables sans réseau

let busy = false;

const cellKey = (lat, lon) => `${Math.floor(lat / CELL)}_${Math.floor(lon / CELL)}`;

function btnEl() {
  return document.getElementById("btn-load-trails");
}
function statusEl() {
  return document.getElementById("osm-results");
}
function setStatus(html) {
  const el = statusEl();
  if (el) el.innerHTML = html ? `<div class="osm-head">${html}</div>` : "";
}

// ---------- Filtre « vraie rando complète et vérifiée » ----------
// Réseaux de marche curatés (waymarked) : international / national / régional / local.
const WALK_NETWORKS = new Set(["iwn", "nwn", "rwn", "lwn"]);

function isQualityRoute(rel, trail) {
  const tags = rel.tags || {};
  // 1. Nommée : les relations anonymes sont des tronçons techniques / non vérifiés.
  if (!tags.name) return false;
  // 2. Rattachée à un balisage officiel : réseau de marche, n° d'itinéraire, symbole de
  //    balisage ou cotation SAC — au moins un signal de curation communautaire.
  const curated =
    WALK_NETWORKS.has(tags.network) ||
    tags.ref ||
    tags["osmc:symbol"] ||
    tags.sac_scale;
  if (!curated) return false;
  // 3. Longueur plausible d'une rando : ni fragment (< 3 km), ni méga-GR (> 80 km) qui
  //    déborde largement la zone affichée et n'est pas une « rando du jour ».
  if (trail.distance < 3 || trail.distance > 80) return false;
  // 4. Géométrie CONTINUE : une relation faite de variantes disjointes ou tronquée chaîne
  //    en plusieurs morceaux → sa ligne principale ne couvre qu'une fraction des points.
  //    C'est exactement le « ce ne sont que des parties de sentiers » à écarter.
  const total = trail.track.length;
  const main = (trail.mainline || trail.track).length;
  if (total > 0 && main / total < 0.75) return false;
  return true;
}

// Relation OSM Overpass → objet tracé de l'app (géométrie chaînée).
function parseRelation(rel) {
  const segments = (rel.members || [])
    .filter((m) => m.type === "way" && m.geometry)
    .map((m) => m.geometry.map((g) => [g.lat, g.lon]));
  const track = segments.flat();
  if (track.length < 2) return null;
  const tags = rel.tags || {};
  const parts = [tags.from && `de ${tags.from}`, tags.to && `à ${tags.to}`].filter(Boolean).join(" ");
  return normalizeOsmTrail({
    id: `osm-${rel.id}`,
    osm: true,
    name: tags.name || tags.ref || `Sentier OSM ${rel.id}`,
    location: parts || "Itinéraire balisé OpenStreetMap",
    region: "Sentiers OSM",
    difficulty: tags.sac_scale ? tags.sac_scale.replace(/_/g, " ") : "non renseignée",
    type: "balisé",
    days: null,
    bivouac: false,
    distance: Math.round(trackDistanceKm(track) * 10) / 10,
    elevationGain: null,
    altMax: null,
    duration: "—",
    center: track[Math.floor(track.length / 2)],
    gradient: "linear-gradient(135deg, #4a5d8a, #8fa3cc)",
    description:
      `Itinéraire balisé issu d'OpenStreetMap${tags.ref ? ` (réf. ${tags.ref})` : ""}` +
      `${tags.network ? `, réseau ${tags.network}` : ""}. Tracé réel relevé par la communauté — exportable en GPX.`,
    eau: "—",
    bivouacSpot: "—",
    periode: "—",
    track,
    segments,
  });
}

// Cellules 0,25° intersectant la vue courante.
function visibleCells() {
  const b = map.getBounds();
  const i0 = Math.floor(b.getSouth() / CELL), i1 = Math.floor(b.getNorth() / CELL);
  const j0 = Math.floor(b.getWest() / CELL), j1 = Math.floor(b.getEast() / CELL);
  const cells = [];
  for (let i = i0; i <= i1; i++)
    for (let j = j0; j <= j1; j++) cells.push({ i, j, key: `${i}_${j}` });
  return cells;
}

function cellBbox({ i, j }) {
  const south = i * CELL, west = j * CELL;
  return `${south},${west},${south + CELL},${west + CELL}`;
}

// Nombre de randos actuellement affichées dont le centre est visible (compteur d'état).
function countInView() {
  const b = map.getBounds();
  return catalogTrails().filter((t) => boundsContain(b, t.center)).length;
}

// Interroge une cellule, filtre les vraies randos, persiste et affiche les nouvelles.
async function loadCell(cell) {
  inFlight.add(cell.key);
  try {
    const query = `[out:json][timeout:25];relation["route"="hiking"](${cellBbox(cell)});out geom 120;`;
    const data = await overpassFetch(query);
    const fresh = [];
    for (const rel of data.elements || []) {
      const t = parseRelation(rel);
      if (!t || state.catalog.has(t.id) || !isQualityRoute(rel, t)) continue;
      state.catalog.set(t.id, t);
      cached.set(t.id, t);
      addMarker(t);
      fresh.push(t);
    }
    if (fresh.length) putCatalogTrails(fresh);
    fetchedZones.add(cell.key);
    markZone(cell.key);
    return true;
  } catch {
    return false; // cellule non marquée : re-tentée au prochain clic
  } finally {
    inFlight.delete(cell.key);
  }
}

// Réaffiche sans réseau les randos déjà chargées (filtrées, en cache) visibles dans la vue.
function showCachedInView() {
  const b = map.getBounds();
  let n = 0;
  for (const [id, t] of cached) {
    if (state.catalog.has(id) || !boundsContain(b, t.center)) continue;
    state.catalog.set(id, t);
    addMarker(t);
    n++;
  }
  return n;
}

// ---------- Action du bouton « Charger les randos » ----------
async function loadZoneOnDemand() {
  if (busy) return;
  if (mapZoom() < MIN_ZOOM) {
    setStatus("Zoomez sur un massif pour charger ses randos balisées.");
    return;
  }
  const cells = visibleCells();
  if (cells.length > MAX_CELLS) {
    setStatus("Zone trop large — zoomez pour charger les randos.");
    return;
  }

  busy = true;
  const btn = btnEl();
  if (btn) { btn.classList.add("active"); btn.disabled = true; }

  // 1. Cache : réaffiche instantanément les randos déjà chargées, sans réseau.
  showCachedInView();
  renderLists();

  // 2. Réseau : cellules jamais interrogées.
  const missing = cells.filter((c) => !fetchedZones.has(c.key) && !inFlight.has(c.key));
  let netOk = true;
  if (missing.length) {
    setStatus("⏳ Chargement des randos de la zone…");
    for (const cell of missing) netOk = (await loadCell(cell)) && netOk;
    renderLists();
  }

  const n = countInView();
  if (!netOk) {
    setStatus(n
      ? `${n} rando${n > 1 ? "s" : ""} — chargement partiel, réessayez.`
      : "Chargement impossible — réessayez dans quelques secondes.");
  } else {
    setStatus(n
      ? `${n} rando${n > 1 ? "s" : ""} balisée${n > 1 ? "s" : ""} vérifiée${n > 1 ? "s" : ""} dans la zone.`
      : "Aucune rando balisée vérifiée dans cette zone.");
  }

  busy = false;
  if (btn) { btn.classList.remove("active"); btn.disabled = false; }
}

// Ré-hydrate le cache persisté au boot SANS rien poser sur la carte : la carte reste propre
// et les randos ne réapparaissent qu'au clic du bouton (depuis ce cache, sans réseau).
export async function hydrateCatalog() {
  try {
    const [keys, trails] = await Promise.all([loadZoneKeys(), loadCatalog()]);
    keys.forEach((k) => fetchedZones.add(k));
    trails.forEach((t) => cached.set(t.id, t));
  } catch {
    /* IndexedDB indisponible : le cache restera vide jusqu'au prochain chargement */
  }
}

export function initCatalog() {
  btnEl()?.addEventListener("click", loadZoneOnDemand);
}
