// Sancho Rossi — Conditions du sentier & nuit (S-V2-VIGIE-A, absorbe S-CONDITIONS + S-NUIT)
//
// Même socle que la météo à l'heure de passage (hikeweather.js) : la timeline de
// marche Naismith et les échantillons {lat, lon, h, ele} sont réutilisés tels
// quels pour croiser altitude/heure de passage avec neige, orage, canicule…
// L'heure de départ reste le réglage UNIQUE partagé avec le bandeau météo — pas de
// second sélecteur de date, cf. évènement `sr:depart-changed` (hikeweather.js).
//
// Badges actifs seulement : une belle journée n'affiche rien (règle CLAUDE.md).
import { state, trackOf } from "./state.js";
import { fetchRetry } from "./net.js";
import { putPackMeta, getPackMeta } from "./storage.js";
import { buildTimeline, buildSamples, hourAtKm, defaultDepart, getDepartShared } from "./hikeweather.js";
import { sunTimes } from "./astro.js";

const SNAPSHOT_DAYS = 7;

// Cache de session par (points, horizon) — même contrat que hikeweather.js.
const fetchCache = new Map();
const fmtHM = (d) => d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

// ---------- Open-Meteo : conditions le long du tracé ----------
// `past_days=3` sur le MÊME appel que la prévision : la pluie récente (badge boue)
// et les heures à venir arrivent dans un seul jeu de données horaires par point.
async function fetchConditionsData(samples, days) {
  const key = "cond:" + samples.map((s) => `${s.lat.toFixed(3)},${s.lon.toFixed(3)}`).join(";") + `|${days}`;
  if (fetchCache.has(key)) return fetchCache.get(key);
  const hasEle = samples.every((s) => s.ele != null);
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${samples.map((s) => s.lat.toFixed(3)).join(",")}` +
    `&longitude=${samples.map((s) => s.lon.toFixed(3)).join(",")}` +
    (hasEle ? `&elevation=${samples.map((s) => s.ele).join(",")}` : "") +
    `&hourly=temperature_2m,precipitation,freezing_level_height,uv_index,cape,snow_depth` +
    `&past_days=3&forecast_days=${days}&timezone=auto`;
  const p = (async () => {
    const res = await fetchRetry(url, { timeout: 15000 });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    let data = await res.json();
    if (!Array.isArray(data)) data = [data];
    return data;
  })();
  fetchCache.set(key, p);
  p.catch(() => fetchCache.delete(key));
  return p;
}

// Qualité de l'air + pollens : un seul point représentatif (départ du tracé) — ça
// ne varie pas assez sur la longueur d'une rando pour justifier un appel multi-points.
// Best-effort strict : son échec n'annule jamais les badges météo/neige/orage.
async function fetchAirQuality(sample) {
  const key = `aq:${sample.lat.toFixed(3)},${sample.lon.toFixed(3)}`;
  if (fetchCache.has(key)) return fetchCache.get(key);
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality` +
    `?latitude=${sample.lat.toFixed(3)}&longitude=${sample.lon.toFixed(3)}` +
    `&hourly=european_aqi,birch_pollen,grass_pollen,ragweed_pollen&timezone=auto&forecast_days=1`;
  const p = (async () => {
    const res = await fetchRetry(url, { timeout: 12000, retries: 1 });
    if (!res.ok) throw new Error(`Air Quality ${res.status}`);
    return res.json();
  })();
  fetchCache.set(key, p);
  p.catch(() => fetchCache.delete(key));
  return p;
}

// Valeur horaire au point i pour une date donnée (même logique d'index que
// hikeweather.weatherAt) — null si hors de la fenêtre disponible.
function hourlyAt(hourly, date) {
  if (!hourly?.time?.length) return null;
  const idx = Math.round((date - new Date(hourly.time[0])) / 3600000);
  if (idx < 0 || idx >= hourly.time.length) return null;
  return idx;
}

// ---------- Seuils badges ----------
const SNOW_MARGIN_M = 150;   // au-dessus du niveau de gel : neige jugée "probable"
const MUD_RAIN_MM = 15;      // cumul pluie 3 j déclenchant le badge boue
const HEAT_C = 30;
const FREEZE_C = 0;
const STORM_CAPE = 800;      // J/kg — instabilité marquée (pas de proba horaire dispo sur cet appel, cape seul)
const UV_HIGH = 6;
const AQI_POOR = 60;
const POLLEN_HIGH = 40; // grains/m³, seuil générique "élevé"

