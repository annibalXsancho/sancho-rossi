// Sancho Rossi — photos de terrain récentes (Mapillary), par proximité du tracé.
// S-V2-PHOTOS (vague 4) : première exception à la règle « sans clé » (cf. CLAUDE.md) —
// le token Mapillary est un jeton CLIENT gratuit, sans moyen de paiement, conçu pour
// être exposé dans du code public ; pire risque = quota gratuit épuisé, régénérable
// en un clic. Repli Wikimedia/Commons (photos.js, hero de fiche) conservé tel quel
// si aucune photo Mapillary n'est trouvée sur le corridor.
import { sampleTrack, haversineKm } from "./state.js";
import { fetchRetry } from "./net.js";

// Token client Mapillary — créé sur mapillary.com → tableau de bord développeur.
// Vide tant que non fourni : trailPhotos() renvoie alors [] sans requête réseau
// (le hero Commons existant reste la seule photo, absence élégante).
const MAPILLARY_TOKEN = "MLY|37244468701866006|0f7f7382333b0dc1c59ac8ffa560f3ab";

const MAX_PHOTOS = 12;
const CORRIDOR_M = 80; // rayon de proximité au tracé retenu, en mètres
const SAMPLE_PTS = 60; // points du tracé échantillonnés pour la recherche de proximité
const BBOX_PAD_DEG = 0.001; // ~110 m de marge autour du tracé pour la requête bbox

function bboxOf(points, padDeg) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [lat, lon] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return [minLon - padDeg, minLat - padDeg, maxLon + padDeg, maxLat + padDeg];
}

// Distance (m) d'un point au tracé échantillonné = min sur les points échantillonnés
// (approximation suffisante à l'échelle du corridor, cohérente avec le pas d'échantillonnage).
function distToTrackM(lat, lon, sampled) {
  let best = Infinity;
  for (const p of sampled) {
    const d = haversineKm(p, [lat, lon]) * 1000;
    if (d < best) best = d;
  }
  return best;
}

// Photos Mapillary sur le corridor d'un tracé, triées par proximité. [] si pas de
// token, pas de géométrie exploitable, hors-ligne, ou aucune photo dans le corridor —
// dans tous les cas l'appelant doit traiter [] comme une absence normale.
export async function trailPhotos(t) {
  if (!MAPILLARY_TOKEN) return [];
  const track = t.mainline || t.track || (t.segments || []).flat();
  if (!track || track.length < 2) return [];
  const sampled = sampleTrack(track, SAMPLE_PTS);
  const [minLon, minLat, maxLon, maxLat] = bboxOf(sampled, BBOX_PAD_DEG);
  const url =
    `https://graph.mapillary.com/images?access_token=${MAPILLARY_TOKEN}` +
    `&fields=id,thumb_256_url,thumb_1024_url,computed_geometry` +
    `&bbox=${minLon},${minLat},${maxLon},${maxLat}&limit=60`;
  let data;
  try {
    const res = await fetchRetry(url, { timeout: 12000, retries: 1 });
    if (!res.ok) return [];
    data = await res.json();
  } catch {
    return []; // hors-ligne ou requête annulée : repli Commons silencieux
  }
  return (data.data || [])
    .map((img) => {
      const coords = img.computed_geometry?.coordinates;
      if (!coords || !img.thumb_256_url) return null;
      const [lon, lat] = coords;
      const d = distToTrackM(lat, lon, sampled);
      return d <= CORRIDOR_M ? { thumb: img.thumb_256_url, full: img.thumb_1024_url || img.thumb_256_url, d } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_PHOTOS);
}
