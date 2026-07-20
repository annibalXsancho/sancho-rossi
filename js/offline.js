// Sancho Rossi — packs offline « pour le terrain » (S5)
// Télécharge, autour d'une rando enregistrée, un corridor de tuiles carto (z12–15,
// tous calques utiles), les POI eau/refuges/secours et un snapshot météo, pour une
// navigation pleinement hors-ligne (mode avion). Les tuiles sont des réponses opaques
// cross-origin : illisibles par le script → stockées dans le Cache Storage (bucket
// "sr-pack-<id>", servi par sw.js). Seules les métadonnées légères vont en IndexedDB.
import { trackOf } from "./state.js";
import { ensureElevation, overpassFetch } from "./api.js";
import { TILE_TEMPLATES, POI_DEFS, domMarker, makeIcon, markerGroup } from "./map.js";
import { ensureSavedCopy } from "./trails.js";
import { saveWeatherSnapshot } from "./weather.js";
import { saveHikeWeatherSnapshot } from "./hikeweather.js";
import { putPackMeta, getPackMeta, delPackMeta } from "./storage.js";

// Calques embarqués (choix utilisateur : priorité terrain, hors mtb/ski/rain).
export const PACK_LAYERS = ["plan", "topo", "satellite", "sombre", "terrainhd", "hillshade", "trails"];
const ZMIN = 12, ZMAX = 15;

// Profondeur (S-V2-ZOOM). Les 7 calques restent embarqués jusqu'à z15 ; au-delà, le poids
// explose (chaque niveau double le corridor) — c'est le NOMBRE DE CALQUES qui contient le
// poids, pas le zoom. On approfondit donc 1 à 2 calques choisis jusqu'à z16 ou z17.
export const DEEP_MAX_LAYERS = 2;
export const DEEP_ZOOMS = [16, 17];
// Calques éligibles à la profondeur : ceux dont le zoom natif atteint z16 (terrainhd
// s'arrête à 13, hillshade à 16 mais n'est qu'un ombrage — sans micro-détail utile).
export const DEEP_LAYERS = ["plan", "topo", "satellite", "sombre", "trails"];

const TILE_CAP = 24000;         // garde-fou : au-delà, tracé trop long pour un pack unique
const CONCURRENCY = 6;

// Poids moyen d'une tuile. Les réponses sont opaques (octets illisibles par le script) :
// impossible de mesurer tuile par tuile. On calibre donc a posteriori sur le delta de
// `navigator.storage.estimate()` d'un vrai téléchargement, ce qui rend l'estimation
// annoncée honnête au lieu de reposer sur une constante devinée.
// 18 ko : moyenne mesurée (curl, 35 tuiles, z12–17, topo + satellite + plan) le
// 19/07/2026. L'ancienne constante de 25 ko surestimait d'environ 45 %.
const AVG_TILE_KB_DEFAULT = 18;
const CALIB_KEY = "sr-tile-kb";
const avgTileKb = () => {
  const v = parseFloat(localStorage.getItem(CALIB_KEY) || "");
  return Number.isFinite(v) ? v : AVG_TILE_KB_DEFAULT;
};
function calibrateTileKb(deltaBytes, tiles) {
  if (!(deltaBytes > 0) || tiles < 200) return;           // échantillon trop maigre
  const kb = deltaBytes / 1024 / tiles;
  if (kb < 4 || kb > 150) return;                         // mesure aberrante (autre écriture concurrente)
  // Lissage : une mesure ne balaie pas l'historique, la valeur converge sur quelques packs.
  localStorage.setItem(CALIB_KEY, (avgTileKb() * 0.4 + kb * 0.6).toFixed(2));
}

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

// Options de profondeur normalisées : au plus DEEP_MAX_LAYERS calques éligibles, zoom
// cible dans DEEP_ZOOMS. `deepMax: 0` (ou aucun calque) = pack standard z12–15.
export function normalizeDepth(opts = {}) {
  const layers = (opts.deepLayers || []).filter((l) => DEEP_LAYERS.includes(l)).slice(0, DEEP_MAX_LAYERS);
  // Un zoom hors liste est ramené dans la plage plutôt que de dégrader silencieusement
  // le pack en standard : demander « plus fin que 17 » veut dire 17, pas 15.
  const asked = Number(opts.deepMax) || 0;
  const deepMax = asked <= 0 ? 0 : Math.min(Math.max(asked, DEEP_ZOOMS[0]), DEEP_ZOOMS.at(-1));
  return layers.length && deepMax ? { deepLayers: layers, deepMax } : { deepLayers: [], deepMax: 0 };
}

