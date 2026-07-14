// Sancho Rossi — packs offline « pour le terrain » (S5)
// Télécharge, autour d'une rando enregistrée, un corridor de tuiles carto (z12–15,
// tous calques utiles), les POI eau/refuges/secours et un snapshot météo, pour une
// navigation pleinement hors-ligne (mode avion). Les tuiles sont des réponses opaques
// cross-origin : illisibles par le script → stockées dans le Cache Storage (bucket
// "sr-pack-<id>", servi par sw.js). Seules les métadonnées légères vont en IndexedDB.
import { trackOf } from "./state.js";
import { ensureElevation, overpassFetch } from "./api.js";
import { TILE_TEMPLATES, POI_DEFS } from "./map.js";
import { ensureSavedCopy } from "./trails.js";
import { saveWeatherSnapshot } from "./weather.js";
import { putPackMeta, getPackMeta, delPackMeta } from "./storage.js";

// Calques embarqués (choix utilisateur : priorité terrain, hors mtb/ski/rain).
const PACK_LAYERS = ["plan", "topo", "satellite", "sombre", "terrainhd", "hillshade", "trails"];
const ZMIN = 12, ZMAX = 15;
const TILE_CAP = 8000;          // garde-fou : au-delà, tracé trop long pour un pack unique
const AVG_TILE_KB = 25;         // estimation d'affichage (octets opaques inaccessibles)
const CONCURRENCY = 6;

const packCacheName = (id) => `sr-pack-${id}`;

// Clé de cache normalisée — DOIT rester identique à celle de sw.js : le sous-domaine
// rotatif {s} (a/b/c/d) de Leaflet doit taper la même entrée que celle téléchargée.
function normTileKey(u) {
  const x = new URL(u);
  x.hostname = x.hostname.replace(/^[a-d]\./, "");
  return `${x.protocol}//${x.hostname}${x.pathname}`;
}

// ---------- Maths de tuiles (slippy map) ----------
function lonLatToTile(lat, lon, z) {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  const clamp = (v) => Math.max(0, Math.min(n - 1, v));
  return { x: clamp(x), y: clamp(y) };
}

function buildTileUrl(layer, z, x, y) {
  return TILE_TEMPLATES[layer].url
    .replace("{s}", "a")
    .replace("{z}", z)
    .replace("{x}", x)
    .replace("{y}", y);
}

// Corridor : toutes les tuiles (calque × zoom) traversées par le tracé, + 1 tuile de
// marge en x et y (largeur du couloir). Dédupliqué. Les points OSM (~15 m) garantissent
// l'absence de trou le long de la ligne.
function computeTiles(track) {
  const seen = new Set();
  const tiles = [];
  for (const layer of PACK_LAYERS) {
    const maxZ = Math.min(ZMAX, TILE_TEMPLATES[layer].maxZoom);
    for (let z = ZMIN; z <= maxZ; z++) {
      const n = 2 ** z;
      for (const [lat, lon] of track) {
        const { x, y } = lonLatToTile(lat, lon, z);
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++) {
            const tx = x + dx, ty = y + dy;
            if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
            const key = `${layer}|${z}|${tx}|${ty}`;
            if (seen.has(key)) continue;
            seen.add(key);
            tiles.push({ layer, z, x: tx, y: ty });
          }
      }
    }
  }
  return tiles;
}

// Estimation avant confirmation (sans rien enregistrer).
export function estimatePack(trail) {
  const tiles = computeTiles(trackOf(trail)).length;
  return { tiles, mb: Math.round((tiles * AVG_TILE_KB) / 1024) };
}

// ---------- Manifeste (cache mémoire + persistance légère) ----------
let manifest = {};

export async function initOffline() {
  manifest = (await getPackMeta("manifest").catch(() => null)) || {};
}

export const hasPack = (id) => !!manifest[id];
export const listPacks = () => Object.values(manifest).sort((a, b) => b.createdAt - a.createdAt);

// ---------- POI du corridor ----------
function classifyPoi(tags) {
  if (tags.amenity === "drinking_water" || tags.natural === "spring") return "water";
  if (tags.tourism === "alpine_hut" || tags.tourism === "wilderness_hut" || tags.amenity === "shelter") return "huts";
  if (tags.emergency === "mountain_rescue" || tags.emergency === "phone") return "rescue";
  return null;
}

