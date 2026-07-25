// Sancho Rossi — Alertes sur mes sorties prévues (S-V2-VIGIE-B)
//
// À l'ouverture de l'appli : pour chaque sortie prévue dans l'horizon Open-Meteo,
// on compare le relevé météo du jour concerné à celui vu la dernière fois — pas à
// celui du jour de la réservation, la référence "roule" à chaque consultation. Un
// badge n'apparaît que si ça s'est dégradé DEPUIS LA DERNIÈRE FOIS, pas simplement
// si le temps est mauvais (ce rôle-là est déjà tenu par le bandeau météo du tracé).
//
// MeteoAlarm et EFFIS (vigilances officielles, risque incendie) étaient prévus au
// même sprint mais écartés après vérification : MeteoAlarm ne renvoie aucun en-tête
// CORS sur ses flux (JSON/RSS/Atom) — bloqué pour un fetch navigateur, pas de
// contournement possible sans backend. EFFIS/GWIS (JRC) a un CORS ouvert mais ses
// couches de risque incendie retournent une erreur serveur Oracle côté JRC (panne
// infra constatée sur deux endpoints distincts, pas un souci de notre requête) —
// à reprendre si le service revient : GetFeature sur ms:fwi_gadm_admin2.fwi,
// https://ies-ows.jrc.ec.europa.eu/gwis?service=WFS&version=2.0.0.
import { upcomingOutings, getTrail } from "./state.js";
import { wmoInfo } from "./weather.js";
import { fetchRetry } from "./net.js";
import { putPackMeta, getPackMeta } from "./storage.js";

const HORIZON_DAYS = 16; // max Open-Meteo pour les prévisions journalières

// État en mémoire, reconstruit à chaque `checkOutingsVigilance()` — pas persisté
// tel quel : ce qui est persisté, c'est le relevé de référence (`vigie:<id>`).
const vigilant = new Map();

export function getVigilance(outingId) {
  return vigilant.get(outingId);
}

async function fetchDailyAt(lat, lon, days) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max` +
    `&timezone=auto&forecast_days=${days}`;
  const res = await fetchRetry(url, { timeout: 15000 });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const data = await res.json();
  return data.daily;
}

// Relevé du jour `date` (YYYY-MM-DD) dans une réponse `daily` Open-Meteo, ou null
// si ce jour n'est pas dans la fenêtre renvoyée.
function dayReading(daily, date) {
  const i = daily.time?.indexOf(date);
  if (i == null || i < 0) return null;
  return {
    code: daily.weather_code[i],
    tempMax: daily.temperature_2m_max[i],
    tempMin: daily.temperature_2m_min[i],
    precip: daily.precipitation_sum[i],
    wind: daily.wind_speed_10m_max[i],
  };
}

const STORM_CODES = new Set([73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]); // neige forte, averses fortes, orage
const RAIN_DELTA_MM = 10;
const WIND_DELTA_KMH = 20;
const COLD_DELTA_C = 8;

// Seuils simples, dans l'esprit de conditions.js : une dégradation SENSIBLE depuis
// le dernier relevé, pas n'importe quelle variation.
function degradation(prev, next) {
  if (!STORM_CODES.has(prev.code) && STORM_CODES.has(next.code)) {
    return { degraded: true, reason: `Orage/fortes précipitations désormais annoncés (${wmoInfo(next.code).label})` };
  }
  if (next.precip - prev.precip >= RAIN_DELTA_MM) {
    return { degraded: true, reason: `Pluie revue nettement à la hausse (+${Math.round(next.precip - prev.precip)} mm)` };
  }
  if (next.wind - prev.wind >= WIND_DELTA_KMH) {
    return { degraded: true, reason: `Vent revu nettement à la hausse (+${Math.round(next.wind - prev.wind)} km/h)` };
  }
  if (prev.tempMax - next.tempMax >= COLD_DELTA_C) {
    return { degraded: true, reason: `Chute de température prévue (-${Math.round(prev.tempMax - next.tempMax)}°)` };
  }
  return { degraded: false, reason: "" };
}

/**
 * Vérifie toutes les sorties prévues dans l'horizon Open-Meteo, met à jour la
 * référence stockée (`vigie:<outingId>`) et peuple `vigilant` en mémoire. Best-effort
 * par sortie : une sortie qui échoue n'empêche pas de vérifier les suivantes.
 */
export async function checkOutingsVigilance() {
  vigilant.clear();
  const today = new Date().toISOString().slice(0, 10);
  const limit = new Date(Date.now() + HORIZON_DAYS * 86400000).toISOString().slice(0, 10);
  const outings = upcomingOutings().filter((o) => o.date >= today && o.date <= limit);

  for (const o of outings) {
    try {
      const trail = getTrail(o.trailId);
      if (!trail?.center) continue;
      const days = Math.max(1, Math.ceil((new Date(o.date) - new Date(today)) / 86400000) + 1);
      const [lat, lon] = trail.center;
      const daily = await fetchDailyAt(lat, lon, Math.min(HORIZON_DAYS, days));
      const next = dayReading(daily, o.date);
      if (!next) continue;

      const prev = await getPackMeta(`vigie:${o.id}`).catch(() => null);
      if (prev?.reading) {
        const delta = degradation(prev.reading, next);
        if (delta.degraded) vigilant.set(o.id, { reason: delta.reason, at: Date.now() });
      }
      await putPackMeta(`vigie:${o.id}`, { at: Date.now(), reading: next });
    } catch {
      // Best-effort : tracé introuvable, API indisponible… on passe à la suivante.
    }
  }
}
