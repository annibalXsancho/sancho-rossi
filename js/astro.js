// Sancho Rossi — astronomie locale (S-V2-VIGIE-A)
//
// Lever/coucher du soleil, crépuscule civil et phase de lune, calculés en JS pur
// à partir de formules astronomiques standard (position solaire par jour julien,
// cf. Meeus/NOAA) : zéro appel réseau, donc disponible dans le HUD de navigation
// hors-ligne comme sur une fiche jamais rechargée depuis le pack.

const RAD = Math.PI / 180;
const J2000 = 2451545; // jour julien de référence (1er janvier 2000, 12h TU)
const OBLIQUITY = RAD * 23.4397; // inclinaison de l'axe terrestre

const toJulian = (date) => date.valueOf() / 86400000 - 0.5 + 2440588;
const fromJulian = (j) => new Date((j + 0.5 - 2440588) * 86400000);
const daysSinceJ2000 = (date) => toJulian(date) - J2000;

// Position du soleil : anomalie moyenne → longitude écliptique → déclinaison.
function solarMeanAnomaly(d) {
  return RAD * (357.5291 + 0.98560028 * d);
}
function eclipticLongitude(M) {
  const c = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const perihelion = RAD * 102.9372;
  return M + c + perihelion + Math.PI;
}
function declination(eclipLon) {
  return Math.asin(Math.sin(OBLIQUITY) * Math.sin(eclipLon));
}

// Instant où le soleil franchit l'altitude `h` (radians) à la longitude/latitude
// données — deux passages par jour (levant/couchant), on résout l'angle horaire.
function hourAngle(h, phi, dec) {
  const cosH = (Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosH < -1 || cosH > 1) return null; // jour ou nuit polaire : jamais atteint
  return Math.acos(cosH);
}

const J0 = 0.0009; // correction de temps de lumière + aberration, en jours

// Cycle julien le plus proche de `d` (jours depuis J2000) vu depuis la longitude
// `lw` (radians, ouest positif) — sert à situer le transit solaire local du jour.
function julianCycle(d, lw) {
  return Math.round(d - J0 - lw / (2 * Math.PI));
}
// Instant approximatif où le soleil est à l'angle horaire `ht` (0 = transit/midi
// solaire) pour le cycle `n`.
function approxTransit(ht, lw, n) {
  return J0 + (ht + lw) / (2 * Math.PI) + n;
}
function solarTransitJ(ds, M, eclipLon) {
  return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * eclipLon);
}

// M/L/déclinaison sont évalués à l'instant du transit approximatif (pas à minuit) :
// c'est ce qui rend l'approximation fidèle à quelques minutes près sur toute l'année.
function eventJulian(h, phi, lw, date) {
  const d = daysSinceJ2000(date);
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const eclipLon = eclipticLongitude(M);
  const dec = declination(eclipLon);
  const Jtransit = solarTransitJ(ds, M, eclipLon);

  const w = hourAngle(h, phi, dec);
  if (w == null) return { transit: Jtransit, rise: null, set: null };
  const Jset = solarTransitJ(approxTransit(w, lw, n), M, eclipLon);
  const Jrise = Jtransit - (Jset - Jtransit); // symétrique autour du transit
  return { transit: Jtransit, rise: Jrise, set: Jset };
}

const ALT_SUNSET = -0.833 * RAD; // horizon géométrique (réfraction + rayon solaire)
const ALT_CIVIL = -6 * RAD; // crépuscule civil

/**
 * Lever/coucher et bornes du crépuscule civil à une position et une date données.
 * @returns {{sunrise:Date|null, sunset:Date|null, civilDawn:Date|null, civilDusk:Date|null}}
 *   null sur un champ = soleil qui ne franchit pas ce seuil ce jour-là (jour/nuit polaire).
 */
export function sunTimes(lat, lon, date) {
  const phi = RAD * lat;
  const lw = RAD * -lon;
  const day = eventJulian(ALT_SUNSET, phi, lw, date);
  const civil = eventJulian(ALT_CIVIL, phi, lw, date);
  return {
    sunrise: day.rise ? fromJulian(day.rise) : null,
    sunset: day.set ? fromJulian(day.set) : null,
    civilDawn: civil.rise ? fromJulian(civil.rise) : null,
    civilDusk: civil.set ? fromJulian(civil.set) : null,
  };
}