async function fetchCorridorPoi(track) {
  let s = 90, w = 180, nn = -90, e = -180;
  for (const [lat, lon] of track) {
    if (lat < s) s = lat; if (lat > nn) nn = lat;
    if (lon < w) w = lon; if (lon > e) e = lon;
  }
  const bbox = `${s},${w},${nn},${e}`;
  const query =
    `[out:json][timeout:25];(` +
    `${POI_DEFS.water.query(bbox)}${POI_DEFS.huts.query(bbox)}${POI_DEFS.rescue.query(bbox)}` +
    `);out center 400;`;
  const elements = (await overpassFetch(query)).elements || [];
  const poi = [];
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    const tags = el.tags || {};
    const kind = classifyPoi(tags);
    if (!kind) continue;
    poi.push({ kind, lat, lon, name: POI_DEFS[kind].label(tags) });
  }
  return poi;
}

// Couche Leaflet des POI d'un pack, affichée hors-ligne pendant la navigation.
export async function packPoiLayer(id) {
  const poi = await getPackMeta(`poi:${id}`).catch(() => null);
  if (!poi?.length) return null;
  const group = L.layerGroup();
  for (const p of poi) {
    L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: "poi-marker", html: POI_DEFS[p.kind].icon, iconSize: [22, 22] }),
    })
      .bindPopup(`<div class="popup-title">${POI_DEFS[p.kind].icon} ${p.name}</div>`, { className: "map-popup" })
      .addTo(group);
  }
  return group;
}

// ---------- Construction / suppression ----------
async function downloadTiles(id, tiles, onProgress) {
  const cache = await caches.open(packCacheName(id));
  const total = tiles.length;
  let done = 0, i = 0;
  async function worker() {
    while (i < tiles.length) {
      const t = tiles[i++];
      const url = buildTileUrl(t.layer, t.z, t.x, t.y);
      try {
        const res = await fetch(url, { mode: "no-cors" });
        await cache.put(normTileKey(url), res);
      } catch { /* tuile isolée en échec : sans gravité, le fond restera partiel ici */ }
      done++;
      if (done % 12 === 0 || done === total) onProgress?.(done, total);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

// Télécharge un pack complet. onProgress reçoit ({phase} | {phase:"tiles",done,total}).
export async function buildPack(trail, onProgress) {
  onProgress?.({ phase: "prepare" });
  const local = await ensureSavedCopy(trail);   // copie locale complète (auto-save si OSM)
  await ensureElevation(local).catch(() => null); // profil garanti hors-ligne

  const track = trackOf(local);
  const tiles = computeTiles(track);
  if (tiles.length > TILE_CAP) {
    throw new Error(`Corridor de ${tiles.length} tuiles : tracé trop long pour un pack unique.`);
  }

  onProgress?.({ phase: "tiles", done: 0, total: tiles.length });
  await downloadTiles(local.id, tiles, (done, total) => onProgress?.({ phase: "tiles", done, total }));

  onProgress?.({ phase: "poi" });
  let poi = [];
  try { poi = await fetchCorridorPoi(track); await putPackMeta(`poi:${local.id}`, poi); } catch { /* POI best-effort */ }

  onProgress?.({ phase: "weather" });
  let weatherAt = null;
  try { await saveWeatherSnapshot(local); weatherAt = Date.now(); } catch { /* snapshot best-effort */ }

  manifest[local.id] = {
    id: local.id,
    name: local.name,
    tileCount: tiles.length,
    layers: PACK_LAYERS.length,
    poiCount: poi.length,
    weatherAt,
    createdAt: Date.now(),
  };
  await putPackMeta("manifest", manifest);
  onProgress?.({ phase: "done" });
  return manifest[local.id];
}

export async function deletePack(id) {
  await caches.delete(packCacheName(id)).catch(() => {});
  await delPackMeta(`poi:${id}`).catch(() => {});
  await delPackMeta(`wx:${id}`).catch(() => {});
  delete manifest[id];
  await putPackMeta("manifest", manifest);
}

// Purge de tous les packs (bouton « Tout effacer » des Réglages).
export async function deleteAllPacks() {
  const names = await caches.keys().catch(() => []);
  await Promise.all(names.filter((n) => n.startsWith("sr-pack-")).map((n) => caches.delete(n)));
  manifest = {};
}

// ---------- Jauge de stockage ----------
export async function storageEstimate() {
  try {
    const { usage = 0, quota = 0 } = (await navigator.storage?.estimate?.()) || {};
    return {
      usedMB: usage / 1048576,
      quotaMB: quota / 1048576,
      pct: quota ? Math.min(100, (usage / quota) * 100) : 0,
    };
  } catch {
    return null;
  }
}
