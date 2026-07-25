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
import { createFicheMap, enableTerrainOn, drawTrackOn, domMarker, makeIcon, layerTiles } from "./map.js";
import { cumulativeKm } from "./metrics.js";

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
  // terrain. Il faut viser LOIN et voler HAUT : une visée à ~1,5 × la hauteur de vol donne
  // l'inclinaison d'environ 65° de la prise de vue de survol classique ; viser 500 m devant
  // ne montrait que le versant d'en face, sans horizon.
  const flyH = clamp(700 + totalKm * 60, 700, 1600); // œil au-dessus du point courant
  const BACK_M = flyH * 0.6;    // recul derrière le marcheur
  const LEAD_M = flyH * 1.5;    // point visé devant lui
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

  // Prise de vue « caméra de poursuite » à la fraction f : l'œil en arrière et au-dessus
  // du marcheur, la visée devant lui, aux altitudes réelles du tracé.
  function chaseCamera(f) {
    const p = at(f);
    const ground = p.alt ?? 0;
    const [clat, clon] = moveLatLon(p.lat, p.lon, bearing + 180, BACK_M);
    const [tlat, tlon] = moveLatLon(p.lat, p.lon, bearing, LEAD_M);
    return map.calculateCameraOptionsFromTo(
      new maplibregl.LngLat(clon, clat), ground + flyH,
      new maplibregl.LngLat(tlon, tlat), (altAt(Math.min(1, f + 0.03)) ?? ground)
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
      // `jumpTo` et non `easeTo` : une animation de caméra par image, ce sont deux
      // animations concurrentes qui se disputent la même valeur (cf. nav.js).
      map.jumpTo(chaseCamera(f));
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
    map.easeTo({ ...chaseCamera(start), duration: 900 });
    // Le suivi démarre après le cadrage, sinon les deux se marchent dessus.
    setTimeout(() => { if (playing) { t0 = tPrev = performance.now(); raf = requestAnimationFrame(frame); } }, 900);
  }

  function pause() {
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }

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