// Minutes avant le coucher du soleil à l'instant `now` — null si la nuit est déjà
// tombée ou si le soleil n'est pas encore levé (rien à décompter avant le lever).
export function daylightRemainingMin(lat, lon, now) {
  const { sunrise, sunset } = sunTimes(lat, lon, now);
  if (!sunset) return null;
  if (sunrise && now < sunrise) return null;
  const min = Math.round((sunset - now) / 60000);
  return min > 0 ? min : null;
}

// ---------- Position du soleil dans le ciel (S-SOLEIL) ----------
// `sunTimes` répond « à quelle heure », `sunPosition` répond « où » — c'est ce second
// point de vue qu'il faut pour confronter le soleil au RELIEF : une crête ne masque pas
// une heure, elle masque une direction. Mêmes primitives (anomalie moyenne → longitude
// écliptique → déclinaison), plus les deux grandeurs qui manquaient : l'ascension droite
// et le temps sidéral local, dont la différence donne l'angle horaire.

function rightAscension(eclipLon) {
  // La latitude écliptique du soleil est nulle par définition : le terme en tan(b) des
  // formules générales disparaît.
  return Math.atan2(Math.sin(eclipLon) * Math.cos(OBLIQUITY), Math.cos(eclipLon));
}

// Temps sidéral apparent à Greenwich, ramené à la longitude du lieu (lw = ouest positif).
function siderealTime(d, lw) {
  return RAD * (280.16 + 360.9856235 * d) - lw;
}

/**
 * Direction du soleil vue d'un point, à un instant donné.
 * @returns {{azimuth:number, altitude:number}} degrés — azimut depuis le NORD dans le
 *   sens horaire (0 = nord, 90 = est, 180 = sud), hauteur au-dessus de l'horizon
 *   géométrique (négative la nuit). Convention identique aux caps de nav.js/fiche3d.js.
 */
export function sunPosition(lat, lon, date) {
  const phi = RAD * lat;
  const lw = RAD * -lon;
  const d = daysSinceJ2000(date);
  const M = solarMeanAnomaly(d);
  const eclipLon = eclipticLongitude(M);
  const dec = declination(eclipLon);
  const H = siderealTime(d, lw) - rightAscension(eclipLon);

  const altitude = Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)
  );
  // atan2 donne ici un azimut compté depuis le SUD vers l'ouest (convention astronomique) :
  // le + 180° le ramène au nord, celui de la boussole et des caps du projet.
  const azimuth =
    Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) / RAD + 180;

  return { azimuth: (azimuth + 360) % 360, altitude: altitude / RAD };
}

// ---------- Phase de lune ----------
// Mois synodique moyen (nouvelle lune à nouvelle lune) : 29,53058867 jours.
// Référence : nouvelle lune connue du 6 janvier 2000, 18:14 TU.
const SYNODIC_MONTH = 29.53058867;
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);

const MOON_NAMES = [
  { max: 0.02, name: "nouvelle lune", emoji: "🌑" },
  { max: 0.25, name: "premier croissant", emoji: "🌒" },
  { max: 0.27, name: "premier quartier", emoji: "🌓" },
  { max: 0.48, name: "lune gibbeuse croissante", emoji: "🌔" },
  { max: 0.52, name: "pleine lune", emoji: "🌕" },
  { max: 0.73, name: "lune gibbeuse décroissante", emoji: "🌖" },
  { max: 0.75, name: "dernier quartier", emoji: "🌗" },
  { max: 0.98, name: "dernier croissant", emoji: "🌘" },
  { max: 1, name: "nouvelle lune", emoji: "🌑" },
];

/**
 * Phase de lune à une date donnée (approximation à la journée près — suffisant
 * pour une fiche bivouac, pas une éphéméride de précision).
 * @returns {{fraction:number, illumination:number, name:string, emoji:string}}
 *   `fraction` = position dans le cycle (0 = nouvelle lune, 0.5 = pleine lune, 1 = nouvelle lune suivante).
 */
export function moonPhase(date) {
  const days = (date.getTime() - KNOWN_NEW_MOON) / 86400000;
  const fraction = ((days % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH / SYNODIC_MONTH;
  const illumination = (1 - Math.cos(2 * Math.PI * fraction)) / 2;
  const entry = MOON_NAMES.find((m) => fraction <= m.max) || MOON_NAMES[MOON_NAMES.length - 1];
  return { fraction, illumination, name: entry.name, emoji: entry.emoji };
}
