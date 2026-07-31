// Sancho Rossi — modèle numérique de terrain lisible par le script (S-SOLEIL)
//
// MapLibre sait DESSINER le relief (tuiles Terrarium, cf. map.js/ensureDemOn) mais ne
// donne aucun accès fiable à ses altitudes : `queryTerrainElevation` ne répond que pour
// les tuiles chargées, au zoom courant de la caméra — inutilisable pour lancer des rayons
// sur 25 km. Ce module relit donc les MÊMES tuiles pour son compte et les décode en
// grilles d'altitude exploitables (horizon, ombres portées).
//
// Deux règles tirées de l'expérience du projet :
//  1. `fetch()`, JAMAIS `new Image()`. C'est exactement ce qui avait tué la 3D hors-ligne
//     (cf. l'en-tête de fiche3d.js) : une requête `Image` ne traverse pas le Service
//     Worker, donc ne voit pas les packs. En `fetch` + `createImageBitmap`, le SW est sur
//     le chemin — et les tuiles Terrarium répondent `Access-Control-Allow-Origin: *`
//     (audité en S-V2-CARTE-A), donc le canvas n'est pas teinté et reste lisible.
//  2. Cache persistant dans le store `meta` d'IndexedDB, qui est un clé-valeur LIBRE :
//     aucune migration de schéma, et une zone déjà consultée reste calculable hors-ligne.
import { idbGet, putMeta } from "./storage.js";

const DEM_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const TILE = 256;
const MAX_TILES_PER_LEVEL = 12; // garde-fou réseau/mémoire, cf. pickZoom
const MEM_MAX = 48; // ~6 Mo d'Int16Array : de quoi tenir une fiche sans gonfler indéfiniment

// Zooms candidats, du plus fin au plus grossier. z12 ≈ 27 m/px à 45° de latitude, soit la
// résolution native de la donnée (SRTM ~30 m) : descendre plus fin n'ajouterait aucune
// information, seulement du poids.
const ZOOMS = [12, 11, 10];

const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const latToTileY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
};

// ---------- Chargement et décodage d'une tuile ----------
const mem = new Map(); // "z/x/y" → Int16Array(256²) | null (tuile manquante, mémorisée)
const inflight = new Map();

function decode(imageData) {
  const { data } = imageData;
  const out = new Int16Array(TILE * TILE);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    // Encodage terrarium : altitude = R·256 + G + B/256 − 32768. Le B (fraction de mètre)
    // ne survit pas à l'arrondi entier et ne nous manque pas : on raisonne en mètres.
    out[i] = data[p] * 256 + data[p + 1] - 32768;
  }
  return out;
}

