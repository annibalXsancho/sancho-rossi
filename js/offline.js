// Sancho Rossi — packs offline « pour le terrain » (S5)
// Télécharge, autour d'une rando enregistrée, un corridor de tuiles carto (z12–15,
// tous calques utiles), les POI eau/refuges/secours et un snapshot météo, pour une
// navigation pleinement hors-ligne (mode avion). Depuis S-V2-CARTE-C les tuiles sont
// téléchargées en mode `cors` (les 7 calques embarqués répondent tous `*`) : lisibles par
// le script ET décodables comme TEXTURES WebGL hors-ligne — ce que MapLibre exige et que
// les réponses opaques de l'ère Leaflet interdisaient. Elles restent dans le Cache Storage
// (bucket "sr-pack-<id>", servi par sw.js à l'URL) ; seules les métadonnées vont en IndexedDB.
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

const TILE_CAP = 24000;         // garde-fou corridor : au-delà, tracé trop long pour un pack unique
// Cap des packs de ZONE (S-V2-PACKS-ZONE). Une surface légitime (« toute la vallée ») dépasse
// vite le cap corridor ; on le relève, le vrai filet restant l'estimation honnête affichée +
// assertRoomFor + le QuotaExceededError intercepté à l'écriture.
const ZONE_TILE_CAP = 60000;
const CONCURRENCY = 6;

// Poids moyen d'une tuile, pour l'estimation affichée AVANT téléchargement. Depuis le
// passage en mode `cors` (S-V2-CARTE-C) les réponses sont lisibles : on calibre sur la
// somme EXACTE des Content-Length du dernier pack (mesure directe), avec repli sur le
// delta de `navigator.storage.estimate()` si l'échantillon manque.
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

// Clé de cache normalisée — DOIT rester identique à celle de sw.js : MapLibre demande les
// tuiles via les sous-domaines a/b/c énumérés dans `tiles`, tous doivent taper l'unique
// entrée téléchargée sous le préfixe retiré.
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

