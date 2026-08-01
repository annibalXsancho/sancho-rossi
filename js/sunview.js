// Sancho Rossi — le soleil posé sur la vue 3D (S-SOLEIL)
//
// Greffe sur la carte inclinée de fiche3d.js : ombres portées drapées sur le relief,
// disque solaire dans le ciel, et sonde d'ensoleillement au tap. Le calcul est dans
// sun.js, le terrain dans dem.js — ici, uniquement le rendu et les gestes.
import { domMarker, makeIcon } from "./map.js";
import { loadDem } from "./dem.js";
import { horizonProfile, sunWindow, sunPath, terrainGrid, shadeGrid, shadeToImageData } from "./sun.js";
import { sunPosition } from "./astro.js";

const SHADE_ID = "sun-shade";
const GRID = 192; // 192² : ~40 ms de recalcul, imperceptible au glissé du curseur

const RAD = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const hhmm = (d) =>
  d ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "—";
export const duration = (min) =>
  `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, "0")}`;

// Direction cardinale d'un azimut — « derrière la crête ouest » parle, « à 276° » non.
const CARDINALS = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"];
export const cardinal = (az) => CARDINALS[Math.round((((az % 360) + 360) % 360) / 45) % 8];
// « au nord », mais « à l'est » et « à l'ouest » : l'élision se joue sur la voyelle initiale.
export const towards = (az) => {
  const c = cardinal(az);
  return /^[aeiouy]/.test(c) ? `à l'${c}` : `au ${c}`;
};

function bboxOf(points, pad = 0.15) {
  let w = 180, e = -180, s = 90, n = -90;
  for (const [lat, lon] of points) {
    if (lat < s) s = lat; if (lat > n) n = lat;
    if (lon < w) w = lon; if (lon > e) e = lon;
  }
  // Marge minimale : sur un tracé très court, une emprise serrée ne montrerait aucune
  // ombre venue des versants alentour — or ce sont eux qui font l'ombre.
  const dy = Math.max((n - s) * pad, 0.012), dx = Math.max((e - w) * pad, 0.012);
  return { west: w - dx, east: e + dx, south: s - dy, north: n + dy };
}

// ---------- Cadran solaire ----------
// Projection polaire type fisheye : le zénith au centre, l'horizon sur le bord, le nord en
// haut. C'est la représentation qui montre d'un coup d'œil CE QUI mange le soleil — la
// silhouette des crêtes et la course du jour dans le même cadre.
const DIAL = 150, DR = 66; // taille du SVG, rayon utile
const ALT_MIN = -10; // on descend sous l'horizontale : depuis un sommet, l'horizon plonge

function polar(az, alt) {
  const r = (DR * (90 - clamp(alt, ALT_MIN, 90))) / (90 - ALT_MIN);
  return [DIAL / 2 + r * Math.sin(az * RAD), DIAL / 2 - r * Math.cos(az * RAD)];
}

/**
 * Cadran SVG : silhouette du relief réel + course du soleil du jour, la part ensoleillée
 * en ambre, la part masquée en gris. Rendu en chaîne pour être inséré tel quel.
 */
