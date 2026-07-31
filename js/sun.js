// Sancho Rossi — ensoleillement réel d'un point de montagne (S-SOLEIL)
//
// « Coucher 20 h 55 » est un mensonge poli dans une combe : le soleil y disparaît derrière
// une crête à 16 h 20. Ce module confronte la position du soleil (astro.js, calcul local)
// au relief environnant (dem.js) pour répondre à la vraie question — de quand à quand le
// soleil touche CE point — et pour dire, à une heure donnée, quels versants sont à l'ombre.
//
// Tout est synchrone et sans réseau une fois le MNT chargé : utilisable hors-ligne.
import { sunPosition, sunTimes } from "./astro.js";

const RAD = Math.PI / 180;
// Rayon terrestre EFFECTIF : 7/6 du rayon réel. La réfraction atmosphérique courbe les
// rayons rasants dans le même sens que la Terre, ce qui revient à « aplatir » celle-ci —
// convention géodésique standard. Sans cette correction, l'abaissement d'une crête à 20 km
// est surestimé de ~9 m et un horizon lointain paraît systématiquement trop bas.
const EARTH_EFF = 6371000 * (7 / 6);
// Hauteur des yeux : on regarde depuis la tête, pas depuis le sol. Anecdotique de face à
// une paroi, mais c'est ce qui évite qu'un point posé pile sur une bosse du MNT se
// déclare à l'ombre de sa propre bosse.
const EYE_M = 1.6;
// Réfraction + demi-diamètre du disque : le soleil « se lève » quand son BORD SUPÉRIEUR
// franchit l'horizon, à −0,833° de hauteur géométrique du centre. Même seuil que
// `sunTimes` dans astro.js — c'est ce qui garantit qu'un point parfaitement dégagé
// retrouve exactement l'heure de lever théorique (le test de non-régression du sprint).
const SUN_EDGE = 0.833;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mPerDegLat = 111320;
const mPerDegLon = (lat) => 111320 * Math.max(0.02, Math.cos(lat * RAD));

// ---------- Horizon réel autour d'un point ----------

const HORIZON_RAYS = 360; // un rayon par degré : plus fin que le disque solaire (0,53°)
const HORIZON_MAX_M = 25000;
// Distance à laquelle commence la marche. En deçà, le MNT (27 m/px au mieux) ne porte
// AUCUNE information propre : on n'y lirait que l'interpolation bilinéaire de la cellule
// où l'on se tient déjà. Mesuré : en partant à 30 m, un point plat des Pays-Bas se
// fabriquait un horizon de 0,6° — 4 minutes de coucher perdues sur du néant.
const START_M = 120;
// Recalage de l'œil sur la couronne de départ. Le MNT lisse les sommets ET déplace leur
// cime : au Mont Blanc, le point relevé vaut 4774 m alors que le MNT culmine à 4789 m
// 90 m plus loin. Sans recalage, un sommet se déclare à l'ombre de lui-même et perd
// 1 h 30 de soleil. Le relèvement est PLAFONNÉ : au pied d'une falaise de 200 m, l'œil
// ne doit surtout pas être téléporté à son sommet.
const LIFT_MAX = 20;

/**
 * Silhouette du relief vue depuis un point : pour chaque degré d'azimut, la hauteur
 * angulaire (en degrés) de la crête la plus haute dans cette direction. Négatif quand la
 * vue plonge — depuis un sommet, l'horizon est SOUS l'horizontale, et le soleil s'y lève
 * donc un peu avant l'heure théorique.
 *
 * @param {object} dem  poignée de dem.js (`elevationAt`)
 * @returns {{profile:Float32Array, ground:number}|null} null si le MNT ne couvre pas le point
 */