// ---------- Tuiles d'une ZONE (rectangle bbox, S-V2-PACKS-ZONE) ----------
// Même modèle de profondeur que le corridor : les 7 calques jusqu'à z15, 1–2 calques
// « détaillés » jusqu'à z16/z17. La différence est la surface : on balaie TOUTES les tuiles
// (x,y) entre les coins NO (n,w) et SE (s,e) au lieu de suivre un tracé. Dédup par Set.
function computeZoneTiles(bbox, depth = {}) {
  const { deepLayers, deepMax } = normalizeDepth(depth);
  const { s, w, n, e } = bbox;
  const seen = new Set();
  const tiles = [];
  for (const layer of PACK_LAYERS) {
    const target = deepLayers.includes(layer) ? deepMax : ZMAX;
    const maxZ = Math.min(target, TILE_TEMPLATES[layer].maxZoom);
    for (let z = ZMIN; z <= maxZ; z++) {
      const nT = 2 ** z;
      const tl = lonLatToTile(n, w, z);   // coin nord-ouest
      const br = lonLatToTile(s, e, z);   // coin sud-est
      const x0 = Math.min(tl.x, br.x), x1 = Math.max(tl.x, br.x);
      const y0 = Math.min(tl.y, br.y), y1 = Math.max(tl.y, br.y);
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          if (x < 0 || y < 0 || x >= nT || y >= nT) continue;
          const key = `${layer}|${z}|${x}|${y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          tiles.push({ layer, z, x, y });
        }
    }
  }
  return tiles;
}

export function estimateZonePack(bbox, depth = {}) {
  const tiles = computeZoneTiles(bbox, depth).length;
  const mb = (tiles * avgTileKb()) / 1024;
  return { tiles, mb, mbLabel: mb < 10 ? mb.toFixed(1) : String(Math.round(mb)), overCap: tiles > ZONE_TILE_CAP };
}

// ---------- Manifeste (cache mémoire + persistance légère) ----------
let manifest = {};
// Téléchargements de zone interrompus, reprenables (S-V2-PACKS-ZONE). Map id→record,
// persistée sous une seule clé (comme le manifeste). Un pack terminé n'y figure plus.
let pending = {};

export async function initOffline() {
  manifest = (await getPackMeta("manifest").catch(() => null)) || {};
  pending = (await getPackMeta("pending").catch(() => null)) || {};
}

export const hasPack = (id) => !!manifest[id];
export const listPacks = () => Object.values(manifest).sort((a, b) => b.createdAt - a.createdAt);
export const listPending = () => Object.values(pending).sort((a, b) => b.createdAt - a.createdAt);

async function putPending(rec) { pending[rec.id] = rec; await putPackMeta("pending", pending); }
async function clearPendingRecord(id) { delete pending[id]; await putPackMeta("pending", pending); }
// Abandon d'un téléchargement en attente : on retire le record ET le corridor partiel.
export async function delPending(id) {
  await clearPendingRecord(id);
  await caches.delete(packCacheName(id)).catch(() => {});
  await delPackMeta(`poi:${id}`).catch(() => {});
}

// ---------- POI du corridor ----------
function classifyPoi(tags) {
  if (tags.amenity === "drinking_water" || tags.natural === "spring") return "water";
  if (tags.tourism === "alpine_hut" || tags.tourism === "wilderness_hut" || tags.amenity === "shelter") return "huts";
  if (tags.emergency === "mountain_rescue" || tags.emergency === "phone") return "rescue";
  return null;
}

function bboxOfTrack(track) {
  let s = 90, w = 180, nn = -90, e = -180;
  for (const [lat, lon] of track) {
    if (lat < s) s = lat; if (lat > nn) nn = lat;
    if (lon < w) w = lon; if (lon > e) e = lon;
  }
  return { s, w, n: nn, e };
}

const fetchCorridorPoi = (track) => fetchBboxPoi(bboxOfTrack(track));

async function fetchBboxPoi({ s, w, n, e }) {
  const bbox = `${s},${w},${n},${e}`;
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
// `resume` : saute les tuiles déjà en cache (re-run idempotent et bon marché d'un pack de
// zone interrompu). `shouldStop()` : arrêt coopératif propre (bouton Annuler) — le partiel
// reste en place, reprenable ; on ne jette rien.
async function downloadTiles(id, tiles, onProgress, { resume = false, shouldStop = null } = {}) {
  const cache = await caches.open(packCacheName(id));
  const total = tiles.length;
  let done = 0, i = 0, quotaHit = false, stopped = false, bytes = 0, measured = 0;
  async function worker() {
    while (i < tiles.length && !quotaHit && !stopped) {
      if (shouldStop?.()) { stopped = true; break; }
      const t = tiles[i++];
      const url = buildTileUrl(t.layer, t.z, t.x, t.y);
      const key = normTileKey(url);
      try {
        // Reprise : une tuile déjà téléchargée (persistée en Cache Storage) n'est pas
        // refetchée — c'est ce qui rend « Reprendre » économe après une interruption.
        if (resume && (await cache.match(key))) {
          /* déjà en cache */
        } else {
          // Mode `cors` (et non plus `no-cors`) : sous MapLibre chaque tuile devient une
          // texture WebGL, qui refuse une réponse opaque. Les 7 calques embarqués répondent
          // tous `Access-Control-Allow-Origin: *` → réponse lisible, décodable hors-ligne.
          const res = await fetch(url, { mode: "cors" });
          if (res.ok) {
            // Content-Length est un en-tête de réponse sûr (toujours lisible, même cross-
            // origin) : on somme le poids réel plutôt que de le deviner (calibration exacte).
            const len = Number(res.headers.get("content-length"));
            if (Number.isFinite(len) && len > 0) { bytes += len; measured++; }
            await cache.put(key, res);
          }
        }
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
  return { bytes, measured, stopped };
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
  let dl;
  try {
    dl = await downloadTiles(local.id, tiles, (done, total) => onProgress?.({ phase: "tiles", done, total }));
  } catch (err) {
    // Pack inutilisable : on ne laisse pas un demi-corridor occuper la place ni se faire
    // passer pour un pack valide (il n'entre jamais au manifeste).
    await caches.delete(packCacheName(local.id)).catch(() => {});
    throw err;
  }
  const after = (await storageEstimate())?.usedMB;
  // Calibration : mesure EXACTE (somme des Content-Length) dès que l'échantillon suffit,
  // sinon repli sur le delta de storage.estimate comme avant le passage en mode `cors`.
  if (dl.measured >= 200) calibrateTileKb(dl.bytes, dl.measured);
  else if (before != null && after != null) calibrateTileKb((after - before) * 1048576, tiles.length);

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
    // Poids réel du corridor, désormais connu exactement (mode `cors` → Content-Length
    // lisible). Champ neuf, structured-clone, aucune migration IndexedDB.
    sizeBytes: dl.bytes || null,
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

// Pack de ZONE (S-V2-PACKS-ZONE) : une surface bbox, indépendante de tout tracé. Même
// socle que buildPack (Cache Storage `sr-pack-<id>`, clé normalisée, calibration) mais
// tuiles de surface, POI de la bbox, pas de snapshot météo (une zone n'est pas une rando).
// Un record de reprise est posé AVANT le téléchargement : une interruption (fermeture,
// quota, Annuler) le laisse en place → « Reprendre » relance sans re-télécharger le déjà-fait.
// `opts`: { id, resume, createdAt, shouldStop }. Renvoie l'entrée manifeste, ou null si annulé.
export async function buildZonePack(name, bbox, depth = {}, onProgress, opts = {}) {
  const { deepLayers, deepMax } = normalizeDepth(depth);
  const id = opts.id || `zone-${Date.now()}`;
  const resume = !!opts.resume;
  const createdAt = opts.createdAt || Date.now();

  onProgress?.({ phase: "prepare" });
  const tiles = computeZoneTiles(bbox, { deepLayers, deepMax });
  if (tiles.length > ZONE_TILE_CAP) {
    throw new Error(`Zone de ${tiles.length} tuiles : trop vaste pour un pack unique à ce niveau de détail.`);
  }
  // À la reprise, une partie est déjà sur le disque : ne pas re-refuser sur la place totale.
  if (!resume) await assertRoomFor(tiles.length);

  await putPending({ id, name, bbox, depth: { deepLayers, deepMax }, tileCount: tiles.length, createdAt });

  const before = (await storageEstimate())?.usedMB;
  onProgress?.({ phase: "tiles", done: 0, total: tiles.length });
  const dl = await downloadTiles(
    id, tiles,
    (done, total) => onProgress?.({ phase: "tiles", done, total }),
    { resume, shouldStop: opts.shouldStop }
  ); // quota → throw (partiel conservé en pending, reprenable), pas de suppression du cache
  if (dl.stopped) { onProgress?.({ phase: "stopped" }); return null; }  // annulé : pending gardé

  const after = (await storageEstimate())?.usedMB;
  if (dl.measured >= 200) calibrateTileKb(dl.bytes, dl.measured);
  else if (!resume && before != null && after != null) calibrateTileKb((after - before) * 1048576, tiles.length);

  onProgress?.({ phase: "poi" });
  let poi = [];
  try { poi = await fetchBboxPoi(bbox); await putPackMeta(`poi:${id}`, poi); } catch { /* POI best-effort */ }

  manifest[id] = {
    id, name, kind: "zone", bbox,
    tileCount: tiles.length,
    sizeBytes: dl.bytes || null,
    layers: PACK_LAYERS.length,
    deepLayers, deepMax,
    poiCount: poi.length,
    createdAt,
  };
  await putPackMeta("manifest", manifest);
  await clearPendingRecord(id);
  onProgress?.({ phase: "done" });
  return manifest[id];
}

// Reprend un téléchargement de zone interrompu depuis son record pending.
export async function resumeZonePack(id, onProgress, shouldStop) {
  const rec = pending[id];
  if (!rec) throw new Error("Téléchargement introuvable.");
  return buildZonePack(rec.name, rec.bbox, rec.depth, onProgress, {
    id: rec.id, resume: true, createdAt: rec.createdAt, shouldStop,
  });
}

export async function deletePack(id) {
  await caches.delete(packCacheName(id)).catch(() => {});
  await delPackMeta(`poi:${id}`).catch(() => {});
  await delPackMeta(`wx:${id}`).catch(() => {});
  await delPackMeta(`hw:${id}`).catch(() => {});
  delete manifest[id];
  await putPackMeta("manifest", manifest);
  if (pending[id]) await clearPendingRecord(id);
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
