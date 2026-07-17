// Sancho Rossi — conditions du sentier + risque d'orage (S-CONDITIONS)
//
// La météo à l'heure de passage (S-METEO) dit « quel temps il fera au km 12 ». Ce
// module répond à l'autre question, celle de la préparation et de la sécurité : « à
// quoi dois-je m'attendre AU SOL et faut-il partir tôt ? ». Il croise le profil
// altimétrique du tracé (altitude min/max réelles) avec Open-Meteo et l'API qualité
// de l'air (toutes deux gratuites, sans clé, couverture Europe) pour en tirer des
// AVERTISSEMENTS — jamais un bulletin complet :
//   • neige      — `freezing_level_height` : si le tracé monte au-dessus de l'isotherme
//                  0 °C de la journée → « neige probable au-dessus de ~N m » ;
//   • boue       — cumul de pluie des 3 jours précédant le départ (`precipitation_sum`) ;
//   • chaleur    — T° max du jour à l'altitude basse du tracé (canicule) ;
//   • gel        — T° min à l'altitude haute, hors neige ;
//   • UV         — `uv_index` (API qualité de l'air) sur la fenêtre de marche ;
//   • air        — `european_aqi` (CAMS) ;
//   • pollens    — espèces CAMS (Europe) ;
//   • orages     — `cape` + code/probabilité horaire → créneau de départ conseillé.
//
// Parti pris ÉPURÉ dicté par le ROADMAP : les badges ne s'affichent QUE s'ils sont
// actifs. Une belle journée d'automne = bandeau vide (rien affiché), pas un « tout va
// bien ». Chaque badge est indépendamment gardé : une donnée manquante (pas d'altitude
// hors-ligne, API air en panne, hors couverture pollens) fait disparaître SON badge,
// jamais inventer. Bâti sur la primitive `.info-block` (grammaire S-UX-SYSTÈME), même
// contrat offline que S5/S-METEO : snapshot daté `cond:<id>` écrit par offline.js.
import { state, trackOf, sampleTrack } from "./state.js";
import { computeGain, naismithHours } from "./metrics.js";
import { fetchRetry } from "./net.js";
import { getSharedDepart, subscribeDepart } from "./hikeweather.js";
import { putPackMeta, getPackMeta } from "./storage.js";

// ---------- Seuils (choix produit, un seul endroit) ----------
const SNOW_MARGIN_M = 100;   // le tracé « touche » la neige dès 100 m sous l'isotherme 0
const MUD_MM = 20;           // cumul pluie 3 j au-delà duquel le sentier est jugé boueux
const HEAT_C = 30;           // forte chaleur en vallée
const CANICULE_C = 34;       // canicule
const FROST_C = -2;          // gel marqué en altitude (hors badge neige)
const UV_HIGH = 6, UV_VHIGH = 8;
const AQI_POOR = 60, AQI_VPOOR = 80;
const CAPE_STORM = 800;      // J/kg — énergie convective propice aux orages
const STORM_PROBA = 40;      // % de probabilité de précipitation concomitante
const THUNDER_CODES = new Set([95, 96, 99]);
const DAY_START = 6, DAY_END = 21; // heures « de jour » où l'on borne les fenêtres
const SNAPSHOT = 5;          // horizon (jours) embarqué dans un pack offline

// Espèces de pollens CAMS + seuil « élevé » (grains/m³) + libellé.
const POLLEN = [
  { key: "grass_pollen",   label: "graminées", high: 30 },
  { key: "birch_pollen",   label: "bouleau",   high: 90 },
  { key: "alder_pollen",   label: "aulne",     high: 90 },
  { key: "olive_pollen",   label: "olivier",   high: 90 },
  { key: "ragweed_pollen", label: "ambroisie", high: 20 },
  { key: "mugwort_pollen", label: "armoise",   high: 30 },
];

const SEV_RANK = { alert: 0, warn: 1, info: 2 };
const round50 = (m) => Math.round(m / 50) * 50;
const dayLabelOf = (d) => d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });

