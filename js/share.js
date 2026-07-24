// Sancho Rossi — S-V2-PARTAGE : partager un itinéraire à quelqu'un qui n'a pas
// l'appli, sans aucun serveur applicatif (mono-utilisateur, décision actée).
//
// Le SEUL pont possible sans serveur est un lien qui encode l'itinéraire lui-même,
// dans le FRAGMENT de l'URL (`#s=…`) — jamais envoyé au serveur, donc aucun risque de
// 414. La vraie contrainte est la tolérance des messageries (~2000 caractères visés) :
// deux modes, choisis automatiquement selon la forme du tracé —
//   - "w" (waypoints) : un itinéraire PLANIFIÉ partage ses points de passage + repères
//     (quelques centaines d'octets). Le destinataire RE-ROUTE via BRouter
//     (brouterRoute, comme savePlan) → reconstruction exacte, pas une approximation.
//   - "t" (track) : un tracé quelconque (rando OSM, GPX importé, circuit sans
//     waypoints) partage une polyline encodée (algorithme Google, précision 5) d'une
//     version simplifiée (Douglas-Peucker) du tracé — seule solution sans base externe
//     pour un tracé qui n'a pas de points de passage à re-router.
// La pleine fidélité, dans tous les cas, passe par le GPX joint (Web Share) ou
// téléchargé. Ce partage sert aussi de pont entre mes propres appareils (tél ⇄ Mac).
import { state, trackDistanceKm } from "./state.js";
import { trailMarks } from "./fieldmarks.js";
import { ANNOT_KINDS, trackLocator, ANNOT_NEAR_M } from "./annotations.js";
import { brouterRoute } from "./brouter.js";
import { computeGain, computeLoss, naismithHours, fmtDuration, sacRating } from "./metrics.js";
import { trailToGPX, renderAll, selectTrail } from "./trails.js";
import { addMarker } from "./map.js";
import { switchTab } from "./ui.js";
import { saveTraces } from "./storage.js";
import { toast } from "./toast.js";

const BUDGET = 1800; // caractères de payload visés (URL totale sous ~2000, marge messageries)
const DP_START = 0.00003; // ~3 m — tolérance Douglas-Peucker de départ, doublée si le lien dépasse le budget
const DP_MAX_ITERS = 12;

// ---------- base64url (UTF-8 sûr — un repère peut porter des accents/emoji) ----------
function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ---------- Douglas-Peucker (simplification, mode "t") ----------
// Tolérance en degrés (plan, pas géodésique — suffisant pour un seuil de simplification).
export function douglasPeucker(points, tol) {
  if (points.length < 3) return points.slice();
  const sqTol = tol * tol;
  const out = [];
  function simplifySeg(first, last) {
    let maxDist = 0, idx = -1;
    const [lat1, lon1] = points[first], [lat2, lon2] = points[last];
    const dx = lat2 - lat1, dy = lon2 - lon1;
    const norm = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i++) {
      const [lat, lon] = points[i];
      let d;
      if (norm === 0) {
        d = (lat - lat1) ** 2 + (lon - lon1) ** 2;
      } else {
        const t = Math.max(0, Math.min(1, ((lat - lat1) * dx + (lon - lon1) * dy) / norm));
        d = (lat - (lat1 + t * dx)) ** 2 + (lon - (lon1 + t * dy)) ** 2;
      }
      if (d > maxDist) { maxDist = d; idx = i; }
    }
    if (maxDist > sqTol && idx !== -1) {
      simplifySeg(first, idx);
      out.push(points[idx]);
      simplifySeg(idx, last);
    }
  }
  out.push(points[0]);
  simplifySeg(0, points.length - 1);
  out.push(points[points.length - 1]);
  return out;
}

