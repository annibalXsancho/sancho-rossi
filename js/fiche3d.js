// Sancho Rossi — vue 3D d'un tracé sur la fiche (S-V2-3D-FICHE)
//
// Remplace `viewer3d.js` (Three.js), retiré du projet. Le rendu de relief est désormais
// celui de MapLibre, le même que le bouton « 3D » d'Explorer (map.js/enableTerrainOn).
// Trois raisons, dans l'ordre où elles pèsent :
//
//  1. HORS-LIGNE. L'ancien viewer chargeait ses tuiles par `new Image()` : ces requêtes ne
//     passaient pas par le Service Worker des packs, donc la 3D était morte sur le terrain
//     — alors que les packs embarquent EXACTEMENT les mêmes tuiles Esri (le calque
//     `satellite` pointe sur le même World_Imagery). En MapLibre, les tuiles repassent par
//     le SW : un pack téléchargé sert aussi la 3D.
//  2. FLUIDITÉ. Le maillage Three.js était figé (512² d'élévation pour toute l'emprise) et
//     la caméra sautait par crans de 10°. Ici le relief est tuilé/streamé par le moteur et
//     le survol pilote la caméra image par image.
//  3. UN SEUL MOTEUR. Three.js (~600 ko CDN) ne servait plus qu'à cet écran, avec sa dette
//     propre (contextes WebGL à relâcher à la main).
import { createFicheMap, enableTerrainOn, drawTrackOn, domMarker, makeIcon, layerTiles, DEM_EXAGGERATION } from "./map.js";
import { cumulativeKm } from "./metrics.js";
import { loadDem } from "./dem.js";