// ---------- Géométrie du tracé : altitudes réelles + points d'intérêt ----------
// Aligne track et eles (comme buildTimeline de hikeweather : les points OSM/BRouter ne
// sont pas équidistants) puis relève le point le plus BAS (vallée, le plus chaud), le
// plus HAUT (crête, le plus froid/enneigé) et le milieu (requête air/pollens).
function geometry(track, eles) {
  const pts = eles && track.length === eles.length ? track
    : eles ? sampleTrack(track, eles.length) : track;
  if (!eles || pts.length !== eles.length) {
    const mid = track[Math.floor(track.length / 2)];
    return { hasEle: false, low: track[0], high: track[0], mid, altMin: null, altMax: null };
  }
  let lo = 0, hi = 0;
  for (let i = 1; i < eles.length; i++) {
    if (eles[i] < eles[lo]) lo = i;
    if (eles[i] > eles[hi]) hi = i;
  }
  return {
    hasEle: true,
    low: pts[lo], high: pts[hi], mid: pts[Math.floor(pts.length / 2)],
    altMin: Math.round(eles[lo]), altMax: Math.round(eles[hi]),
  };
}

// Durée de marche (Naismith/Tobler) pour caler le créneau anti-orage et la fenêtre UV.
function durationH(eles, totalKm) {
  if (eles && eles.length > 1) return naismithHours(totalKm || 0, computeGain(eles));
  return totalKm ? totalKm / 4.5 : 3;
}

// ---------- Fenêtres temporelles dans une réponse horaire ----------
// Index de minuit du jour de départ dans le tableau horaire, ou null si hors fenêtre.
function midnightIndex(hourly, depart) {
  if (!hourly?.time?.length) return null;
  const i0 = Math.round((depart - new Date(hourly.time[0])) / 3600000);
  if (i0 < 0 || i0 >= hourly.time.length) return null;
  return i0 - depart.getHours(); // recule à 00:00 du jour de départ
}

// Indices [i0, i1) des heures de la MARCHE (départ → arrivée) : la météo qu'on
// SUBIRA (UV, air, pollens, neige/gel à l'altitude atteinte).
function hikeWindow(hourly, depart, durH) {
  const base = midnightIndex(hourly, depart);
  if (base == null) return null;
  const startH = Math.max(DAY_START, depart.getHours());
  const endH = Math.min(DAY_END, depart.getHours() + Math.ceil(durH));
  return [Math.max(0, base + startH), Math.min(hourly.time.length, base + endH + 1)];
}

// Indices [i0, i1) de toute la journée de jour : sert au balayage des ORAGES, qui doit
// voir l'après-midi même pour un départ matinal, afin de conseiller l'heure de départ.
function dayWindow(hourly, depart) {
  const base = midnightIndex(hourly, depart);
  if (base == null) return null;
  return [Math.max(0, base + DAY_START), Math.min(hourly.time.length, base + DAY_END + 1)];
}

const maxIn = (arr, w, def = -Infinity) => {
  if (!arr) return null;
  let m = def;
  for (let i = w[0]; i < w[1]; i++) if (arr[i] != null && arr[i] > m) m = arr[i];
  return m === def ? null : m;
};
const minIn = (arr, w, def = Infinity) => {
  if (!arr) return null;
  let m = def;
  for (let i = w[0]; i < w[1]; i++) if (arr[i] != null && arr[i] < m) m = arr[i];
  return m === def ? null : m;
};

// ---------- Requêtes réseau (cache de session par points + jour) ----------
const fcCache = new Map();
const aqCache = new Map();

