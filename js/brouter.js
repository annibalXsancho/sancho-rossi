// Sancho Rossi — client BRouter mutualisé (routage rando + tags de terrain)
// BRouter était implémenté deux fois : builder.js routait par PAIRES de points (un
// appel par tronçon) et loops.js en un seul appel multi-points. La seconde approche
// est la bonne (un aller-retour réseau, itinéraire globalement cohérent) : c'est
// elle qui est généralisée ici, et loops.js/planner.js consomment ce module.
//
// `format=geojson` renvoie, en plus de la géométrie (altitude en 3ᵉ coordonnée) :
//   - properties["track-length"]    → longueur en mètres
//   - properties["filtered ascend"] → D+ en mètres
//   - properties.messages           → 1 ligne par tronçon de way, colonne `WayTags`
//     portant `highway=… surface=… sac_scale=…`. C'est la seule source de tags de
//     terrain que nous ayons (couverture mesurée : highway 100 %, surface 27–100 %,
//     sac_scale 0–84 % selon les massifs → toujours prévoir l'absence).
import { haversineKm } from "./state.js";

const BROUTER_URL = "https://brouter.de/brouter";
const MIN_SEP_KM = 0.03; // BRouter refuse deux points de passage confondus

// "highway=path surface=ground sac_scale=hiking" → { highway, surface, sac_scale }
function parseTags(raw) {
  const out = {};
  for (const kv of String(raw || "").split(" ")) {
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

// messages[0] = en-tête, puis 1 ligne par tronçon. Coordonnées en MICRODEGRÉS
// (6869827 → 6.869827), Distance en mètres. On lit les colonnes par leur nom :
// l'ordre n'est pas contractuel.
function parseWays(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return [];
  const hdr = messages[0];
  const iLon = hdr.indexOf("Longitude");
  const iLat = hdr.indexOf("Latitude");
  const iDist = hdr.indexOf("Distance");
  const iTags = hdr.indexOf("WayTags");
  if (iTags < 0 || iDist < 0) return [];
  return messages.slice(1).map((r) => ({
    lat: iLat >= 0 ? Number(r[iLat]) / 1e6 : null,
    lon: iLon >= 0 ? Number(r[iLon]) / 1e6 : null,
    distM: Number(r[iDist]) || 0,
    tags: parseTags(r[iTags]),
  }));
}

function withTimeout(timeout, signal) {
  const t = AbortSignal.timeout(timeout);
  if (!signal) return t;
  return AbortSignal.any ? AbortSignal.any([t, signal]) : signal;
}

// waypoints : [[lat, lon], …] (≥ 2, dans l'ordre de passage).
// → { track: [[lat,lon]…], eles: number[]|null, distance: km, ascend: m|null, ways }
// `eles` est null dès qu'une altitude manque ou que la longueur diffère de `track` :
// l'invariant `eles.length === track.length` est tenu partout dans l'app (profil,
// 3D, export GPX) — mieux vaut pas d'altitude qu'une altitude décalée.
export async function brouterRoute(waypoints, { profile = "hiking-mountain", timeout = 20000, signal } = {}) {
  const pts = waypoints.filter((p, i) => i === 0 || haversineKm(p, waypoints[i - 1]) > MIN_SEP_KM);
  if (pts.length < 2) throw new Error("Deux points de passage distincts au minimum.");
  const lonlats = pts.map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join("|");
  const res = await fetch(
    `${BROUTER_URL}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`,
    { signal: withTimeout(timeout, signal) }
  );
  if (!res.ok) throw new Error(`BRouter ${res.status}`);
  const text = await res.text();
  // BRouter répond parfois en texte brut (« target island detected for section 0 »)
  // avec un statut 200 : sans ce garde-fou, JSON.parse lâche une SyntaxError opaque.
  let feat;
  try {
    feat = JSON.parse(text).features?.[0];
  } catch {
    throw new Error(`BRouter : ${text.slice(0, 80)}`);
  }
  if (!feat) throw new Error("BRouter : aucune route");
  const track = feat.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  let eles = feat.geometry.coordinates.map((c) => c[2]);
  if (eles.some((v) => v == null) || eles.length !== track.length) eles = null;
  const distance = Number(feat.properties["track-length"]) / 1000;
  if (!(distance > 0) || track.length < 2) throw new Error("BRouter : itinéraire dégénéré");
  const ascend = Number(feat.properties["filtered ascend"]);
  return {
    track,
    eles,
    distance,
    ascend: Number.isFinite(ascend) ? ascend : null,
    ways: parseWays(feat.properties.messages),
  };
}
