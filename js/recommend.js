// Sancho Rossi — recommandations « Idées du week-end » (S9)
// L'accueil propose 3–5 idées datées selon la saison, la météo du week-end à venir et
// l'historique de favoris. Hors-ligne : repli saison + favoris, sans badge météo.
import { state, allTrails } from "./state.js";
import { cardHTML } from "./trails.js";

const MONTHS = {
  janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11,
  décembre: 12, decembre: 12,
};

// Code WMO → icône + score de confort (sec/ensoleillé haut, pluie/neige/orage bas).
const WMO_SIMPLE = [
  [[0, 1], "☀️", 3], [[2], "🌤", 2], [[3], "☁️", 1], [[45, 48], "🌫", 0],
  [[51, 53, 55, 56, 57], "🌦", -1], [[61, 63, 65, 66, 67, 80, 81, 82], "🌧", -3],
  [[71, 73, 75, 77, 85, 86], "🌨", -4], [[95, 96, 99], "⛈", -5],
];
function wxInfo(code) {
  const f = WMO_SIMPLE.find(([codes]) => codes.includes(code));
  return f ? { icon: f[1], score: f[2] } : { icon: "❓", score: 0 };
}

// Fenêtre de saison conseillée depuis le champ periode (« Fin juin à fin septembre »).
// Renvoie +3 en saison, -4 hors saison, 0 si inconnue (tracés OSM notamment).
function seasonScore(t) {
  const p = (t.periode || "").toLowerCase();
  if (!p || p === "—") return 0;
  const found = [];
  for (const [name, n] of Object.entries(MONTHS)) if (p.includes(name)) found.push(n);
  if (!found.length) return 0;
  const lo = Math.min(...found), hi = Math.max(...found);
  const m = new Date().getMonth() + 1;
  const inWindow = lo <= hi ? m >= lo && m <= hi : m >= lo || m <= hi;
  return inWindow ? 3 : -4;
}

// Week-end à venir (samedi + dimanche). Dimanche → week-end suivant.
function weekend() {
  const now = new Date();
  const satOff = (6 - now.getDay() + 7) % 7;
  const sat = new Date(now);
  sat.setDate(now.getDate() + satOff);
  sat.setHours(0, 0, 0, 0);
  const sun = new Date(sat);
  sun.setDate(sat.getDate() + 1);
  return { sat, sun, satOff };
}

const fmtDay = (d) => d.toLocaleDateString("fr-FR", { day: "numeric" });
const fmtMonth = (d) => d.toLocaleDateString("fr-FR", { month: "short" }).replace(".", "");

// Profil des favoris : régions et difficultés déjà aimées (biais de recommandation).
function favProfile() {
  const regions = new Set(), diffs = new Set();
  for (const t of allTrails()) {
    if (!state.favorites.has(t.id)) continue;
    if (t.region) regions.add(t.region);
    if (t.difficulty) diffs.add(t.difficulty);
  }
  return { regions, diffs };
}

// Petit hash stable [0,1) par id, combiné à `seed` pour la re-mélange (« Autre sélection »).
function hashId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}
let seed = 0;

function baseCandidates() {
  return allTrails().filter((t) => t.center && (t.track || t.segments) && t.distance);
}

function scoreTrail(t, prof) {
  let s = seasonScore(t);
  if (t.bivouac) s += 1;                       // l'esprit du produit garde un léger goût bivouac
  if (prof.regions.has(t.region)) s += 2;      // massifs déjà aimés
  if (prof.diffs.has(t.difficulty)) s += 1;    // niveau habituel
  if (state.favorites.has(t.id)) s -= 1.5;     // « surprends-moi » : privilégier le neuf
  return s + Math.abs(Math.sin(seed + hashId(t.id))) * 1.5;
}

// Météo du week-end pour un lot de tracés — un seul appel Open-Meteo multi-points.
async function weekendWeather(trails, wk) {
  const lat = trails.map((t) => t.center[0].toFixed(3)).join(",");
  const lon = trails.map((t) => t.center[1].toFixed(3)).join(",");
  const days = Math.min(16, wk.satOff + 2);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=weather_code,temperature_2m_max,precipitation_sum&timezone=auto&forecast_days=${days}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  let data = await res.json();
  if (!Array.isArray(data)) data = [data];
  const satISO = wk.sat.toISOString().slice(0, 10);
  return trails.map((_, i) => {
    const d = data[i]?.daily;
    if (!d) return null;
    const si = d.time.indexOf(satISO);
    if (si < 0) return null;
    let best = null;
    for (const k of [si, si + 1]) {
      if (k >= d.time.length) continue;
      const wi = wxInfo(d.weather_code[k]);
      const rain = d.precipitation_sum[k] || 0;
      const cand = {
        icon: wi.icon,
        temp: Math.round(d.temperature_2m_max[k]),
        score: wi.score - Math.min(4, rain / 3),
        day: k === si ? "sam" : "dim",
      };
      if (!best || cand.score > best.score) best = cand;
    }
    return best;
  });
}

export async function renderRecommendations() {
  const el = document.getElementById("home-suggestions");
  if (!el) return;
  const titleEl = document.getElementById("reco-title");
  const wk = weekend();
  const range =
    wk.sat.getMonth() === wk.sun.getMonth()
      ? `${fmtDay(wk.sat)}–${fmtDay(wk.sun)} ${fmtMonth(wk.sun)}`
      : `${fmtDay(wk.sat)} ${fmtMonth(wk.sat)} – ${fmtDay(wk.sun)} ${fmtMonth(wk.sun)}`;
  if (titleEl) titleEl.textContent = `Idées pour le week-end du ${range}`;

  const prof = favProfile();
  const scored = baseCandidates()
    .map((t) => ({ t, s: scoreTrail(t, prof) }))
    .sort((a, b) => b.s - a.s);

  if (!scored.length) {
    el.innerHTML =
      `<div class="empty-state"><div class="empty-icon">🧭</div>` +
      `<p>Ouvrez la carte et chargez une zone pour voir des idées.</p></div>`;
    return;
  }

  // Enrichissement météo sur le meilleur lot, puis re-classement.
  const pool = scored.slice(0, 8);
  let wx;
  try {
    wx = await weekendWeather(pool.map((x) => x.t), wk);
  } catch {
    wx = pool.map(() => null);
  }
  const withWx = pool
    .map((x, i) => ({ t: x.t, wx: wx[i], s: x.s + (wx[i] ? wx[i].score * 1.2 : 0) }))
    .sort((a, b) => b.s - a.s);

  // Diversité : au plus 2 idées par massif, 3 à 5 au total.
  const picked = [], perRegion = new Map();
  for (const c of withWx) {
    const r = c.t.region || "?";
    if ((perRegion.get(r) || 0) >= 2) continue;
    perRegion.set(r, (perRegion.get(r) || 0) + 1);
    picked.push(c);
    if (picked.length >= 5) break;
  }
  for (const c of withWx) {
    if (picked.length >= Math.min(3, withWx.length)) break;
    if (!picked.includes(c)) picked.push(c);
  }

  el.innerHTML = picked
    .map(
      ({ t, wx }) => `
    <div class="reco-card">
      ${wx ? `<span class="reco-wx" title="Prévu ${wx.day} sur le départ">${wx.icon} ${wx.temp}° ${wx.day}</span>` : ""}
      ${cardHTML(t)}
    </div>`
    )
    .join("");
}

export function initRecommend() {
  document.getElementById("reco-shuffle")?.addEventListener("click", () => {
    seed += 1.7;
    renderRecommendations();
  });
}