// Inclinaison de la vue POSÉE (le survol, lui, se calcule en mètres). Volontairement
// modérée : au-delà de ~45° le relief avale le tracé derrière la première crête, et on
// ouvre l'onglet 3D pour VOIR l'itinéraire, pas pour admirer un versant.
const PITCH = 38;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Azimut vrai entre deux points (identique à nav.js : le cap de marche et le cap de
// survol sont la même grandeur, il n'y a pas de raison qu'ils divergent).
function bearingDeg([lat1, lon1], [lat2, lon2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (Math.atan2(y, x) * 180) / Math.PI;
}

// Lissage angulaire par le PLUS COURT ARC : sans lui, la caméra fait un tour complet
// chaque fois que le cap franchit le nord (359° → 1°).
function smoothAngle(from, to, k) {
  let d = ((to - from + 540) % 360) - 180;
  return from + d * k;
}

/**
 * @param {HTMLElement} container
 * @param {object}   trail          l'itinéraire (pour sa distance annoncée)
 * @param {Array}    track          [[lat,lon]…] — le fil sur lequel `eles` a été relevé
 * @param {number[]} [eles]         altitudes alignées sur `track`
 * @param {Function} [onFrame]      ({f, km, alt}) à chaque image du survol
 * @returns {Promise<object>} poignée { setProgress, play, pause, toggle, playing,
 *                                      setLayer, destroy }
 */
export async function open(container, trail, track, eles = null, { onFrame = null } = {}) {
  const pts = (track || []).filter((p) => Array.isArray(p) && p.length >= 2);
  if (pts.length < 2) throw new Error("tracé illisible");

  // `ensureElevation` relève l'altitude sur sampleTrack(mainline, 100) et la vue reçoit
  // sampleTrack(mainline, 300) : deux échantillons du MÊME fil, pris par proportion
  // d'indice. Une fraction du parcours désigne donc le même endroit dans les deux — c'est
  // par cette fraction qu'on lit l'altitude, jamais par l'indice brut (qui pointerait
  // trois fois trop loin).
  const alts = Array.isArray(eles) && eles.length > 1 ? eles : null;
  const altAt = (f) => {
    if (!alts) return null;
    const x = clamp(f, 0, 1) * (alts.length - 1);
    const i = Math.floor(x), j = Math.min(i + 1, alts.length - 1);
    return alts[i] + (alts[j] - alts[i]) * (x - i);
  };

  // Distances réelles, recalées sur la distance annoncée : le cumul d'un échantillon coupe
  // les virages et sous-estime (même correction que profile.js).
  const cum = cumulativeKm(pts);
  const raw = cum[cum.length - 1] || 1;
  const scale = trail?.distance > 0 ? trail.distance / raw : 1;
  const km = cum.map((c) => c * scale);
  const totalKm = km[km.length - 1] || 1;

  const map = createFicheMap(container, { layer: "satellite", attribution: true, maxPitch: 80 });
  map.dragRotate.enable();
  map.touchZoomRotate.enableRotation();
  map.touchPitch?.enable();

  await new Promise((resolve, reject) => {
    map.once("load", resolve);
    map.once("error", (e) => reject(new Error(e?.error?.message || "relief indisponible")));
  });

  enableTerrainOn(map);
  const line = drawTrackOn(map, trail?.segments || pts, { weight: 5 });
  // Cadrage : à PLAT d'abord (c'est le seul état où `fitBounds` cadre juste — incliné, il
  // rentrait la caméra dans le versant et le tracé finissait derrière une crête), puis on
  // penche et on recule un peu pour dégager le relief.
  map.fitBounds(line.getBounds(), { padding: 40, bearing: 0, pitch: 0, duration: 0 });
  map.jumpTo({ pitch: PITCH, zoom: map.getZoom() - 0.45 });

  const endMarker = (lat, lon, cls) =>
    domMarker(lat, lon, { element: makeIcon(`f3d-end ${cls}`) }).addTo(map);
  const marks = [
    endMarker(pts[0][0], pts[0][1], "f3d-start"),
    endMarker(pts[pts.length - 1][0], pts[pts.length - 1][1], "f3d-finish"),
  ];

  const beadEl = makeIcon("f3d-bead");
  const bead = domMarker(pts[0][0], pts[0][1], { element: beadEl }).addTo(map);

  // Hauteur de vol au-dessus du marcheur, et distances de recul/visée qui en découlent.
  // Régler un `zoom` + un `pitch` fixes ne marche pas sur du relief : la caméra finit DANS
  // la pente et l'imagerie rasante s'étire en flou (constaté aux deux premières mises au
  // point). On raisonne donc en mètres — position de l'œil, point visé, altitudes réelles —
  // et `calculateCameraOptionsFromTo` en déduit zoom, pitch et cap cohérents avec le
  // terrain.
  //
  // Le recul et la visée se RAISONNENT EN ANGLES avant de s'écrire en mètres : c'est la
  // seule façon de garantir que la bille est dans le cadre. MapLibre voit 36,9° en
  // vertical, soit ±18,4° autour du centre de l'image, et le centre de l'image est le point
  // VISÉ (`calculateCameraOptionsFromTo` centre la carte sur `to`). Avec l'ancien réglage
  // — recul 0,6 × la hauteur, visée 1,5 × — le marcheur tombait à 59° sous l'horizon pour
  // une visée à 25° : 34° d'écart, soit près de DEUX fois le demi-champ. La bille se
  // projetait à 150 % de la hauteur d'écran, une demi-image sous le bord bas : jamais
  // visible du survol (« on ne voit pas le point »).
  // On garde donc la visée à ~25° sous l'horizon — c'est elle qui fixe l'inclinaison de
  // ~65° d'où viennent l'horizon et le relief au loin — et on RECULE jusqu'à ramener le
  // marcheur à ~34°, soit 9° sous le centre : la bille se pose au tiers bas de l'image,
  // cadrage de caméra de poursuite. Reculer ne dézoome pas : la distance œil→centre ne
  // dépend que de la hauteur de vol et de l'inclinaison, toutes deux inchangées.
  // ESPACE RENDU. `enableTerrainOn` exagère le relief (× DEM_EXAGGERATION) : le sol que
  // l'on VOIT est à `alt × 1,4`, pas à `alt`. La caméra se plaçait pourtant aux altitudes
  // vraies — sur un tracé à 2 000 m, elle visait 2 000 m alors que le terrain culminait à
  // 2 800 m sous elle. Avec 1 000 m de hauteur de vol il ne restait que 200 m de garde :
  // la caméra rasait les crêtes en permanence, d'où les montagnes qui passaient devant la
  // bille et l'imagerie rasante et floue signalée dès les premières mises au point. Toute
  // altitude confiée à la caméra passe désormais par `rendered()`.
  const rendered = (alt) => (alt ?? 0) * DEM_EXAGGERATION;

  // Hauteur de vol RÉELLE au-dessus du sol rendu. Elle était gonflée (700–1 600 m) pour
  // compenser à l'aveugle la garde manquante ; la garde étant maintenant honnête, on
  // redescend d'autant, sinon on survole le massif de trop haut pour le lire.
  const flyH = clamp(500 + totalKm * 45, 500, 1200); // œil au-dessus du point courant
  const BACK_M = flyH * 1.5;    // recul derrière le marcheur → ~34° sous l'horizon
  const LEAD_M = flyH * 0.65;   // point visé au-delà de lui  → ~25°, l'assiette de la vue
  // ~25 s pour une courte, plafonné à 70 s : au-delà on ne regarde plus, on attend.
  const flyMs = clamp(25000 + totalKm * 2500, 25000, 70000);

  // Déplacement d'un point de `d` mètres selon un cap (approximation plane : sur 1 à 2 km
  // l'erreur est très inférieure à la taille d'un pixel de terrain).
  function moveLatLon(lat, lon, brg, d) {
    const r = (brg * Math.PI) / 180;
    return [
      lat + (d * Math.cos(r)) / 110540,
      lon + (d * Math.sin(r)) / (111320 * Math.cos((lat * Math.PI) / 180)),
    ];
  }

  let raf = null, playing = false, t0 = 0, tPrev = 0, f0 = 0, bearing = null, dead = false, lastF = 0;

  // Point d'ancrage de la caméra : une position LISSÉE dans le temps, jamais la position
  // exacte du marcheur. Accrochée au point exact, la caméra recopiait chaque zigzag du
  // tracé échantillonné et chaque bosse du profil : la bille restait clouée au même pixel
  // et c'était le PAYSAGE qui tremblait. Ici la caméra glisse vers le marcheur au lieu de
  // lui coller, ce qui fait dériver la bille autour de sa place — elle remonte vers le
  // centre dans les lignes droites, s'écarte sur le côté dans les virages, revient d'elle
  // même. C'est ce jeu qui donne le vivant ; le survol rigide donnait la maquette.
  // Constante de temps volontairement plus courte que celle du cap (1,8 s) : la caméra
  // doit se replacer plus vite qu'elle ne se réoriente, sinon elle vire avant d'avancer.
  const CAM_TAU = 900;
  // Retard maximal toléré, en mètres. Il borne la dérive DANS TOUS LES SENS, donc aussi
  // latéralement : à 0,25 × la hauteur de vol pour un recul de 1,5 ×, la bille s'écarte au
  // plus de ~9,5° de l'axe, ce qui tient même dans le demi-champ horizontal d'un cadre
  // portrait de téléphone (~11°). Au-delà on rattrape, la bille ne sort pas de l'image.
  const MAX_LAG_M = flyH * 0.25;
  const M_PER_LAT = 110540;
  const mPerLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);
  let anchor = null; // { lat, lon, alt, leadAlt } — lissés

  // Altitude du sol sous le point visé : lue sur le tracé à la distance LEAD_M en avant,
  // convertie en fraction de parcours. L'ancienne version lisait « f + 3 % », une avance
  // qui valait 150 m sur une courte et 900 m sur une longue alors que la visée, elle, est
  // en mètres : l'assiette de la caméra changeait avec la longueur de l'itinéraire.
  const leadF = LEAD_M / 1000 / totalKm;
  const leadAltAt = (f) => altAt(Math.min(1, f + leadF));

  // Position (lat, lon, km, alt) à la fraction f du tracé, par interpolation entre les
  // deux points encadrants — jamais un saut de point à point : c'est là que naissaient
  // les saccades de l'ancienne jauge.
  function at(f) {
    const x = clamp(f, 0, 1) * (pts.length - 1);
    const i = Math.floor(x), j = Math.min(i + 1, pts.length - 1), r = x - i;
    const lat = pts[i][0] + (pts[j][0] - pts[i][0]) * r;
    const lon = pts[i][1] + (pts[j][1] - pts[i][1]) * r;
    return { lat, lon, km: km[i] + (km[j] - km[i]) * r, alt: altAt(f), i, j };
  }

  // Cap = **corde large** entre un point en arrière et un point loin devant (retour
  // utilisateur : à 3 % d'avance, la caméra suivait chaque lacet et le survol tanguait).
  // Une corde qui enjambe les virages donne la direction GÉNÉRALE de la marche ; les
  // épingles d'un versant ne la font plus bouger.
  const HEAD_BACK = 0.03, HEAD_AHEAD = 0.12;
  function headingAt(f) {
    const a = at(clamp(f - HEAD_BACK, 0, 1));
    const b = at(clamp(f + HEAD_AHEAD, 0, 1));
    if (a.lat === b.lat && a.lon === b.lon) return bearing ?? 0;
    return bearingDeg([a.lat, a.lon], [b.lat, b.lon]);
  }

  // Hors survol, la caméra ne suit PAS en permanence (refus utilisateur acté sur l'ancienne
  // vue 3D) : elle ne se déplace que si la bille sort du cadre. Patron de nav.js.
  function nudgeIntoView(lat, lon) {
    const c = map.getCanvas();
    const p = map.project([lon, lat]);
    const mx = c.clientWidth * 0.18, my = c.clientHeight * 0.18;
    if (p.x < mx || p.x > c.clientWidth - mx || p.y < my || p.y > c.clientHeight - my) {
      map.easeTo({ center: [lon, lat], duration: 450 });
    }
  }

  // ---------- Anti-occlusion : garder la bille en vue ----------
  // Même une caméra à la bonne altitude finit derrière une crête quand le marcheur bascule
  // de l'autre côté d'un col. Trois parades, dans cet ordre de préférence : PIVOTER autour
  // du marcheur (on contourne un contrefort sans rien changer d'autre), se RAPPROCHER (la
  // ligne de visée se redresse et franchit la crête ; ce n'est pas un dézoom, la bille
  // descend juste un peu dans l'image), et seulement si rien n'y fait, PRENDRE DE
  // L'ALTITUDE — arbitrage tranché avec l'utilisateur : mieux vaut une montée passagère
  // qu'une bille disparue.
  const NO_AVOID = { pivot: 0, pull: 1, lift: 1 };
  let avoid = { ...NO_AVOID };       // parade appliquée, lissée
  let avoidGoal = { ...NO_AVOID };   // parade visée, réévaluée par paliers
  let dem = null, demTried = false, lastProbe = 0;
  let walker = null; // position VRAIE du marcheur (l'ancrage, lui, est en retard)

  // Le MNT sert à lancer un rayon, ce que `queryTerrainElevation` ne sait pas faire
  // (il ne répond que pour les tuiles chargées au zoom courant — cf. l'en-tête de dem.js).
  // Chargé en arrière-plan APRÈS l'ouverture de la vue : l'évitement s'allume quand il est
  // prêt, et son absence (hors-ligne sur une zone jamais vue) ne coûte que lui-même.
  function ensureDem() {
    if (demTried) return;
    demTried = true;
    const mid = at(0.5);
    const halfKm = (cum[cum.length - 1] || 2) / 2;
    loadDem(mid.lat, mid.lon, { nearKm: Math.max(6, halfKm + 2), farKm: 25 })
      .then((d) => { if (!dead) dem = d; })
      .catch(() => { /* relief illisible : on survole sans évitement */ });
  }

  const SIGHT_SAMPLES = 10;
  const SIGHT_MARGIN = 25;  // m : sous cette marge, une bosse ne « cache » pas vraiment
  const SIGHT_SKIP = 0.15;  // on ignore le voisinage immédiat du marcheur (sa propre cellule)

  /**
   * La bille est-elle visible depuis l'œil placé par cette parade ? Échantillonne le
   * terrain le long du segment bille → œil et le compare à la ligne de visée, le tout dans
   * l'espace rendu.
   *
   * Le rayon part du MARCHEUR, pas de l'ancrage : c'est la bille qu'on veut voir, et
   * l'ancrage traîne derrière elle (jusqu'à `MAX_LAG_M`) — sur un versant raide, cela fait
   * des dizaines de mètres d'altitude d'écart. Partir de l'ancrage testait la visibilité
   * d'un point où personne ne se trouve, et laissait passer de vraies occultations.
   */
  function sightClear(cand, anc, w) {
    const back = BACK_M * cand.pull;
    const [elat, elon] = moveLatLon(anc.lat, anc.lon, bearing + 180 + cand.pivot, back);
    const eyeAlt = rendered(anc.alt) + flyH * cand.lift;
    const beadAlt = rendered(w.alt);
    for (let i = 1; i <= SIGHT_SAMPLES; i++) {
      const t = SIGHT_SKIP + ((1 - SIGHT_SKIP) * i) / (SIGHT_SAMPLES + 1); // 0 = bille, 1 = œil
      const lat = w.lat + (elat - w.lat) * t;
      const lon = w.lon + (elon - w.lon) * t;
      const h = dem.elevationAt(lat, lon);
      if (h == null) continue; // hors couverture : on ne conclut pas à un obstacle
      if (h * DEM_EXAGGERATION > beadAlt + (eyeAlt - beadAlt) * t + SIGHT_MARGIN) return false;
    }
    return true;
  }

  // Où la bille tombe-t-elle dans l'image, pour cette parade ? Une parade qui dégage la
  // vue mais chasse la bille hors cadre n'a rien résolu. On PROJETTE donc, plutôt que
  // d'estimer des angles : base caméra (avant / droite / haut) déduite de l'œil et du point
  // visé, focale tirée du champ vertical de MapLibre — même construction que le disque
  // solaire de sunview.js. Un premier jet bornait le pivot par une trigonométrie
  // approximative qui confondait l'angle de pivot et l'angle À L'ÉCRAN (trois fois plus
  // petit) : elle interdisait toute parade, y compris sur un grand écran.
  const HALF_FOV_T = Math.tan(0.6435011087932844 / 2);
  function beadScreen(cand, anc, w) {
    const [elat, elon] = moveLatLon(anc.lat, anc.lon, bearing + 180 + cand.pivot, BACK_M * cand.pull);
    const [tlat, tlon] = moveLatLon(anc.lat, anc.lon, bearing, LEAD_M);
    const eyeAlt = rendered(anc.alt) + flyH * cand.lift;
    const perLon = mPerLon(elat);
    const enu = (lat, lon, alt) => [(lon - elon) * perLon, (lat - elat) * M_PER_LAT, alt - eyeAlt];
    const norm = (v) => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const fwd = norm(enu(tlat, tlon, rendered(anc.leadAlt)));
    const rgt = norm(cross(fwd, [0, 0, 1]));
    const up = cross(rgt, fwd);
    const s = norm(enu(w.lat, w.lon, rendered(w.alt)));
    const depth = dot(s, fwd);
    if (depth <= 0.01) return null; // derrière la caméra
    const c = map.getCanvas();
    const aspect = (c.clientWidth || 1) / (c.clientHeight || 1);
    const focal = 1 / (2 * HALF_FOV_T); // en fraction de HAUTEUR d'image
    return { x: 0.5 + ((focal / aspect) * dot(s, rgt)) / depth, y: 0.5 - (focal * dot(s, up)) / depth };
  }

  // Marges de sécurité : la bille doit rester franchement dans l'image, pas frôler le bord.
  const SAFE = { x0: 0.08, x1: 0.92, y0: 0.12, y1: 0.9 };

  // Où sera la scène dans ~0,8 s. La parade doit être EN PLACE quand la crête arrive, pas
  // s'amorcer à l'instant où elle mord : réagir après coup laisse toujours passer le
  // moment où la bille disparaît. Mesuré sur un franchissement du Galibier : 2,3 % → 1,4 %
  // d'images occultées, avec MOINS de parades déclenchées (7,6 % → 7,2 %).
  const LOOK_MS = 800;
  function anticipate(f) {
    const pa = at(clamp(f + LOOK_MS / flyMs, 0, 1));
    const d = { lat: pa.lat - walker.lat, lon: pa.lon - walker.lon, alt: (pa.alt ?? 0) - walker.alt };
    return {
      anc: { lat: anchor.lat + d.lat, lon: anchor.lon + d.lon, alt: anchor.alt + d.alt, leadAlt: anchor.leadAlt },
      w: { lat: pa.lat, lon: pa.lon, alt: pa.alt ?? 0 },
    };
  }

  // Cherche la parade la moins intrusive qui dégage la vue. L'ordre des candidats EST la
  // hiérarchie voulue : pivot seul, puis rapprochement, puis montée.
  const PIVOTS = [10, -10, 20, -20, 30, -30];
  function planAvoidance(f) {
    if (!dem || !walker || !anchor) return NO_AVOID;
    const { anc, w } = anticipate(f);
    if (sightClear(NO_AVOID, anc, w)) return NO_AVOID;
    const usable = (c) => {
      if (!sightClear(c, anc, w)) return false;
      const s = beadScreen(c, anc, w);
      return !!s && s.x > SAFE.x0 && s.x < SAFE.x1 && s.y > SAFE.y0 && s.y < SAFE.y1;
    };
    for (const pivot of PIVOTS) {
      const c = { pivot, pull: 1, lift: 1 };
      if (usable(c)) return c;
    }
    for (const pull of [0.9, 0.8]) {
      for (const pivot of [0, ...PIVOTS]) {
        const c = { pivot, pull, lift: 1 };
        if (usable(c)) return c;
      }
    }
    for (const lift of [1.2, 1.4, 1.6]) {
      for (const pivot of [0, ...PIVOTS]) {
        const c = { pivot, pull: 0.85, lift };
        if (usable(c)) return c;
      }
    }
    // Rien ne dégage (fond de gorge) : on garde la meilleure tentative plutôt que de
    // s'agiter — une caméra qui cherche sans trouver est pire que la crête elle-même.
    return { pivot: 0, pull: 0.85, lift: 1.6 };
  }

  // Le plan se réévalue par paliers (~150 ms) et non par image : le résultat ne change pas
  // assez vite pour le justifier, et c'est le lissage qui porte la douceur.
  const AVOID_TAU = 900, PROBE_MS = 150;
  function trackAvoidance(now, dt, f) {
    if (dem && now - lastProbe > PROBE_MS) {
      lastProbe = now;
      avoidGoal = planAvoidance(f);
    }
    const k = 1 - Math.exp(-Math.min(dt, 100) / AVOID_TAU);
    avoid = {
      pivot: avoid.pivot + (avoidGoal.pivot - avoid.pivot) * k,
      pull: avoid.pull + (avoidGoal.pull - avoid.pull) * k,
      lift: avoid.lift + (avoidGoal.lift - avoid.lift) * k,
    };
  }

  // Recale l'ancrage sur le marcheur, d'un pas d'autant plus grand que l'image a duré —
  // même raisonnement que le lissage du cap : la caméra doit mettre le même temps à
  // rattraper, que la machine affiche à 30 ou à 120 images par seconde.
  function trackAnchor(f, dt) {
    const p = at(f);
    const ground = p.alt ?? 0;
    const lead = leadAltAt(f) ?? ground;
    walker = { lat: p.lat, lon: p.lon, alt: ground };
    if (!anchor) { anchor = { lat: p.lat, lon: p.lon, alt: ground, leadAlt: lead }; return; }
    const k = 1 - Math.exp(-Math.min(dt, 100) / CAM_TAU);
    anchor.lat += (p.lat - anchor.lat) * k;
    anchor.lon += (p.lon - anchor.lon) * k;
    // Les altitudes se lissent aussi : sans cela la caméra monte et descend à chaque
    // ressaut du profil et le survol tangue verticalement.
    anchor.alt += (ground - anchor.alt) * k;
    anchor.leadAlt += (lead - anchor.leadAlt) * k;
    const dy = (p.lat - anchor.lat) * M_PER_LAT;
    const dx = (p.lon - anchor.lon) * mPerLon(p.lat);
    const d = Math.hypot(dx, dy);
    if (d > MAX_LAG_M) {
      const s = 1 - MAX_LAG_M / d; // ramène l'ancrage juste à la limite, sans à-coup visible
      anchor.lat += (p.lat - anchor.lat) * s;
      anchor.lon += (p.lon - anchor.lon) * s;
    }
  }

  // Prise de vue « caméra de poursuite » : l'œil en arrière et au-dessus de l'ancrage, la
  // visée au-delà. Elle ne lit plus `f` — c'est justement l'écart entre l'ancrage lissé et
  // la fraction courante qui laisse respirer la bille.
  //
  // `avoid` est la parade anti-occlusion en cours (cf. clearSight) : un pivot autour du
  // marcheur, un rapprochement, et en dernier recours une prise d'altitude.
  function chaseCamera(avoid = NO_AVOID) {
    const back = BACK_M * avoid.pull;
    const [clat, clon] = moveLatLon(anchor.lat, anchor.lon, bearing + 180 + avoid.pivot, back);
    const [tlat, tlon] = moveLatLon(anchor.lat, anchor.lon, bearing, LEAD_M);
    return map.calculateCameraOptionsFromTo(
      new maplibregl.LngLat(clon, clat), rendered(anchor.alt) + flyH * avoid.lift,
      new maplibregl.LngLat(tlon, tlat), rendered(anchor.leadAlt)
    );
  }

  function setProgress(f, { follow = false, dt = 16 } = {}) {
    if (dead) return null;
    const p = at(f);
    bead.setLngLat([p.lon, p.lat]);
    if (follow) {
      // Lissage en TEMPS (constante ~1,8 s), pas par image : un coefficient fixe par image
      // rend la caméra d'autant plus nerveuse que la machine affiche vite, et c'est
      // exactement le tangage signalé. Ici le cap met le même temps à rattraper partout.
      const k = 1 - Math.exp(-Math.min(dt, 100) / 1800);
      bearing = bearing == null ? headingAt(f) : smoothAngle(bearing, headingAt(f), k);
      trackAnchor(f, dt);
      trackAvoidance(performance.now(), dt, f);
      // `jumpTo` et non `easeTo` : une animation de caméra par image, ce sont deux
      // animations concurrentes qui se disputent la même valeur (cf. nav.js).
      map.jumpTo(chaseCamera(avoid));
    } else {
      nudgeIntoView(p.lat, p.lon);
    }
    return { km: p.km, alt: p.alt, f: clamp(f, 0, 1) };
  }

  function frame(now) {
    if (!playing) return;
    const f = clamp(f0 + (now - t0) / flyMs, 0, 1);
    lastF = f; // une pause reprend exactement où le survol en était
    const dt = now - (tPrev || now);
    tPrev = now;
    const r = setProgress(f, { follow: true, dt });
    onFrame?.({ ...r, playing: f < 1 });
    if (f >= 1) { playing = false; raf = null; return; }
    raf = requestAnimationFrame(frame);
  }

  function play(from = null) {
    if (dead || playing) return;
    // Relancer depuis la fin repart du départ : sinon le bouton ne ferait rien.
    const start = from != null ? from : (lastF >= 0.999 ? 0 : lastF);
    f0 = start;
    t0 = performance.now();
    playing = true;
    bearing = headingAt(start);
    // L'ancrage repart PILE sur le point de départ (pas de retard hérité d'un survol
    // précédent), le jeu se réinstalle ensuite tout seul dans les premières secondes.
    anchor = null;
    trackAnchor(start, 0);
    // La parade d'entrée est calculée SÈCHE (pas lissée) : le plan d'ouverture doit être
    // dégagé dès la première image, il n'y a rien avant lui à quoi enchaîner en douceur.
    avoidGoal = avoid = planAvoidance(start);
    lastProbe = performance.now();
    map.easeTo({ ...chaseCamera(avoid), duration: 900 });
    // Le suivi démarre après le cadrage, sinon les deux se marchent dessus.
    setTimeout(() => { if (playing) { t0 = tPrev = performance.now(); raf = requestAnimationFrame(frame); } }, 900);
  }

  function pause() {
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }

  // Le MNT de l'évitement se charge en fond, sans retenir l'affichage : la vue est déjà
  // utilisable, l'anti-occlusion s'ajoute quand elle est prête. Appelé ICI et non à la
  // création de la bille : `demTried` et `dead` sont déclarés plus bas en `let`, les lire
  // plus tôt lèverait une erreur de zone morte temporelle.
  ensureDem();

  return {
    map,
    // Jauge glissée à la main : coupe le survol en cours (deux pilotes sur la même bille
    // se battraient) et repositionne sans imposer le cadrage.
    setProgress(f) {
      if (playing) pause();
      lastF = clamp(f, 0, 1);
      return setProgress(lastF);
    },
    play: (from) => play(from),
    pause,
    toggle() { playing ? pause() : play(); return playing; },
    playing: () => playing,
    // Bascule du fond sans reconstruire le style : seule l'URL de la source change, le
    // tracé, les marqueurs et le relief restent en place.
    setLayer(name) {
      const src = map.getSource("base");
      const tiles = layerTiles(name);
      if (src && tiles) src.setTiles(tiles);
    },
    destroy() {
      dead = true;
      pause();
      [bead, ...marks].forEach((m) => m.remove());
      map.remove();
    },
  };
}