export function horizonProfile(dem, lat, lon) {
  const ground = dem.elevationAt(lat, lon);
  if (ground == null) return null;
  const profile = new Float32Array(HORIZON_RAYS);
  const perLat = mPerDegLat, perLon = mPerDegLon(lat);
  const dir = [];
  for (let a = 0; a < HORIZON_RAYS; a++) {
    const rad = ((a * 360) / HORIZON_RAYS) * RAD;
    dir.push([Math.cos(rad) / perLat, Math.sin(rad) / perLon]);
  }

  // Passe 1 — la couronne de départ sert à recaler l'œil (cf. LIFT_MAX). Elle ne coûte
  // rien de plus : ce sont exactement les points où les rayons commenceront.
  let ringMax = ground;
  const ring = dir.map(([dLat, dLon]) => {
    const h = dem.elevationAt(lat + dLat * START_M, lon + dLon * START_M);
    if (h != null && h > ringMax) ringMax = h;
    return h;
  });
  const eye = ground + Math.min(ringMax - ground, LIFT_MAX) + EYE_M;

  // Passe 2 — la marche proprement dite. Pas croissant : dense sur le versant d'en face
  // (celui qui masque le plus), lâche au loin où une crête à 25 km n'a pas besoin d'être
  // échantillonnée tous les 40 m — et où le MNT n'est de toute façon plus qu'à 108 m/px.
  let lowest = ground;
  for (let a = 0; a < HORIZON_RAYS; a++) {
    const [dLat, dLon] = dir[a];
    let best = -90;
    const consider = (h, d) => {
      if (h == null) return;
      if (h < lowest) lowest = h;
      const angle = Math.atan2(h - eye - (d * d) / (2 * EARTH_EFF), d) / RAD;
      if (angle > best) best = angle;
    };
    consider(ring[a], START_M);
    for (let d = START_M + 40; d <= HORIZON_MAX_M; d += Math.max(40, d / 50)) {
      consider(dem.elevationAt(lat + dLat * d, lon + dLon * d), d);
    }
    profile[a] = best;
  }

  // Plancher géométrique — on ne voit pas sous la tangente à la Terre. S'arrêter à 25 km
  // fait croire, depuis un sommet, que l'horizon plonge aussi bas que le fond de vallée
  // le plus proche : au Mont Blanc, −9,2° vers l'ouest, soit une heure de soleil offerte
  // qui n'existe pas. Au-delà de la portée d'échantillonnage, le relief lointain ne peut
  // pas descendre sous l'angle de tangence, qui vaut √(2·h/R) pour une hauteur h
  // au-dessus des terres basses environnantes. Sans effet en plaine (h ≈ 0).
  const floor = -Math.sqrt((2 * Math.max(0, eye - lowest)) / EARTH_EFF) / RAD;
  for (let a = 0; a < HORIZON_RAYS; a++) {
    if (profile[a] < floor) profile[a] = floor;
  }
  return { profile, ground, eye };
}

// Hauteur d'horizon à un azimut quelconque — interpolée, sinon l'angle de crête sauterait
// d'un degré à l'autre et découperait la plage de soleil en confettis.
export function horizonAt(profile, azDeg) {
  const n = profile.length;
  const x = ((azDeg % 360) + 360) % 360 * (n / 360);
  const i = Math.floor(x) % n, j = (i + 1) % n;
  return profile[i] + (profile[j] - profile[i]) * (x - Math.floor(x));
}

// ---------- Plage d'ensoleillement ----------

const SCAN_MIN = 2; // pas de balayage, affiné ensuite par dichotomie

const atMinutes = (day, min) => new Date(day.getTime() + min * 60000);

/**
 * De quand à quand le soleil touche ce point, ce jour-là.
 *
 * Renvoie une LISTE d'intervalles, pas un créneau unique : une arête isolée peut couper le
 * soleil en milieu de journée, et c'est précisément ce qu'aucune application ne dit.
 *
 * @param {Float32Array} profile  silhouette de `horizonProfile`
 * @param {Date} date  n'importe quel instant du jour voulu (heure locale du navigateur)
 * @returns {{intervals:Array<{from:Date,to:Date,fromAz:number,toAz:number}>,
 *            totalMin:number, theoretical:{sunrise:Date|null, sunset:Date|null}}}
 */