// ---------- Polyline (algorithme Google, précision 5) ----------
function encodeNum(num) {
  let n = num < 0 ? ~(num << 1) : num << 1;
  let out = "";
  while (n >= 0x20) {
    out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
    n >>= 5;
  }
  return out + String.fromCharCode(n + 63);
}
export function encodePolyline(points, precision = 5) {
  const factor = 10 ** precision;
  let out = "", prevLat = 0, prevLon = 0;
  for (const [lat, lon] of points) {
    const la = Math.round(lat * factor), lo = Math.round(lon * factor);
    out += encodeNum(la - prevLat) + encodeNum(lo - prevLon);
    prevLat = la; prevLon = lo;
  }
  return out;
}
export function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  let index = 0, lat = 0, lon = 0;
  const points = [];
  while (index < str.length) {
    let shift = 0, result = 0, byte;
    do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    points.push([lat / factor, lon / factor]);
  }
  return points;
}

const roundCoord = (v) => Math.round(v * 1e5) / 1e5;
const flattenTrack = (t) => (t.segments || [t.track]).flat();
const encodedLength = (payload) => b64urlEncode(JSON.stringify(payload)).length;

// Dégradations appliquées SEULEMENT si le lien dépasse encore le budget, dans l'ordre :
// notes tronquées à 140 puis 40 caractères, notes vidées, repères retirés en dernier
// recours. Chaque étape renvoie si elle a changé quelque chose (pour le flag `approx`).
const degradeSteps = [
  (p) => { let hit = false; p.pois.forEach((x) => { if (x[3].length > 140) { x[3] = x[3].slice(0, 140); hit = true; } }); return hit; },
  (p) => { let hit = false; p.pois.forEach((x) => { if (x[3].length > 40) { x[3] = x[3].slice(0, 40); hit = true; } }); return hit; },
  (p) => { const hit = p.pois.some((x) => x[3]); p.pois.forEach((x) => (x[3] = "")); return hit; },
  (p) => { const hit = p.pois.length > 0; p.pois = []; return hit; },
];

function finalize(payload, approxIn = false) {
  let approx = approxIn;
  let step = 0;
  while (encodedLength(payload) > BUDGET && step < degradeSteps.length) {
    if (degradeSteps[step](payload)) approx = true;
    step++;
  }
  const encoded = b64urlEncode(JSON.stringify(payload));
  return { url: `${location.origin}${location.pathname}#s=${encoded}`, approx };
}

// `trailLike` accepte un vrai trail (fiche) OU un objet léger construit à la volée
// depuis l'état live du planificateur (pas besoin d'enregistrer avant de partager).
export function buildShareUrl(trailLike) {
  const name = trailLike.name || "Itinéraire";
  const pois = trailMarks(trailLike).map((m) => [
    ANNOT_KINDS[m.kind] ? m.kind : "note", roundCoord(m.lat), roundCoord(m.lon), m.note || "",
  ]);

  if (Array.isArray(trailLike.waypoints) && trailLike.waypoints.length >= 2) {
    const payload = {
      v: 1, mo: "w", n: name,
      w: trailLike.waypoints.map((w) => [roundCoord(w.lat), roundCoord(w.lon), w.name || ""]),
      pois,
    };
    return finalize(payload);
  }

  const track = flattenTrack(trailLike);
  let tol = DP_START;
  let approxGeom = false;
  let simplified = douglasPeucker(track, tol);
  let p = encodePolyline(simplified);
  for (let i = 0; i < DP_MAX_ITERS && encodedLength({ v: 1, mo: "t", n: name, p, pois }) > BUDGET; i++) {
    tol *= 2;
    simplified = douglasPeucker(track, tol);
    p = encodePolyline(simplified);
    approxGeom = true;
  }
  // Filet de sécurité : un tracé très dense et irrégulier (bruit GPS, virages serrés
  // rapprochés) peut résister à Douglas-Peucker — la distance perpendiculaire à la corde
  // reste grande même à forte tolérance. On garantit malgré tout la convergence par
  // décimation uniforme (un point sur deux, itéré) une fois la géométrie déjà simplifiée.
  while (encodedLength({ v: 1, mo: "t", n: name, p, pois }) > BUDGET && simplified.length > 2) {
    simplified = simplified.filter((_, i) => i % 2 === 0 || i === simplified.length - 1);
    p = encodePolyline(simplified);
    approxGeom = true;
  }
  return finalize({ v: 1, mo: "t", n: name, p, pois }, approxGeom);
}