// Corridor : toutes les tuiles (calque × zoom) traversées par le tracé, + 1 tuile de
// marge en x et y (largeur du couloir). Dédupliqué. Les points OSM (~15 m) garantissent
// l'absence de trou le long de la ligne.
function computeTiles(track, depth = {}) {
  const { deepLayers, deepMax } = normalizeDepth(depth);
  const seen = new Set();
  const tiles = [];
  for (const layer of PACK_LAYERS) {
    // Plafond du calque : z15 partout, poussé à z16/z17 pour les calques approfondis.
    const target = deepLayers.includes(layer) ? deepMax : ZMAX;
    const maxZ = Math.min(target, TILE_TEMPLATES[layer].maxZoom);
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

// Estimation avant confirmation (sans rien enregistrer). `mb` est décimal : à 30 Mo près,
// arrondir à l'entier suffit, mais un petit pack ne doit pas s'annoncer « 0 Mo ».
export function estimatePack(trail, depth = {}) {
  const tiles = computeTiles(trackOf(trail), depth).length;
  const mb = (tiles * avgTileKb()) / 1024;
  return { tiles, mb, mbLabel: mb < 10 ? mb.toFixed(1) : String(Math.round(mb)), overCap: tiles > TILE_CAP };
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

// Groupe de marqueurs des POI d'un pack, affiché hors-ligne pendant la navigation
// (nav.js le pose sur la carte principale).
export async function packPoiLayer(id) {
  const poi = await getPackMeta(`poi:${id}`).catch(() => null);
  if (!poi?.length) return null;
  const group = markerGroup();
  for (const p of poi) {
    const icon = POI_DEFS[p.kind].icon;
    group.add(
      domMarker(p.lat, p.lon, { element: makeIcon("poi-marker", icon, 22) })
        .setPopup(new maplibregl.Popup({ className: "map-popup", offset: 14 })
          .setHTML(`<div class="popup-title">${icon} ${p.name}</div>`))
    );
  }
  return group;
}

// ---------- Construction / suppression ----------
async function downloadTiles(id, tiles, onProgress) {
  const cache = await caches.open(packCacheName(id));
  const total = tiles.length;
  let done = 0, i = 0, quotaHit = false;
  async function worker() {
    while (i < tiles.length && !quotaHit) {
      const t = tiles[i++];
      const url = buildTileUrl(t.layer, t.z, t.x, t.y);
      try {
        const res = await fetch(url, { mode: "no-cors" });
        await cache.put(normTileKey(url), res);
      } catch (err) {
        // Quota dépassé : inutile de marteler, tout le reste échouera aussi. On arrête net
        // et on remonte une erreur lisible (le pack partiel est supprimé par l'appelant).
        if (err?.name === "QuotaExceededError") { quotaHit = true; break; }
        /* tuile isolée en échec : sans gravité, le fond restera partiel ici */
      }
      done++;
      if (done % 12 === 0 || done === total) onProgress?.(done, total);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (quotaHit) throw new Error("le stockage de l'appareil est plein. Supprimez un pack ou choisissez moins de calques détaillés.");
}

// Place restante, en Mo — ou null si le navigateur ne donne pas de lecture exploitable.
// Certains navigateurs plafonnent `usage` à `quota` (on lit alors 0 octet libre alors que
// le disque est vide) : sur une lecture dégénérée on ne prétend rien, plutôt que de
// bloquer à tort tous les téléchargements. Le garde-fou réel reste le QuotaExceededError
// intercepté pendant l'écriture.
export async function freeSpaceMB() {
  const est = await storageEstimate();
  if (!est?.quotaMB) return null;
  const free = est.quotaMB - est.usedMB;
  return free > 0 ? free : null;
}

// Vérifie qu'il reste la place annoncée. Refus propre (message clair) plutôt que
// remplissage jusqu'au QuotaExceededError au milieu du téléchargement.
async function assertRoomFor(tiles) {
  const freeMB = await freeSpaceMB();
  if (freeMB == null) return;                          // lecture inexploitable : on n'invente pas de refus
  const needMB = (tiles * avgTileKb()) / 1024;
  if (needMB > freeMB * 0.9) {
    throw new Error(
      `il faut ~${Math.round(needMB)} Mo et il ne reste que ~${Math.round(freeMB)} Mo. ` +
      `Choisissez moins de calques détaillés ou supprimez un pack.`
    );
  }
}

// Télécharge un pack complet. `depth` = { deepLayers, deepMax } (voir normalizeDepth).
// onProgress reçoit ({phase} | {phase:"tiles",done,total}).
export async function buildPack(trail, depth = {}, onProgress) {
  const { deepLayers, deepMax } = normalizeDepth(depth);
  onProgress?.({ phase: "prepare" });
  const local = await ensureSavedCopy(trail);   // copie locale complète (auto-save si OSM)
  await ensureElevation(local).catch(() => null); // profil garanti hors-ligne

  const track = trackOf(local);
  const tiles = computeTiles(track, { deepLayers, deepMax });
  if (tiles.length > TILE_CAP) {
    throw new Error(`Corridor de ${tiles.length} tuiles : tracé trop long pour un pack unique.`);
  }
  await assertRoomFor(tiles.length);

  const before = (await storageEstimate())?.usedMB;
  onProgress?.({ phase: "tiles", done: 0, total: tiles.length });
  try {
    await downloadTiles(local.id, tiles, (done, total) => onProgress?.({ phase: "tiles", done, total }));
  } catch (err) {
    // Pack inutilisable : on ne laisse pas un demi-corridor occuper la place ni se faire
    // passer pour un pack valide (il n'entre jamais au manifeste).
    await caches.delete(packCacheName(local.id)).catch(() => {});
    throw err;
  }
  const after = (await storageEstimate())?.usedMB;
  if (before != null && after != null) calibrateTileKb((after - before) * 1048576, tiles.length);

  onProgress?.({ phase: "poi" });
  let poi = [];
  try { poi = await fetchCorridorPoi(track); await putPackMeta(`poi:${local.id}`, poi); } catch { /* POI best-effort */ }

  onProgress?.({ phase: "weather" });
  let weatherAt = null;
  try { await saveWeatherSnapshot(local); weatherAt = Date.now(); } catch { /* snapshot best-effort */ }
  // Météo à l'heure de passage (S-METEO) : mêmes garanties best-effort que le
  // snapshot météo classique — un échec ne condamne pas le pack.
  try { await saveHikeWeatherSnapshot(local); } catch { /* snapshot best-effort */ }

  manifest[local.id] = {
    id: local.id,
    name: local.name,
    tileCount: tiles.length,
    layers: PACK_LAYERS.length,
    deepLayers,
    deepMax,
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
  await delPackMeta(`hw:${id}`).catch(() => {});
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