export function sunWindow(lat, lon, date, profile) {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const noon = atMinutes(day, 12 * 60);
  const theo = sunTimes(lat, lon, noon);

  const lit = (min) => {
    const s = sunPosition(lat, lon, atMinutes(day, min));
    return s.altitude + SUN_EDGE > horizonAt(profile, s.azimuth);
  };

  // Bornes du balayage : le crépuscule civil encadre largement toute visibilité possible
  // (le soleil est alors à −6°, sous n'importe quel horizon plongeant crédible). Sans
  // crépuscule calculable (jour ou nuit polaire), on balaie les 24 h.
  const minOf = (d) => (d - day) / 60000;
  const from = theo.civilDawn ? Math.max(0, minOf(theo.civilDawn) - 30) : 0;
  const to = theo.civilDusk ? Math.min(1440, minOf(theo.civilDusk) + 30) : 1440;

  // Dichotomie sur la transition encadrée par [lo, hi] → la minute où le soleil bascule.
  const edge = (lo, hi) => {
    const litLo = lit(lo);
    let a = lo, b = hi;
    for (let k = 0; k < 8; k++) { // 2 min ÷ 2⁸ ≈ 0,5 s : bien en deçà de la minute affichée
      const m = (a + b) / 2;
      if (lit(m) === litLo) a = m; else b = m;
    }
    return (a + b) / 2;
  };

  const intervals = [];
  let start = null, prev = from, prevLit = lit(from);
  if (prevLit) start = from; // déjà éclairé au tout début du balayage

  for (let m = from + SCAN_MIN; m <= to; m += SCAN_MIN) {
    const now = lit(m);
    if (now !== prevLit) {
      const t = edge(prev, m);
      if (now) start = t;
      else if (start != null) { intervals.push([start, t]); start = null; }
      prevLit = now;
    }
    prev = m;
  }
  if (start != null) intervals.push([start, to]);

  const out = intervals
    // Un liseré de moins de 3 minutes est du bruit de MNT (un pixel de crête), pas une
    // information : l'afficher ferait dire à la fiche « soleil de 12 h 41 à 12 h 43 ».
    .filter(([a, b]) => b - a >= 3)
    .map(([a, b]) => ({
      from: atMinutes(day, Math.round(a)),
      to: atMinutes(day, Math.round(b)),
      fromAz: sunPosition(lat, lon, atMinutes(day, a)).azimuth,
      toAz: sunPosition(lat, lon, atMinutes(day, b)).azimuth,
    }));

  return {
    intervals: out,
    totalMin: out.reduce((s, i) => s + (i.to - i.from) / 60000, 0),
    theoretical: { sunrise: theo.sunrise, sunset: theo.sunset },
  };
}

/**
 * Course du soleil sur la journée, échantillonnée pour le cadran : chaque point porte sa
 * hauteur, son azimut et le fait qu'il soit masqué ou non par le relief.
 */
export function sunPath(lat, lon, date, profile, stepMin = 5) {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const pts = [];
  for (let m = 0; m < 1440; m += stepMin) {
    const t = atMinutes(day, m);
    const s = sunPosition(lat, lon, t);
    if (s.altitude < -2) continue; // sous l'horizon : rien à tracer
    pts.push({
      t, min: m, az: s.azimuth, alt: s.altitude,
      lit: profile ? s.altitude + SUN_EDGE > horizonAt(profile, s.azimuth) : true,
    });
  }
  return pts;
}

// ---------- Ombres portées sur le relief ----------

/**
 * Échantillonne le terrain une bonne fois sur l'emprise affichée. Les ombres se calculent
 * ensuite PAR MARCHE DANS CETTE GRILLE (simple lecture de tableau), et non en réinterrogeant
 * le MNT à chaque pas de rayon : c'est ce qui fait tenir un recalcul complet sous 100 ms
 * quand on fait glisser le curseur horaire.
 *
 * @param {object} dem  poignée de dem.js
 * @param {{west:number,south:number,east:number,north:number}} bbox
 */