function computeBadges({ wdata, aq, samples, tl, depart }) {
  const badges = [];
  let snowAboveM = null;
  let maxTemp = -Infinity, minTemp = Infinity;
  let stormHour = null;
  let maxUv = 0;
  let rainPast3d = 0;

  samples.forEach((s, i) => {
    const hourly = wdata[i]?.hourly;
    if (!hourly) return;
    const eta = new Date(depart.getTime() + s.h * 3600000);
    const idx = hourlyAt(hourly, eta);
    if (idx != null) {
      const t = hourly.temperature_2m[idx];
      if (t != null) { maxTemp = Math.max(maxTemp, t); minTemp = Math.min(minTemp, t); }
      const fz = hourly.freezing_level_height?.[idx];
      if (fz != null && s.ele != null && s.ele > fz - SNOW_MARGIN_M) {
        snowAboveM = snowAboveM == null ? s.ele : Math.min(snowAboveM, s.ele);
      }
      const cape = hourly.cape?.[idx];
      if (cape != null && cape > STORM_CAPE && stormHour == null) stormHour = eta;
      const uv = hourly.uv_index?.[idx];
      if (uv != null) maxUv = Math.max(maxUv, uv);
    }
    // Pluie des 3 derniers jours : les 72 premières heures du tableau (past_days=3),
    // indépendant de l'heure de passage — même valeur pour tous les points, on ne
    // la lit qu'une fois.
    if (i === 0 && hourly.precipitation) {
      rainPast3d = hourly.precipitation.slice(0, 72).reduce((a, v) => a + (v || 0), 0);
    }
  });

  if (snowAboveM != null) {
    badges.push({ icon: "❄", text: `Neige probable au-dessus de ~${Math.round(snowAboveM / 50) * 50} m`, level: "warn" });
  }
  if (rainPast3d >= MUD_RAIN_MM) {
    badges.push({ icon: "🥾", text: "Boue probable après les pluies récentes", level: "warn" });
  }
  if (maxTemp >= HEAT_C) {
    badges.push({ icon: "🥵", text: `Canicule — jusqu'à ${Math.round(maxTemp)}°, pensez à l'eau`, level: "danger" });
  }
  if (minTemp <= FREEZE_C) {
    badges.push({ icon: "🥶", text: `Gel possible — jusqu'à ${Math.round(minTemp)}°`, level: "warn" });
  }
  if (stormHour) {
    badges.push({ icon: "⚡", text: `Orages probables dès ${fmtHM(stormHour)}`, level: "danger" });
  }
  if (maxUv >= UV_HIGH) {
    badges.push({ icon: "☀", text: `UV élevé (indice ${Math.round(maxUv)}) — crème et lunettes`, level: "warn" });
  }
  if (aq) {
    const aqi = aq.hourly?.european_aqi?.find((v) => v != null);
    if (aqi != null && aqi > AQI_POOR) {
      badges.push({ icon: "🌫", text: `Qualité de l'air dégradée (indice ${Math.round(aqi)})`, level: "warn" });
    }
    const pollenMax = Math.max(
      ...(["birch_pollen", "grass_pollen", "ragweed_pollen"]
        .map((k) => aq.hourly?.[k]?.find((v) => v != null) ?? 0))
    );
    if (pollenMax >= POLLEN_HIGH) {
      badges.push({ icon: "🤧", text: "Pollens élevés", level: "warn" });
    }
  }
  return badges;
}

// ---------- Nuit ----------
function computeNightLine(depart, totalH, lat, lon) {
  const arrive = new Date(depart.getTime() + totalH * 3600000);
  const { sunset, civilDusk } = sunTimes(lat, lon, arrive);
  if (!sunset) return { text: `arrivée estimée ${fmtHM(arrive)}`, late: false };
  const cutoff = civilDusk || sunset;
  const late = arrive > cutoff;
  return {
    text: `arrivée estimée ${fmtHM(arrive)} — nuit à ${fmtHM(sunset)}`,
    late,
  };
}

const LEVEL_CLASS = { warn: "pill-warn", danger: "pill-difficile" };

function renderBadges(badges) {
  if (!badges.length) return "";
  return `<div class="cond-badges">${badges
    .map((b) => `<span class="pill ${LEVEL_CLASS[b.level] || ""}" title="${b.text}">${b.icon} ${b.text}</span>`)
    .join("")}</div>`;
}

