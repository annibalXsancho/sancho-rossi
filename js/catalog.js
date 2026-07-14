// Sancho Rossi — catalogue de tracés balisés chargé à la demande (S3)
// Les relations "route=hiking" de la zone visible sont interrogées via Overpass au
// déplacement de la carte, mises en cache dans IndexedDB par cellule de zone (0,25°) et
// dédupliquées par id de relation OSM. Une zone déjà visitée ne rappelle jamais le réseau.
import { state, catalogTrails, normalizeOsmTrail, trackDistanceKm } from "./state.js";
import { overpassFetch } from "./api.js";
import { map, addMarker } from "./map.js";
import { renderAll } from "./trails.js";
import { loadCatalog, loadZoneKeys, markZone, putCatalogTrails } from "./storage.js";

const CELL = 0.25;               // ~25 km : taille de la cellule de cache
const MIN_ZOOM = 10;             // en dessous, la zone est trop large pour charger
const MAX_CELLS = 12;            // garde-fou anti-batch géant
const DEBOUNCE_MS = 800;

const fetchedZones = new Set();  // cellules déjà interrogées (clé "i_j")
const inFlight = new Set();      // cellules en cours de requête

const cellKey = (lat, lon) => `${Math.floor(lat / CELL)}_${Math.floor(lon / CELL)}`;

function statusEl() {
  return document.getElementById("osm-results");
}
function setStatus(html) {
  const el = statusEl();
  if (el) el.innerHTML = html ? `<div class="osm-head">${html}</div>` : "";
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

// Nombre de tracés du catalogue dont le centre est visible (compteur d'état).
function countInView() {
  const b = map.getBounds();
  return catalogTrails().filter((t) => b.contains(t.center)).length;
}

// Interroge une cellule, persiste et fusionne les nouveaux tracés.
async function loadCell(cell) {
  inFlight.add(cell.key);
  try {
    const query = `[out:json][timeout:25];relation["route"="hiking"](${cellBbox(cell)});out geom 60;`;
    const data = await overpassFetch(query);
    const fresh = [];
    for (const rel of data.elements || []) {
      const t = parseRelation(rel);
      if (!t || state.catalog.has(t.id)) continue;
      state.catalog.set(t.id, t);
      addMarker(t);
      fresh.push(t);
    }
    if (fresh.length) putCatalogTrails(fresh);
    fetchedZones.add(cell.key);
    markZone(cell.key);
    return true;
  } catch {
    return false; // cellule non marquée : re-tentée au prochain passage
  } finally {
    inFlight.delete(cell.key);
  }
}

let moveTimer;
async function loadVisibleZones() {
  if (map.getZoom() < MIN_ZOOM) {
    setStatus("Zoomez sur un massif pour charger les sentiers balisés de la zone.");
    return;
  }
  const cells = visibleCells();
  if (cells.length > MAX_CELLS) return;
  const missing = cells.filter((c) => !fetchedZones.has(c.key) && !inFlight.has(c.key));
  if (!missing.length) {
    const n = countInView();
    setStatus(n ? `${n} sentier${n > 1 ? "s" : ""} balisé${n > 1 ? "s" : ""} dans la zone.` : "");
    return;
  }
  setStatus("⏳ Chargement des sentiers de la zone…");
  let ok = false;
  for (const cell of missing) ok = (await loadCell(cell)) || ok;
  renderAll();
  if (ok) {
    const n = countInView();
    setStatus(n ? `${n} sentier${n > 1 ? "s" : ""} balisé${n > 1 ? "s" : ""} dans la zone.` : "Aucun sentier balisé dans cette zone.");
  } else {
    setStatus("Chargement impossible — réessayez dans quelques secondes.");
  }
}

// Ré-hydrate le catalogue persisté (zones visitées + tracés) au boot, sans réseau.
export async function hydrateCatalog() {
  try {
    const [keys, trails] = await Promise.all([loadZoneKeys(), loadCatalog()]);
    keys.forEach((k) => fetchedZones.add(k));
    trails.forEach((t) => {
      state.catalog.set(t.id, t);
      addMarker(t);
    });
  } catch {
    /* IndexedDB indisponible : le catalogue restera vide jusqu'au prochain chargement */
  }
}

export function initCatalog() {
  map.on("moveend", () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(loadVisibleZones, DEBOUNCE_MS);
  });
  // Cas où l'app démarre déjà zoomée sur une zone.
  loadVisibleZones();
}