export function terrainGrid(dem, bbox, size = 192) {
  const h = new Float32Array(size * size);
  const dLat = (bbox.north - bbox.south) / (size - 1);
  const dLon = (bbox.east - bbox.west) / (size - 1);
  let min = Infinity, max = -Infinity;
  for (let r = 0; r < size; r++) {
    const lat = bbox.north - r * dLat; // ligne 0 = nord, comme un canvas
    for (let c = 0; c < size; c++) {
      const v = dem.elevationAt(lat, bbox.west + c * dLon) ?? 0;
      h[r * size + c] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const midLat = (bbox.north + bbox.south) / 2;
  return {
    size, bbox, h, min, max,
    mx: dLon * mPerDegLon(midLat), // mètres par cellule, est-ouest
    my: dLat * mPerDegLat,         // mètres par cellule, nord-sud
  };
}

const MARCH_STEPS = 120; // portée d'ombre bornée en CELLULES : s'adapte seule à l'emprise
// Adoucissement au terminateur : sans lui, la limite ombre/lumière sur un versant est un
// escalier de pixels (le MNT est à 27 m). Le dégradé sur ~9° d'incidence rase l'artefact
// sans inventer de lumière.
const GRAZE = 0.16;

/**
 * Part d'ombre de chaque cellule à une position de soleil donnée : 0 = plein soleil,
 * 1 = à l'ombre. Deux causes cumulées — le versant tourne le dos au soleil (auto-ombrage),
 * ou un relief situé entre lui et le soleil l'occulte (ombre portée).
 *
 * @returns {Float32Array} `size²` valeurs dans [0, 1]
 */
export function shadeGrid(grid, sunAz, sunAlt) {
  const { size, h, mx, my } = grid;
  const shade = new Float32Array(size * size);
  if (sunAlt <= 0) { shade.fill(1); return shade; } // soleil couché : tout est à l'ombre

  // Direction du soleil en cellules. L'azimut est compté depuis le nord dans le sens
  // horaire ; la ligne 0 étant au nord, aller vers le nord fait DÉCROÎTRE la ligne.
  const stepM = Math.min(mx, my);
  const dc = (Math.sin(sunAz * RAD) * stepM) / mx;
  const dr = (-Math.cos(sunAz * RAD) * stepM) / my;
  const rise = Math.tan(sunAlt * RAD) * stepM; // gain d'altitude du rayon par pas

  const sunE = Math.sin(sunAz * RAD) * Math.cos(sunAlt * RAD);
  const sunN = Math.cos(sunAz * RAD) * Math.cos(sunAlt * RAD);
  const sunU = Math.sin(sunAlt * RAD);

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const i = r * size + c;
      // Normale locale par différences centrées (bords : décentrées).
      const hL = h[i - (c > 0 ? 1 : 0)], hR = h[i + (c < size - 1 ? 1 : 0)];
      const hU = h[i - (r > 0 ? size : 0)], hD = h[i + (r < size - 1 ? size : 0)];
      const dzdx = (hR - hL) / (mx * ((c > 0 && c < size - 1) ? 2 : 1));
      const dzdy = (hU - hD) / (my * ((r > 0 && r < size - 1) ? 2 : 1)); // vers le nord
      // Normale non normalisée (−dz/dx, −dz/dy, 1), puis cosinus d'incidence.
      const nlen = Math.hypot(dzdx, dzdy, 1);
      const cosI = (-dzdx * sunE - dzdy * sunN + sunU) / nlen;

      if (cosI <= 0) { shade[i] = 1; continue; } // le versant tourne le dos : inutile de marcher

      // Ombre portée : on remonte vers le soleil ; si le terrain dépasse le rayon, c'est
      // qu'un relief s'interpose.
      let blocked = 0;
      let fc = c + dc, fr = r + dr, ray = h[i] + rise;
      for (let s = 1; s <= MARCH_STEPS; s++, fc += dc, fr += dr, ray += rise) {
        const ic = fc | 0, ir = fr | 0;
        if (ic < 0 || ir < 0 || ic >= size || ir >= size) break; // sorti de l'emprise
        if (h[ir * size + ic] > ray) { blocked = 1; break; }
      }
      shade[i] = blocked ? 1 : (cosI < GRAZE ? 1 - cosI / GRAZE : 0);
    }
  }
  return shade;
}

/**
 * Grille d'ombre → pixels RGBA prêts pour `putImageData`. L'ombre est un bleu nuit très
 * désaturé (la lumière d'ombre en montagne est bleue — c'est le ciel qui l'éclaire), posé
 * en semi-transparence : l'imagerie satellite reste lisible dessous, on l'assombrit, on ne
 * la remplace pas.
 */
export function shadeToImageData(shade, size, ctx, opacity = 0.46) {
  const img = ctx.createImageData(size, size);
  const px = img.data;
  for (let i = 0, p = 0; i < shade.length; i++, p += 4) {
    px[p] = 16; px[p + 1] = 24; px[p + 2] = 48;
    px[p + 3] = clamp(shade[i] * opacity * 255, 0, 255);
  }
  return img;
}