/**
 * Bandeau « Conditions & nuit » — même moule `.info-block` que createRouteWeather,
 * sans sélecteur de date propre (raccroché à l'heure de départ partagée).
 * @param {HTMLElement} container
 * @param {object} trail   — sert de clé de snapshot offline (`cond:<id>`)
 * @param {object} opts    { eles, track, totalKm, cells }
 */
export function createRouteConditions(container, trail, { eles = null, track = null, totalKm = null, cells = 6 } = {}) {
  if (!container || !track || track.length < 2) return { destroy() {} };

  let destroyed = false;
  const tl = buildTimeline(track, eles, totalKm);
  const samples = buildSamples(tl, cells);

  container.innerHTML = `
    <div class="info-block cond hidden">
      <div class="info-block-head"><span class="eyebrow">Conditions &amp; nuit</span></div>
      <div class="cond-body"></div>
      <p class="info-block-foot cond-foot muted"></p>
    </div>`;
  const blockEl = container.querySelector(".cond");
  const bodyEl = container.querySelector(".cond-body");
  const footEl = container.querySelector(".cond-foot");

  const departDate = () => {
    const d = new Date(getDepartShared());
    return isNaN(d) ? new Date(defaultDepart()) : d;
  };

  function paintFrozen(snap) {
    bodyEl.innerHTML = renderBadges(snap.badges);
    footEl.innerHTML = `📦 conditions du ${new Date(snap.at).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} (hors-ligne) · ${snap.night.text}`;
    blockEl.classList.toggle("hidden", !snap.badges.length && !snap.night.late);
  }

  function paint(st) {
    const depart = departDate();
    const badges = computeBadges({ wdata: st.wdata, aq: st.aq, samples, tl, depart });
    const night = computeNightLine(depart, tl.totalH, samples[0].lat, samples[0].lon);
    bodyEl.innerHTML = renderBadges(badges);
    footEl.innerHTML = night.text;
    footEl.classList.toggle("warn", night.late);
    blockEl.classList.toggle("hidden", !badges.length && !night.late);
  }

  async function load() {
    const depart = departDate();
    const end = depart.getTime() + tl.totalH * 3600000;
    const days = Math.max(2, Math.min(16, Math.ceil((end - Date.now()) / 86400000) + 1));
    try {
      const wdata = await fetchConditionsData(samples, days);
      const aq = await fetchAirQuality(samples[0]).catch(() => null);
      if (destroyed) return;
      paint({ wdata, aq });
    } catch {
      // Hors-ligne : snapshot figé du pack, s'il existe.
      const snap = await getPackMeta(`cond:${trail.id}`).catch(() => null);
      if (destroyed) return;
      if (!snap) { container.innerHTML = ""; return; }
      paintFrozen(snap);
    }
  }

  load();
  document.addEventListener("sr:depart-changed", load);

  return {
    destroy() {
      destroyed = true;
      document.removeEventListener("sr:depart-changed", load);
      container.innerHTML = "";
    },
  };
}

// Snapshot embarqué dans un pack offline (appelé par offline.js, phase météo).
// Contrat "gelé" : on stocke le RENDU déjà calculé (badges + ligne nuit), pas les
// données brutes — hors-ligne on relit un état daté, on n'en recalcule pas un autre.
export async function saveConditionsSnapshot(trail) {
  const track = trail.mainline || trackOf(trail);
  const eles = trail.eles?.length > 1 ? trail.eles : state.elev[trail.id]?.eles || null;
  const tl = buildTimeline(track, eles, trail.distance);
  const samples = buildSamples(tl, 6);
  const depart = new Date(defaultDepart());
  const end = depart.getTime() + tl.totalH * 3600000;
  const days = Math.max(2, Math.min(16, Math.ceil((end - Date.now()) / 86400000) + 1, SNAPSHOT_DAYS));
  const wdata = await fetchConditionsData(samples, days);
  const aq = await fetchAirQuality(samples[0]).catch(() => null);
  const badges = computeBadges({ wdata, aq, samples, tl, depart });
  const night = computeNightLine(depart, tl.totalH, samples[0].lat, samples[0].lon);
  await putPackMeta(`cond:${trail.id}`, { at: Date.now(), badges, night });
}
