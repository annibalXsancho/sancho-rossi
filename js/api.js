// Sancho Rossi — appels API partagés (Overpass, Open-Meteo Elevation)
import { state, trackOf, sampleTrack } from "./state.js";

// Interrogation Overpass avec miroir de secours en cas de saturation (429)
export async function overpassFetch(query) {
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  let lastErr;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// ---------- Altitudes réelles (API Open-Meteo Elevation) ----------
export async function ensureElevation(trail) {
  if (trail.eles?.length > 1) return trail.eles;
  if (state.elev[trail.id]) return state.elev[trail.id].eles;
  // Profil calculé sur le fil principal du tracé (chaîné), pas sur les segments épars
  const pts = sampleTrack(trail.mainline || trackOf(trail));
  const url =
    `https://api.open-meteo.com/v1/elevation` +
    `?latitude=${pts.map((p) => p[0].toFixed(5)).join(",")}` +
    `&longitude=${pts.map((p) => p[1].toFixed(5)).join(",")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Elevation ${res.status}`);
  const eles = (await res.json()).elevation;

  // D+ avec seuil de 4 m pour lisser le bruit du modèle de terrain
  let gain = 0;
  let ref = eles[0];
  for (const e of eles) {
    if (e - ref > 4) { gain += e - ref; ref = e; }
    else if (ref - e > 4) ref = e;
  }
  state.elev[trail.id] = { eles, gain: Math.round(gain), max: Math.round(Math.max(...eles)) };
  localStorage.setItem("sr-elev", JSON.stringify(state.elev));
  return eles;
}
