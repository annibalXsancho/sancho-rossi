// Sancho Rossi — état central et utilitaires de tracés
// Seul module autorisé en import top-level par les autres (feuille sans dépendance).

// Graine curatée embarquée (script classique data.js, environnement lexical global).
export const BASE_TRAILS = typeof TRAILS !== "undefined" ? TRAILS : [];

export const state = {
  view: "accueil",
  search: "",
  days: "",
  difficulty: "",
  region: "",
  type: "",
  source: "",
  distMin: null,
  distMax: null,
  gainMax: null,
  sortBy: "reco",
  favoritesOnly: false,
  selectedId: null,
  favorites: new Set(JSON.parse(localStorage.getItem("sr-favorites") || "[]")),
  notes: JSON.parse(localStorage.getItem("sr-notes") || "{}"),
  // Objets volumineux : chargés depuis IndexedDB au boot (loadPersisted), voir storage.js
  imported: [],
  photos: {},
  elev: {},
  contacts: JSON.parse(localStorage.getItem("sr-contacts") || "[]"),
  lastPos: JSON.parse(localStorage.getItem("sr-lastpos") || "null"),
  // Catalogue OSM chargé à la demande selon la zone (S3), dédup par id de relation.
  catalog: new Map(),
};

// Tracés balisés actuellement chargés (Map id → trail).
export function catalogTrails() {
  return [...state.catalog.values()];
}

export function allTrails() {
  return [...state.imported, ...BASE_TRAILS, ...catalogTrails()];
}

export function getTrail(id) {
  return allTrails().find((t) => t.id === id);
}

export function trackOf(t) {
  return t.track || t.segments.flat();
}

// Les membres d'une relation OSM arrivent dans un ordre arbitraire :
// on reconstitue le fil du tracé par chaînage des extrémités les plus proches.
export function orderSegments(segments) {
  const near2 = 0.003 ** 2; // ~300 m : tolère les petites coupures du balisage
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  const segs = segments.filter((s) => s.length > 1).map((s) => s.slice());
  if (!segs.length) return [segments.flat()];
  const chains = [];
  let cur = segs.shift();
  while (segs.length) {
    const end = cur[cur.length - 1];
    let best = -1, bestD = Infinity, rev = false;
    segs.forEach((s, i) => {
      const d0 = d2(end, s[0]);
      const d1 = d2(end, s[s.length - 1]);
      if (d0 < bestD) { bestD = d0; best = i; rev = false; }
      if (d1 < bestD) { bestD = d1; best = i; rev = true; }
    });
    if (bestD < near2) {
      const s = segs.splice(best, 1)[0];
      if (rev) s.reverse();
      cur = cur.concat(s);
    } else {
      chains.push(cur);
      cur = segs.shift();
    }
  }
  chains.push(cur);
  chains.sort((a, b) => b.length - a.length);
  return chains;
}

export function normalizeOsmTrail(t) {
  if (!t.segments) return t;
  const chains = orderSegments(t.segments);
  t.segments = chains;
  t.mainline = chains[0];
  t.track = chains.flat();
  return t;
}

// ---------- Utilitaires géo purs ----------
export function sampleTrack(track, n = 100) {
  if (track.length <= n) return track;
  const out = [];
  for (let i = 0; i < n; i++) out.push(track[Math.round((i * (track.length - 1)) / (n - 1))]);
  return out;
}

export function haversineKm([lat1, lon1], [lat2, lon2]) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function trackDistanceKm(track) {
  let d = 0;
  for (let i = 1; i < track.length; i++) d += haversineKm(track[i - 1], track[i]);
  return d;
}

// ---------- Notes personnelles ----------
export function saveNote(id, text) {
  if (text.trim()) state.notes[id] = text;
  else delete state.notes[id];
  localStorage.setItem("sr-notes", JSON.stringify(state.notes));
}