export function dialSvg(profile, path, nowMin = null) {
  // Silhouette : le contour du relief, refermé sur le bord du cadran → la zone hachurée
  // est ce que les crêtes occultent.
  const ridge = [];
  for (let a = 0; a <= 360; a += 2) ridge.push(polar(a, profile[a % 360]).map((v) => v.toFixed(1)).join(","));
  const edge = [];
  for (let a = 360; a >= 0; a -= 2) edge.push(polar(a, ALT_MIN).map((v) => v.toFixed(1)).join(","));

  // Course du soleil. Tracée DEUX FOIS, de part et d'autre de la silhouette : le jour
  // entier en trait sourd DESSOUS, puis les seules portions ensoleillées en ambre DESSUS.
  // L'arc semble alors plonger derrière les crêtes et en ressortir — la lecture est
  // immédiate, là où deux couleurs côte à côte au-dessus du relief se confondaient.
  const poly = (pts, stroke, w, extra = "") =>
    `<polyline points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ")}"
       fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round"
       stroke-linejoin="round"${extra}/>`;

  const arc = path.map((p) => polar(p.az, p.alt));
  const full = path.length > 1 ? poly(arc, "rgba(255,255,255,.28)", 1.4) : "";
  // Rappel ténu de la course PAR-DESSUS la silhouette : sans lui, un point qui ne voit
  // jamais le soleil affiche un cadran muet, où l'on ne devine même pas de combien la
  // crête le manque. Assez pâle pour ne jamais concurrencer l'ambre du soleil visible.
  const buried = path.length > 1
    ? poly(arc, "rgba(255,255,255,.16)", 1, ' stroke-dasharray="1.5 3"')
    : "";
  const runs = [];
  for (const p of path) {
    const last = runs[runs.length - 1];
    // Un point de raccord de part et d'autre de la bascule, sinon les segments ambrés
    // s'arrêtent visiblement avant la crête au lieu de s'y enfoncer.
    if (!last || last.lit !== p.lit) {
      const seed = last ? [last.pts[last.pts.length - 1]] : [];
      runs.push({ lit: p.lit, pts: [...seed, polar(p.az, p.alt)] });
    } else last.pts.push(polar(p.az, p.alt));
  }
  const paths = runs
    .filter((r) => r.lit && r.pts.length > 1)
    .map((r) => poly(r.pts, "#ffb02e", 2.6))
    .join("");

  const cur = nowMin == null ? null : path.reduce(
    (best, p) => (best == null || Math.abs(p.min - nowMin) < Math.abs(best.min - nowMin) ? p : best), null);
  const dot = cur
    ? (([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="${cur.lit ? "#ffb02e" : "#8a8a92"}"
         stroke="rgba(9,9,11,.75)" stroke-width="2"/>`)(polar(cur.az, cur.alt))
    : "";

  const marks = [["N", 0], ["E", 90], ["S", 180], ["O", 270]]
    .map(([l, a]) => {
      const [x, y] = polar(a, ALT_MIN - 5);
      return `<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="middle">${l}</text>`;
    })
    .join("");

  return `<svg class="sun-dial" viewBox="0 0 ${DIAL} ${DIAL}" role="img"
    aria-label="Course du soleil et silhouette du relief vues de ce point">
    <circle cx="${DIAL / 2}" cy="${DIAL / 2}" r="${DR}" fill="rgba(120,170,230,.10)"/>
    <circle cx="${DIAL / 2}" cy="${DIAL / 2}" r="${(DR * (90 - 30)) / (90 - ALT_MIN)}"
            fill="none" stroke="rgba(255,255,255,.10)" stroke-dasharray="2 4"/>
    ${full}
    <polygon points="${ridge.join(" ")} ${edge.join(" ")}" fill="#101014"/>
    <polyline points="${ridge.join(" ")}" fill="none" stroke="rgba(255,255,255,.34)" stroke-width="1.2"/>
    ${buried}
    ${paths}${dot}
    <g class="sun-dial-marks">${marks}</g>
  </svg>`;
}

// ---------- Position à l'écran du soleil ----------
// MapLibre ne sait rien dessiner dans le ciel : le disque est un élément DOM posé sur le
// canvas, dont on calcule la projection à la main. La base caméra se déduit du cap et de
// l'inclinaison ; la focale, du champ de vision vertical (0,6435 rad par défaut).
// `transform` est semi-privé : tout est sous garde, et son absence ne coûte que le disque.
function sunScreenPos(map, azDeg, altDeg) {
  try {
    const t = map.transform;
    const fov = t?.fovInRadians ?? (t?.fov != null ? t.fov * RAD : 0.6435011087932844);
    const B = map.getBearing() * RAD;
    const dep = (90 - map.getPitch()) * RAD; // dépression de l'axe de visée sous l'horizontale
    const f = [Math.sin(B) * Math.cos(dep), Math.cos(B) * Math.cos(dep), -Math.sin(dep)];
    const r = [Math.cos(B), -Math.sin(B), 0];
    const u = [Math.sin(B) * Math.sin(dep), Math.cos(B) * Math.sin(dep), Math.cos(dep)];
    const a = azDeg * RAD, h = altDeg * RAD;
    const s = [Math.sin(a) * Math.cos(h), Math.cos(a) * Math.cos(h), Math.sin(h)];
    const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    const depth = dot(s, f);
    if (depth <= 0.02) return null; // derrière la caméra, ou trop rasant pour être stable
    const cv = map.getCanvas();
    const W = cv.clientWidth, H = cv.clientHeight;
    const focal = H / 2 / Math.tan(fov / 2);
    const x = W / 2 + (focal * dot(s, r)) / depth;
    const y = H / 2 - (focal * dot(s, u)) / depth;
    if (x < 0 || x > W) return null; // le soleil est sur un côté : rien à montrer
    // MapLibre ne lève jamais la caméra au-dessus de l'horizontale : au pitch maximal
    // (80°) le haut du cadre plafonne vers +8° de hauteur. Un soleil de midi est donc
    // TOUJOURS hors champ par le haut — le masquer reviendrait à ne l'afficher qu'une
    // heure par jour. On l'épingle alors en haut du cadre, dans sa direction exacte,
    // avec une pastille qui dit « par là, plus haut » plutôt que de mentir sur sa place.
    if (y < 0) return { x, y: 16, above: true };
    if (y > H) return null; // sous le bord bas : le relief le cache de toute façon
    return { x, y, above: false };
  } catch {
    return null;
  }
}

// Teinte du ciel selon la hauteur du soleil : chaude au ras de l'horizon, franche à midi.
// Simple interpolation entre trois ambiances — pas de modèle atmosphérique, l'effet
// recherché est de faire SENTIR l'heure, pas de la simuler.
function skyFor(alt) {
  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const NIGHT = [16, 20, 38], DUSK = [214, 126, 74], DAY = [167, 199, 232];
  const k = clamp((alt + 6) / 12, 0, 1); // −6° (crépuscule) → +6°
  const j = clamp((alt - 6) / 24, 0, 1); // +6° → +30°
  const horizonC = mix(mix(NIGHT, DUSK, k), [230, 238, 246], j);
  return {
    "sky-color": rgb(mix(mix(NIGHT, [90, 110, 150], k), DAY, j)),
    "horizon-color": rgb(horizonC),
    "fog-color": rgb(horizonC),
    "sky-horizon-blend": 0.7, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.25,
  };
}

/**
 * Active le mode soleil sur une vue 3D de fiche.
 *
 * @param {object} view  la poignée rendue par fiche3d.open() (on utilise `view.map`)
 * @param {Array}  track [[lat,lon]…] le tracé, pour cadrer l'emprise des ombres
 * @param {object} [opts] `onProbe(result|null)` à chaque sonde posée (ou retirée)
 * @returns {Promise<object>} { setTime, probeAt, clearProbe, destroy }
 */
export async function attachSun(view, track, { onProbe = null } = {}) {
  const map = view.map;
  const bbox = bboxOf(track);
  const mid = [(bbox.north + bbox.south) / 2, (bbox.east + bbox.west) / 2];
  // Rayon fin calé sur l'emprise réelle : les ombres qui tombent SUR le tracé viennent
  // des versants qui le bordent, pas seulement de son centre.
  const halfKm = Math.max(
    ((bbox.north - bbox.south) * 111.32) / 2,
    ((bbox.east - bbox.west) * 111.32 * Math.cos(mid[0] * RAD)) / 2
  );
  const dem = await loadDem(mid[0], mid[1], { nearKm: Math.max(6, halfKm + 2), farKm: 25 });
  const grid = terrainGrid(dem, bbox, GRID);

  // Ombres : source `image` mise à jour par `updateImage` — API publique et stable, là où
  // le rafraîchissement d'une source `canvas` repose sur un play/pause non documenté. Le
  // coût d'encodage PNG (~10 ms sur 192²) est sans effet, le recalcul étant débounçé.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = GRID;
  const ctx = canvas.getContext("2d");
  const EMPTY = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const coordinates = [
    [bbox.west, bbox.north], [bbox.east, bbox.north],
    [bbox.east, bbox.south], [bbox.west, bbox.south],
  ];
  map.addSource(SHADE_ID, { type: "image", url: EMPTY, coordinates });
  // Insérée juste au-dessus du fond mais SOUS le tracé : un itinéraire qu'on assombrit
  // devient illisible, or c'est le sujet de l'écran. Le tracé est repéré par son TYPE
  // (`line` — les seules couches vectorielles d'une carte de fiche, cf. buildTrack dans
  // map.js) plutôt que par un identifiant, qui est numéroté à la volée (`trk-3-casing`).
  const firstLine = map.getStyle().layers.find((l) => l.type === "line")?.id;
  map.addLayer(
    { id: SHADE_ID, type: "raster", source: SHADE_ID,
      paint: { "raster-opacity": 1, "raster-fade-duration": 0, "raster-resampling": "linear" } },
    firstLine
  );

  // Disque solaire — halo CSS, posé sur le canvas de la carte.
  const disc = document.createElement("div");
  disc.className = "sun-disc";
  disc.style.display = "none";
  map.getContainer().appendChild(disc);

  let probeMarker = null, probeHandle = null, sun = { azimuth: 0, altitude: 0 }, dead = false;

  function placeDisc() {
    const p = sun.altitude > -1 ? sunScreenPos(map, sun.azimuth, sun.altitude) : null;
    if (!p) { disc.style.display = "none"; return; }
    disc.style.display = "";
    disc.classList.toggle("sun-disc-above", !!p.above);
    disc.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%)`;
    // Le soleil rasant est plus gros et plus rouge à l'œil : c'est l'indice visuel de
    // l'heure tardive, celui qu'on cherche justement à lire.
    disc.style.setProperty("--sun-low", String(clamp(1 - sun.altitude / 25, 0, 1).toFixed(2)));
  }
  map.on("move", placeDisc);

  /** Repositionne le soleil à une date/heure donnée : ombres, disque et ciel. */
  function setTime(date) {
    if (dead) return null;
    sun = sunPosition(mid[0], mid[1], date);
    const shade = shadeGrid(grid, sun.azimuth, sun.altitude);
    ctx.putImageData(shadeToImageData(shade, GRID, ctx), 0, 0);
    map.getSource(SHADE_ID)?.updateImage({ url: canvas.toDataURL() });
    try { map.setSky(skyFor(sun.altitude)); } catch { /* ciel indisponible : sans effet */ }
    placeDisc();
    return sun;
  }

  /**
   * Pré-calcule la course du soleil entre deux instants, pour qu'un survol puisse la
   * dérouler sans hoquet.
   *
   * `setTime` recalcule une grille d'ombres 192² — ~40 ms SYNCHRONES. Appelé pendant le
   * survol, il ferait tomber des images à chaque rafraîchissement : inacceptable sur
   * l'écran vitrine du produit. On paie donc tout d'avance, une fois, en rendant la main
   * entre chaque pas pour ne pas figer la page — puis dérouler ne coûte plus qu'un
   * changement d'image.
   *
   * @returns {Promise<{applyAt:Function, steps:number, dispose:Function}>}
   */
  async function prepareCourse(from, to, steps) {
    const span = Math.max(1, to.getTime() - from.getTime());
    const frames = [];
    for (let i = 0; i <= steps; i++) {
      if (dead) break;
      const s = sunPosition(mid[0], mid[1], new Date(from.getTime() + (span * i) / steps));
      const shade = shadeGrid(grid, s.azimuth, s.altitude);
      ctx.putImageData(shadeToImageData(shade, GRID, ctx), 0, 0);
      frames.push(canvas.toDataURL());
      await new Promise((r) => setTimeout(r, 0));
    }
    let shown = -1;
    return {
      steps: frames.length,
      dispose() { frames.length = 0; },
      /**
       * Position exacte du soleil à cette date — le calcul astronomique coûte quelques
       * microsecondes, donc le disque et le ciel restent CONTINUS ; seule l'image d'ombres,
       * elle, se contente du pas pré-calculé le plus proche.
       */
      applyAt(date) {
        if (dead || !frames.length) return null;
        sun = sunPosition(mid[0], mid[1], date);
        const i = clamp(Math.round(((date.getTime() - from.getTime()) / span) * steps), 0, frames.length - 1);
        if (i !== shown) {
          shown = i;
          map.getSource(SHADE_ID)?.updateImage({ url: frames[i] });
          try { map.setSky(skyFor(sun.altitude)); } catch { /* ciel indisponible */ }
        }
        placeDisc();
        return sun;
      },
    };
  }

  /**
   * Sonde un point : horizon réel, plage d'ensoleillement du jour, course du soleil.
   * Charge son propre MNT centré sur le point (tuiles très majoritairement déjà en cache)
   * — l'horizon d'un point de bord d'emprise a besoin des crêtes situées AU-DELÀ.
   */
  async function probeAt(lat, lon, date) {
    const local = await loadDem(lat, lon, { nearKm: 6, farKm: 25 });
    const h = horizonProfile(local, lat, lon);
    if (!h) return null;
    const win = sunWindow(lat, lon, date, h.profile);
    return { lat, lon, ...h, ...win, path: sunPath(lat, lon, date, h.profile) };
  }

  function showProbe(lat, lon) {
    probeMarker?.remove();
    probeMarker = domMarker(lat, lon, { element: makeIcon("sun-probe") }).addTo(map);
  }

  map.on("click", async (e) => {
    if (dead) return;
    const { lat, lng } = e.lngLat;
    showProbe(lat, lng);
    onProbe?.({ pending: true, lat, lon: lng });
    try {
      const r = await probeAt(lat, lng, probeHandle?.date || new Date());
      if (!dead) onProbe?.(r);
    } catch {
      if (!dead) onProbe?.(null);
    }
  });

  probeHandle = {
    date: new Date(),
    setTime(date) { probeHandle.date = date; return setTime(date); },
    prepareCourse,
    probeAt,
    /** Re-sonde le point courant (changement de date) sans nouveau geste. */
    reprobe(date) {
      if (!probeMarker) return Promise.resolve(null);
      const { lat, lng } = probeMarker.getLngLat();
      return probeAt(lat, lng, date);
    },
    hasProbe: () => !!probeMarker,
    clearProbe() {
      probeMarker?.remove();
      probeMarker = null;
      onProbe?.(null);
    },
    destroy() {
      dead = true;
      map.off("move", placeDisc);
      probeMarker?.remove();
      disc.remove();
      if (map.getLayer(SHADE_ID)) map.removeLayer(SHADE_ID);
      if (map.getSource(SHADE_ID)) map.removeSource(SHADE_ID);
      try { map.setSky(skyFor(30)); } catch { /* sans effet */ }
    },
  };
  return probeHandle;
}