function daysUntil(depart) {
  const d = Math.floor((new Date(depart).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  return d;
}

async function fetchForecast(geo, depart) {
  const days = Math.max(2, Math.min(7, daysUntil(depart) + 2));
  const lats = [geo.low[0], geo.high[0]].map((v) => v.toFixed(3));
  const lons = [geo.low[1], geo.high[1]].map((v) => v.toFixed(3));
  const key = `${lats.join(",")};${lons.join(",")}|${days}|${geo.altMin},${geo.altMax}`;
  if (fcCache.has(key)) return fcCache.get(key);
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lats.join(",")}&longitude=${lons.join(",")}` +
    (geo.hasEle ? `&elevation=${geo.altMin},${geo.altMax}` : "") +
    `&hourly=temperature_2m,precipitation_probability,weather_code,cape,freezing_level_height,snow_depth` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,uv_index_max` +
    `&past_days=3&forecast_days=${days}&timezone=auto`;
  const p = (async () => {
    const res = await fetchRetry(url, { timeout: 15000 });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    let data = await res.json();
    if (!Array.isArray(data)) data = [data];
    return data; // [bas, haut]
  })();
  fcCache.set(key, p);
  p.catch(() => fcCache.delete(key));
  return p;
}

// Qualité de l'air / UV / pollens : best-effort (une panne fait juste disparaître ces
// badges). CAMS Europe seulement pour les pollens → null hors zone, géré à la lecture.
async function fetchAir(geo, depart) {
  const days = Math.max(1, Math.min(7, daysUntil(depart) + 2));
  const key = `${geo.mid[0].toFixed(3)},${geo.mid[1].toFixed(3)}|${days}`;
  if (aqCache.has(key)) return aqCache.get(key);
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality` +
    `?latitude=${geo.mid[0].toFixed(3)}&longitude=${geo.mid[1].toFixed(3)}` +
    `&hourly=european_aqi,uv_index,${POLLEN.map((p) => p.key).join(",")}` +
    `&forecast_days=${days}&timezone=auto`;
  const p = (async () => {
    const res = await fetchRetry(url, { timeout: 15000, retries: 1 });
    if (!res.ok) throw new Error(`Air ${res.status}`);
    return res.json();
  })();
  aqCache.set(key, p);
  p.catch(() => aqCache.delete(key));
  return p;
}

// ---------- Décision (PURE : aucun réseau, testable en isolation) ----------
// Construit la liste des badges actifs à partir de la géométrie du tracé, de la durée,
// du départ et des réponses météo/air déjà récupérées. Chaque badge est indépendamment
// gardé : une donnée manquante fait disparaître SON badge, jamais inventer.
export function assess({ geo, durH, depart, fc, air }) {
  const badges = [];
  const dayLabel = dayLabelOf(depart);
  const low = fc[0], high = fc[1] || fc[0];
  const wHigh = hikeWindow(high.hourly, depart, durH);
  const dayStr = `${depart.getFullYear()}-${String(depart.getMonth() + 1).padStart(2, "0")}-${String(depart.getDate()).padStart(2, "0")}`;
  const dIdx = low.daily?.time?.indexOf(dayStr) ?? -1;

  // 1. NEIGE — le tracé monte-t-il au-dessus de l'isotherme 0 °C du jour ?
  if (geo.hasEle && wHigh) {
    const fl = minIn(high.hourly.freezing_level_height, wHigh);
    if (fl != null && geo.altMax > fl - SNOW_MARGIN_M) {
      const line = Math.max(0, round50(fl));
      const snowGround = maxIn(high.hourly.snow_depth, wHigh); // mètres, indicatif
      badges.push({
        icon: "❄️", sev: "alert",
        text: `Neige probable au-dessus de ~${line.toLocaleString("fr-FR")} m` +
          (snowGround != null && snowGround >= 0.05 ? ` — neige au sol vers ${geo.altMax.toLocaleString("fr-FR")} m` : "") +
          ` (sommet du tracé ${geo.altMax.toLocaleString("fr-FR")} m)`,
      });
    }
  }

  // 8. ORAGES — première heure de jour à risque → créneau de départ conseillé.
  const wDay = dayWindow(low.hourly, depart);
  if (wDay) {
    const { hourly } = low;
    let firstRisk = null;
    for (let i = wDay[0]; i < wDay[1]; i++) {
      const code = hourly.weather_code?.[i];
      const cape = hourly.cape?.[i] ?? 0;
      const proba = hourly.precipitation_probability?.[i] ?? 0;
      if (THUNDER_CODES.has(code) || (cape >= CAPE_STORM && proba >= STORM_PROBA)) {
        firstRisk = new Date(hourly.time[i]).getHours();
        break;
      }
    }
    if (firstRisk != null) {
      const latest = firstRisk - Math.ceil(durH) - 1; // finir 1 h avant le risque
      const advice = latest >= DAY_START
        ? `viser un départ avant ${latest} h`
        : `créneau trop court aujourd'hui — envisager un autre jour`;
      badges.push({ icon: "⚡", sev: "alert", text: `Orages probables dès ${firstRisk} h — ${advice}` });
    }
  }

  // 3. CHALEUR — T° max du jour à l'altitude basse (vallée).
  if (dIdx >= 0) {
    const tmax = low.daily.temperature_2m_max?.[dIdx];
    if (tmax != null && tmax >= CANICULE_C) {
      badges.push({ icon: "🥵", sev: "alert", text: `Canicule — ${Math.round(tmax)}° en vallée, partir à la fraîche et emporter beaucoup d'eau` });
    } else if (tmax != null && tmax >= HEAT_C) {
      badges.push({ icon: "🔥", sev: "warn", text: `Forte chaleur — ${Math.round(tmax)}° en vallée, prévoir de l'eau` });
    }
  }

  // 4. GEL en altitude (seulement si pas déjà signalé par la neige).
  if (geo.hasEle && wHigh && !badges.some((b) => b.icon === "❄️")) {
    const tmin = minIn(high.hourly.temperature_2m, wHigh);
    if (tmin != null && tmin <= FROST_C) {
      badges.push({ icon: "🧊", sev: "warn", text: `Gel en altitude — ${Math.round(tmin)}° vers ${geo.altMax.toLocaleString("fr-FR")} m` });
    }
  }

  // 2. BOUE — cumul de pluie des 3 jours précédant le départ.
  if (dIdx >= 3) {
    const ps = low.daily.precipitation_sum;
    const sum = (ps[dIdx - 1] ?? 0) + (ps[dIdx - 2] ?? 0) + (ps[dIdx - 3] ?? 0);
    if (sum >= MUD_MM) {
      badges.push({ icon: "🟤", sev: "info", text: `Sentier probablement boueux — ${Math.round(sum)} mm de pluie sur 3 jours` });
    }
  }

  // 5. UV — API qualité de l'air (repli sur uv_index_max prévisionnel).
  let uv = air?.hourly ? maxIn(air.hourly.uv_index, hikeWindow(air.hourly, depart, durH) || [0, 0]) : null;
  if (uv == null && dIdx >= 0) uv = low.daily.uv_index_max?.[dIdx] ?? null;
  if (uv != null && uv >= UV_VHIGH) {
    badges.push({ icon: "☀️", sev: "warn", text: `UV très élevés (indice ${Math.round(uv)}) — crème, lunettes, couvre-chef` });
  } else if (uv != null && uv >= UV_HIGH) {
    badges.push({ icon: "☀️", sev: "info", text: `UV élevés (indice ${Math.round(uv)}) — protection conseillée` });
  }

  // 6. QUALITÉ DE L'AIR (CAMS european_aqi).
  if (air?.hourly) {
    const wAir = hikeWindow(air.hourly, depart, durH);
    const aqi = wAir ? maxIn(air.hourly.european_aqi, wAir) : null;
    if (aqi != null && aqi >= AQI_VPOOR) {
      badges.push({ icon: "😷", sev: "warn", text: `Air très dégradé (indice ${Math.round(aqi)})` });
    } else if (aqi != null && aqi >= AQI_POOR) {
      badges.push({ icon: "😷", sev: "info", text: `Air médiocre (indice ${Math.round(aqi)})` });
    }

    // 7. POLLENS (CAMS Europe — null hors zone, badge alors absent).
    if (wAir) {
      let worst = null;
      for (const sp of POLLEN) {
        const v = maxIn(air.hourly[sp.key], wAir);
        if (v != null && v >= sp.high && (!worst || v / sp.high > worst.ratio)) {
          worst = { label: sp.label, ratio: v / sp.high };
        }
      }
      if (worst) badges.push({ icon: "🤧", sev: "info", text: `Pollens élevés — ${worst.label}` });
    }
  }

  badges.sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev]);
  return { badges, dayLabel };
}

