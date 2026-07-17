// Sancho Rossi — calculs astronomiques locaux (S-NUIT)
//
// Lever/coucher du soleil, crépuscule civil et phase de lune, calculés EN JS à partir
// de la date et de la position : ZÉRO réseau → 100 % disponible hors-ligne, sur le
// terrain, en mode avion. C'est l'ADN sécurité de l'app : savoir combien de jour il
// reste ne doit dépendre d'aucune API.
//
// Soleil : algorithme NOAA (Solar Calculation), précis à la minute — le standard de
// référence, sans les hacks de quadrant de l'almanach. Le résultat est un INSTANT
// (Date UTC exact) : comparer une arrivée estimée au coucher est donc juste quel que
// soit le fuseau ; seul l'AFFICHAGE (toLocaleTimeString) suppose, comme le reste de
// l'app (hikeweather), que le fuseau du navigateur ≈ celui du massif — vrai pour un
// usage européen depuis le Mac/téléphone.

const RAD = Math.PI / 180, DEG = 180 / Math.PI;

// Zéniths (angle soleil-zénith au moment de l'événement).
export const ZENITH_OFFICIAL = 90.833; // bord supérieur du soleil à l'horizon + réfraction
export const ZENITH_CIVIL = 96;        // crépuscule civil : soleil à −6°

// Jour julien à 00:00 UTC du jour de `date`.
function julianDay(date) {
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return midnight / 86400000 + 2440587.5;
}

// Déclinaison solaire (deg) et équation du temps (min) pour un jour julien donné (NOAA).
function solarParams(jd) {
  const jc = (jd - 2451545) / 36525; // siècles juliens depuis J2000
  const gmls = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360; // longitude moyenne
  const gmas = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);         // anomalie moyenne
  const ecc = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);     // excentricité
  const ctr = Math.sin(gmas * RAD) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
    + Math.sin(2 * gmas * RAD) * (0.019993 - 0.000101 * jc)
    + Math.sin(3 * gmas * RAD) * 0.000289;
  const trueLong = gmls + ctr;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * jc) * RAD);
  const meanObliq = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos((125.04 - 1934.136 * jc) * RAD);
  const declin = DEG * Math.asin(Math.sin(obliq * RAD) * Math.sin(appLong * RAD));
  const y = Math.tan((obliq / 2) * RAD) ** 2;
  const eqTime = 4 * DEG * (
    y * Math.sin(2 * gmls * RAD)
    - 2 * ecc * Math.sin(gmas * RAD)
    + 4 * ecc * y * Math.sin(gmas * RAD) * Math.cos(2 * gmls * RAD)
    - 0.5 * y * y * Math.sin(4 * gmls * RAD)
    - 1.25 * ecc * ecc * Math.sin(2 * gmas * RAD)
  ); // minutes
  return { declin, eqTime };
}

// Instant UTC d'un événement solaire, ou null (jour/nuit polaire).
function solarEvent(lat, lon, date, zenith, rising) {
  // Une itération suffit : on évalue les paramètres à midi solaire approché, ce qui
  // ramène l'erreur bien sous la minute aux latitudes européennes.
  const jd0 = julianDay(date);
  const noonUT = (720 - 4 * lon - solarParams(jd0).eqTime) / 1440; // fraction de jour
  const { declin, eqTime } = solarParams(jd0 + noonUT);
  const cosH = (Math.cos(zenith * RAD) / (Math.cos(lat * RAD) * Math.cos(declin * RAD)))
    - Math.tan(lat * RAD) * Math.tan(declin * RAD);
  if (cosH > 1) return { polar: "up" };    // soleil sous l'horizon toute la journée
  if (cosH < -1) return { polar: "down" };  // soleil au-dessus toute la journée
  const ha = DEG * Math.acos(cosH); // angle horaire (deg)
  const solarNoonMin = 720 - 4 * lon - eqTime;         // midi solaire (min UTC)
  const min = rising ? solarNoonMin - 4 * ha : solarNoonMin + 4 * ha; // min UTC
  const base = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return { date: new Date(base + min * 60000) };
}

/**
 * Événements solaires du jour de `date` à (lat, lon).
 * @returns {{ sunrise, sunset, dawn, dusk, polar }} instants Date ; `null` en cas de
 *          jour/nuit polaire, `polar` valant alors "up" (nuit polaire) ou "down".
 */
export function sunEvents(lat, lon, date = new Date()) {
  const ev = (zenith, rising) => solarEvent(lat, lon, date, zenith, rising);
  const sr = ev(ZENITH_OFFICIAL, true), ss = ev(ZENITH_OFFICIAL, false);
  const dawn = ev(ZENITH_CIVIL, true), dusk = ev(ZENITH_CIVIL, false);
  return {
    sunrise: sr.date || null,
    sunset: ss.date || null,
    dawn: dawn.date || null,
    dusk: dusk.date || null,
    polar: sr.polar || null,
  };
}

// ---------- Lune ----------
const SYNODIC = 29.530588853;            // mois synodique (jours)
const REF_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14, 0); // nouvelle lune de référence

// Nom indicatif d'après l'illumination + le sens (croissante avant la pleine lune,
// décroissante après). Robuste au léger flou de la phase MOYENNE (±1 j sur les
// quartiers) : c'est l'illumination — la lumière disponible au bivouac — qui prime.
function moonName(phase, illum) {
  const waxing = phase < 0.5;
  if (illum < 0.02) return { name: "Nouvelle lune", icon: "🌑" };
  if (illum > 0.98) return { name: "Pleine lune", icon: "🌕" };
  if (illum < 0.46) return waxing ? { name: "Premier croissant", icon: "🌒" } : { name: "Dernier croissant", icon: "🌘" };
  if (illum <= 0.54) return waxing ? { name: "Premier quartier", icon: "🌓" } : { name: "Dernier quartier", icon: "🌗" };
  return waxing ? { name: "Gibbeuse croissante", icon: "🌔" } : { name: "Gibbeuse décroissante", icon: "🌖" };
}

/**
 * Phase de lune à `date`.
 * @returns {{ phase, illum, name, icon }} phase ∈ [0,1) (0 = nouvelle, 0.5 = pleine),
 *          illum = fraction éclairée ∈ [0,1].
 */
export function moonPhase(date = new Date()) {
  let phase = (((date.getTime() - REF_NEW_MOON) / 86400000) % SYNODIC) / SYNODIC;
  if (phase < 0) phase += 1;
  const illum = (1 - Math.cos(2 * Math.PI * phase)) / 2;
  return { phase, illum, ...moonName(phase, illum) };
}