// ---------- Partage (fiche + planificateur) ----------
export async function shareTrail(trailLike) {
  const { url, approx } = buildShareUrl(trailLike);
  let gpxFile = null;
  try {
    gpxFile = new File(
      [trailToGPX(trailLike)],
      `${(trailLike.name || "itineraire").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w-]+/g, "_")}.gpx`,
      { type: "application/gpx+xml" }
    );
  } catch { /* File indisponible : on se rabat sur le lien seul */ }

  const shareData = { title: trailLike.name || "Itinéraire Sancho Rossi", text: `Itinéraire « ${trailLike.name} » — Sancho Rossi`, url };
  if (navigator.share) {
    try {
      if (gpxFile && navigator.canShare?.({ files: [gpxFile] })) await navigator.share({ ...shareData, files: [gpxFile] });
      else await navigator.share(shareData);
      if (approx) toast("Lien simplifié pour tenir dans un message.", { type: "info" });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return; // annulation utilisateur : silence, pas d'erreur
      // autre échec (ex. pas de permission) : on retombe sur le copier-coller ci-dessous
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(approx ? "Lien copié (simplifié pour tenir dans un message)." : "Lien copié — collez-le à votre contact.", { type: "success" });
  } catch {
    toast("Impossible de copier le lien de partage.", { type: "error" });
  }
}

// ---------- Réception d'un lien ----------
function decodePois(tuples, track, distanceKm) {
  if (!tuples?.length) return [];
  const locate = trackLocator(track, distanceKm);
  return tuples.map(([kind, lat, lon, note]) => {
    const p = locate?.(lat, lon);
    return {
      kind: ANNOT_KINDS[kind] ? kind : "note",
      note: note || "",
      lat, lon,
      km: p && p.offM <= ANNOT_NEAR_M ? Math.round(p.km * 10) / 10 : null,
    };
  });
}

function newSharedId() {
  return `shared-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// Mode "w" : re-route via BRouter, exactement comme `savePlan()` (planner.js) —
// reconstruction géométrique exacte, pas une approximation de la polyline.
async function buildFromWaypoints(payload) {
  const waypoints = payload.w.map(([lat, lon, name]) => ({ lat, lon, name: name || null }));
  const r = await brouterRoute(waypoints.map((w) => [w.lat, w.lon]));
  const track = r.track;
  const gain = r.eles ? computeGain(r.eles) : null;
  const loss = r.eles ? computeLoss(r.eles) : null;
  const altMax = r.eles ? Math.round(Math.max(...r.eles)) : null;
  const dist = Math.round(r.distance * 10) / 10;
  const hours = naismithHours(dist, gain || 0);
  const sac = sacRating({ ways: r.ways, eles: r.eles, track });
  const pois = decodePois(payload.pois, track, dist);
  return {
    id: newSharedId(), imported: true, custom: true,
    eles: r.eles && r.eles.length === track.length ? r.eles.map((e) => Math.round(e)) : undefined,
    name: payload.n || "Itinéraire partagé",
    waypoints,
    location: "Itinéraire reçu par lien", region: "Mes itinéraires",
    difficulty: "personnalisé", type: "itinéraire", days: null, bivouac: false,
    distance: dist, elevationGain: gain, elevationLoss: loss, altMax,
    duration: fmtDuration(hours), sac, ways: r.ways, pois,
    center: track[Math.floor(track.length / 2)],
    gradient: "linear-gradient(135deg, #3a3a40, #6a6a72)",
    description: `Itinéraire reçu par lien de partage — ${dist} km` +
      (gain != null ? ` · ${gain} m D+` : "") +
      (pois.length ? ` · ${pois.length} repère${pois.length > 1 ? "s" : ""}` : "") + ".",
    eau: "—", bivouacSpot: "—", periode: "—",
    track, segments: [track],
  };
}

// Mode "t" : géométrie déjà simplifiée pour tenir dans le lien — pas d'altitudes
// (relevées paresseusement par `ensureElevation` à l'affichage, comme un GPX/OSM).
function buildFromTrack(payload) {
  const track = decodePolyline(payload.p);
  if (track.length < 2) throw new Error("tracé vide ou corrompu");
  const dist = Math.round(trackDistanceKm(track) * 10) / 10;
  const pois = decodePois(payload.pois, track, dist);
  return {
    id: newSharedId(), imported: true,
    name: payload.n || "Itinéraire partagé",
    location: "Itinéraire reçu par lien", region: "Mes itinéraires",
    difficulty: "importé", type: "importé", days: null, bivouac: false,
    distance: dist, elevationGain: null, altMax: null, duration: "—",
    center: track[Math.floor(track.length / 2)],
    gradient: "linear-gradient(135deg, #2d6a2f, #71b280)",
    description: `Itinéraire reçu par lien de partage — ${dist} km (tracé simplifié pour le partage)` +
      (pois.length ? ` · ${pois.length} repère${pois.length > 1 ? "s" : ""}` : "") + ".",
    eau: "—", bivouacSpot: "—", periode: "—",
    track, pois,
  };
}

async function doImport(payload) {
  try {
    const trail = payload.mo === "w" ? await buildFromWaypoints(payload) : buildFromTrack(payload);
    state.imported.unshift(trail);
    await saveTraces(state.imported);
    addMarker(trail);
    renderAll();
    switchTab("carte");
    selectTrail(trail.id);
    toast(`« ${trail.name} » importé dans Mes itinéraires.`, { type: "success" });
  } catch (err) {
    toast(`Import impossible : ${err.message || err}.`, { type: "error" });
  }
}

// Lit le fragment `#s=…` au boot, le retire IMMÉDIATEMENT de l'URL (un rechargement
// ne redéclenche pas l'import) et renvoie le payload décodé, ou null (rien à importer,
// ou lien corrompu — signalé par un toast plutôt que de planter).
export function decodeShareFromLocation() {
  const m = /^#s=(.+)$/.exec(location.hash);
  if (!m) return null;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const payload = JSON.parse(b64urlDecode(m[1]));
    if (payload?.v !== 1 || (payload.mo !== "w" && payload.mo !== "t")) throw new Error("format inconnu");
    return payload;
  } catch {
    toast("Lien de partage invalide ou corrompu.", { type: "error" });
    return null;
  }
}

function showImportModal(payload) {
  const modal = document.getElementById("share-import-modal");
  if (!modal) return;
  const poiCount = payload.pois?.length || 0;
  const distLabel = payload.mo === "w"
    ? "Distance calculée après import (re-routage sur les sentiers)."
    : `${trackDistanceKm(decodePolyline(payload.p)).toFixed(1)} km (tracé simplifié pour le partage).`;
  modal.querySelector("#share-import-name").textContent = payload.n || "Itinéraire partagé";
  modal.querySelector("#share-import-meta").textContent =
    distLabel + (poiCount ? ` ${poiCount} repère${poiCount > 1 ? "s" : ""}.` : "");
  modal.classList.remove("hidden");

  const close = () => modal.classList.add("hidden");
  modal.querySelector("#share-import-cancel").addEventListener("click", close, { once: true });
  modal.querySelector("#share-import-cancel-2").addEventListener("click", close, { once: true });
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); }, { once: true });
  modal.querySelector("#share-import-confirm").addEventListener("click", async () => {
    close();
    await doImport(payload);
  }, { once: true });
}

// Point d'entrée boot (main.js) : lien de partage détecté → modale de confirmation.
export function checkIncomingShare() {
  const payload = decodeShareFromLocation();
  if (payload) showImportModal(payload);
}