// ---------- Évaluation (fetch + décision) — partagée bandeau / snapshot offline ----------
// Renvoie { badges:[{icon,text,sev}], dayLabel }.
export async function evaluate(trail, { eles = null, track = null, totalKm = null } = {}, depart = getSharedDepart()) {
  if (!track || track.length < 2) return { badges: [], dayLabel: dayLabelOf(depart) };
  const geo = geometry(track, eles);
  const durH = durationH(eles, totalKm);
  const [fc, air] = await Promise.all([
    fetchForecast(geo, depart),
    fetchAir(geo, depart).catch(() => null), // best-effort : air/UV/pollens optionnels
  ]);
  return assess({ geo, durH, depart, fc, air });
}

/**
 * Bandeau « Conditions du sentier » sous la météo à l'heure de passage.
 * @param {HTMLElement} container
 * @param {object} trail   — sert de clé de snapshot offline (`cond:<id>`)
 * @param {object} opts    { eles, track, totalKm }
 * @returns {{ destroy() }}
 */
export function createConditions(container, trail, { eles = null, track = null, totalKm = null } = {}) {
  if (!container || !track || track.length < 2) return { destroy() {} };
  let destroyed = false;
  let unsub = null;

  function paint(result, snapshotAt) {
    if (destroyed) return;
    if (!result || !result.badges.length) { container.innerHTML = ""; return; } // belle journée : rien
    const rows = result.badges
      .map((b) => `<div class="cond-row cond-${b.sev}"><span class="cond-ico">${b.icon}</span><span class="cond-txt">${b.text}</span></div>`)
      .join("");
    const foot = snapshotAt
      ? `📦 conditions du ${new Date(snapshotAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} (hors-ligne)`
      : `Open-Meteo · qualité de l'air CAMS · ${result.dayLabel}`;
    container.innerHTML = `
      <div class="info-block cond">
        <div class="info-block-head">
          <span class="eyebrow">Conditions du sentier</span>
          <span class="eyebrow cond-day">${result.dayLabel}</span>
        </div>
        <div class="cond-list">${rows}</div>
        <p class="info-block-foot cond-foot muted">${foot}</p>
      </div>`;
  }

  async function run() {
    try {
      const result = await evaluate(trail, { eles, track, totalKm });
      paint(result);
    } catch {
      // Hors-ligne / API en panne : snapshot daté du pack s'il existe, sinon rien.
      const snap = await getPackMeta(`cond:${trail.id}`).catch(() => null);
      if (destroyed) return;
      if (snap?.badges) paint({ badges: snap.badges, dayLabel: snap.dayLabel }, snap.at);
      else container.innerHTML = "";
    }
  }

  // Le sélecteur de départ est partagé avec la météo à l'heure de passage (S-METEO) :
  // changer le jour là-bas ré-évalue ici les conditions du bon jour, sans 2e sélecteur.
  unsub = subscribeDepart(() => { if (!destroyed) run(); });
  run();

  return {
    destroy() {
      destroyed = true;
      unsub?.();
      container.innerHTML = "";
    },
  };
}

// Snapshot embarqué dans un pack offline (appelé par offline.js). On stocke le RÉSULTAT
// évalué (badges + jour) : rejouable sans réseau ni altitude, daté comme la météo S5.
export async function saveConditionsSnapshot(trail) {
  const track = trail.mainline || trackOf(trail);
  const eles = trail.eles?.length > 1 ? trail.eles : state.elev[trail.id]?.eles || null;
  const result = await evaluate(trail, { eles, track, totalKm: trail.distance });
  await putPackMeta(`cond:${trail.id}`, { at: Date.now(), ...result });
}