async function fetchTile(z, x, y) {
  const res = await fetch(`${DEM_TILES}/${z}/${x}/${y}.png`, { cache: "force-cache" });
  if (!res.ok) throw new Error(`tuile ${z}/${x}/${y} : ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const canvas =
    typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(TILE, TILE)
      : Object.assign(document.createElement("canvas"), { width: TILE, height: TILE });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, TILE, TILE);
  bitmap.close?.();
  return decode(ctx.getImageData(0, 0, TILE, TILE));
}

function remember(key, grid) {
  if (mem.size >= MEM_MAX) mem.delete(mem.keys().next().value); // FIFO : le plus ancien part
  mem.set(key, grid);
  return grid;
}

// Mémoire → IndexedDB → réseau. Une tuile absente (mer, bord du jeu de données, hors
// ligne) vaut `null` et se propage comme « pas d'obstacle », jamais comme une erreur :
// une crête manquante dégrade la précision, elle ne doit pas casser l'écran.
function loadTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (mem.has(key)) return Promise.resolve(mem.get(key));
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const cached = await idbGet("meta", `dem:${key}`).catch(() => null);
    if (cached instanceof Int16Array) return remember(key, cached);
    try {
      const grid = await fetchTile(z, x, y);
      putMeta(`dem:${key}`, grid).catch(() => {}); // le cache est un bonus, pas un prérequis
      return remember(key, grid);
    } catch {
      return remember(key, null);
    }
  })().finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}

// ---------- Un niveau = une nappe de tuiles à un zoom donné ----------
function makeLevel(z, x0, x1, y0, y1, grids) {
  const n = 2 ** z;
  return {
    z,
    // Altitude au pixel global (gx, gy) du niveau — null hors nappe ou tuile manquante.
    pixel(gx, gy) {
      const tx = Math.floor(gx / TILE), ty = Math.floor(gy / TILE);
      if (tx < x0 || tx > x1 || ty < y0 || ty > y1) return null;
      const grid = grids.get(`${tx}/${ty}`);
      if (!grid) return null;
      return grid[(gy - ty * TILE) * TILE + (gx - tx * TILE)];
    },
    // Altitude interpolée bilinéairement — sans elle, les rayons d'horizon « escaliers »
    // font clignoter l'angle de crête d'un azimut à l'autre.
    at(lat, lon) {
      if (lat > 85 || lat < -85) return null;
      const fx = lonToTileX(lon, z) * TILE, fy = latToTileY(lat, z) * TILE;
      const gx = Math.floor(fx), gy = Math.floor(fy);
      const rx = fx - gx, ry = fy - gy;
      const a = this.pixel(gx, gy);
      if (a == null) return null;
      const b = this.pixel(Math.min(gx + 1, n * TILE - 1), gy) ?? a;
      const c = this.pixel(gx, Math.min(gy + 1, n * TILE - 1)) ?? a;
      const d = this.pixel(Math.min(gx + 1, n * TILE - 1), Math.min(gy + 1, n * TILE - 1)) ?? a;
      return (a * (1 - rx) + b * rx) * (1 - ry) + (c * (1 - rx) + d * rx) * ry;
    },
  };
}

// Le zoom le plus fin dont la nappe tient sous le garde-fou : un rayon de 6 km se paie
// 4 tuiles en z12, un rayon de 25 km en coûterait 49 — d'où la dégradation automatique.
function pickZoom(lat, radiusM, finest) {
  for (const z of ZOOMS.filter((z) => z <= finest)) {
    const dLat = radiusM / 111320;
    const dLon = radiusM / (111320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
    // Nombre de tuiles couvertes : estimé sur la LARGEUR en degrés, pas depuis la longitude
    // réelle (une nappe à cheval sur l'antiméridien fausserait le compte, pas la taille).
    const nx = Math.ceil((2 * dLon * 2 ** z) / 360) + 1;
    const ny = Math.floor(latToTileY(lat - dLat, z)) - Math.floor(latToTileY(lat + dLat, z)) + 1;
    if (nx * ny <= MAX_TILES_PER_LEVEL) return z;
  }
  return ZOOMS[ZOOMS.length - 1];
}

async function buildLevel(lat, lon, radiusM, finest) {
  const z = pickZoom(lat, radiusM, finest);
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  const x0 = Math.floor(lonToTileX(lon - dLon, z)), x1 = Math.floor(lonToTileX(lon + dLon, z));
  const y0 = Math.floor(latToTileY(lat + dLat, z)), y1 = Math.floor(latToTileY(lat - dLat, z));

  const jobs = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      jobs.push(loadTile(z, x, y).then((g) => [`${x}/${y}`, g]));
    }
  }
  const grids = new Map((await Promise.all(jobs)).filter(([, g]) => g));
  return { level: makeLevel(z, x0, x1, y0, y1, grids), tiles: grids.size, z };
}

/**
 * Charge de quoi interroger l'altitude autour d'un point : une nappe FINE pour le relief
 * proche (celui qui masque le soleil de peu mais souvent) et une nappe LARGE pour les
 * crêtes lointaines (déterminantes au lever et au coucher, quand le soleil rase).
 *
 * @param {number} lat @param {number} lon centre
 * @param {object} [opts] `nearKm` rayon fin (défaut 6), `farKm` rayon large (défaut 25)
 * @returns {Promise<{elevationAt:Function, near:object, far:object, tiles:number}>}
 */
export async function loadDem(lat, lon, { nearKm = 6, farKm = 25 } = {}) {
  const [near, far] = await Promise.all([
    buildLevel(lat, lon, nearKm * 1000, 12),
    buildLevel(lat, lon, farKm * 1000, 11),
  ]);
  return {
    near: near.level,
    far: far.level,
    tiles: near.tiles + far.tiles,
    zooms: [near.z, far.z],
    // Le niveau fin d'abord, la nappe large en repli : au-delà du rayon proche, `at`
    // renvoie null et la question se repose au niveau grossier.
    elevationAt(la, lo) {
      const fine = near.level.at(la, lo);
      return fine != null ? fine : far.level.at(la, lo);
    },
  };
}
