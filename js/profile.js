// Sancho Rossi — profil d'altitude interactif (S-PLAN-B)
//
// Remplace `profileSVGFromValues` (fiche + planificateur), qui rendait une image morte
// sur un axe INDEXÉ. Trois conséquences, corrigées ici :
//
//  1. AXE EN DISTANCE CUMULÉE. Ni les tracés OSM ni la sortie BRouter n'ont de points
//     équidistants : une portion densément échantillonnée (lacets) occupait autant de
//     largeur qu'une ligne droite de plusieurs kilomètres, ce qui montrait des rampes
//     là où le terrain est plat. L'axe passe en km parcourus (metrics.js/cumulativeKm)
//     et l'allure devient lisible — sur TOUS les tracés, pas seulement les planifiés.
//  2. SURVOL LIÉ À LA CARTE. `onHover` sort le point survolé ; l'appelant y accroche
//     son marqueur. `setCursorKm` fait l'inverse (carte → profil) : la synchro va donc
//     dans les deux sens sans que ce module connaisse Leaflet.
//  3. REVÊTEMENT. Une bande sous la courbe + une légende chiffrée en km, quand les
//     `ways` sont là (itinéraires BRouter). Sinon : ni bande ni légende — l'absence de
//     donnée se montre en ne montrant rien, pas en inventant du « sentier » partout.
//
// Le rendu est fait à la largeur MESURÉE (pas de `preserveAspectRatio="none"`) : le
// non-uniforme étirait les textes et les traits. ResizeObserver redessine au besoin.
import { sampleTrack } from "./state.js";
import { cumulativeKm } from "./metrics.js";
import { surfaceBands, surfaceTotals, SURFACE_LABEL, SURFACE_HINT } from "./surface.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const DRAG_MIN_PX = 12; // en deçà, c'est un clic, pas une sélection de zoom

const fr = (v) => v.toLocaleString("fr-FR");
const fmtKm = (v, dec = 1) => v.toFixed(dec).replace(".", ",");

// Pas d'axe « rond » (1, 2, 5 × 10ⁿ) pour ~5 graduations sur la fenêtre visible.
function niceStep(span) {
  const raw = span / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * pow;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Dernier index dont le cumul est ≤ km (recherche dichotomique : appelé à chaque
// mouvement de souris sur des tracés BRouter de plusieurs milliers de points).
function indexAtKm(cum, km) {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= km) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * @param {HTMLElement} container
 * @param {object}   opts
 * @param {number[]} opts.eles      altitudes (m)
 * @param {Array}    opts.track     [[lat,lon]…] — le fil sur lequel `eles` a été relevé
 * @param {Array}    [opts.ways]    tronçons BRouter (revêtement) ; absent = pas de bande
 * @param {number}   [opts.totalKm] distance affichée du tracé, pour recaler l'axe
 * @param {number}   [opts.height]  hauteur en px
 * @param {boolean}  [opts.compact] vignette (planificateur)
 * @param {Function} [opts.onHover] ({lat, lon, km, alt, index}) | null
 * @param {Function} [opts.annotate] (km) => texte ajouté à la bulle de survol (météo
 *                                   à l'heure de passage, S-METEO) ; "" si rien
 * @returns {{destroy, setCursorKm, resetZoom}}
 */
export function createProfile(container, {
  eles, track, ways = null, totalKm = null, height = 150, compact = false, onHover = null,
  annotate = null,
} = {}) {
  if (!Array.isArray(eles) || eles.length < 2) {
    container.innerHTML = `<p class="muted">Profil indisponible.</p>`;
    return { destroy() {}, setCursorKm() {}, resetZoom() {} };
  }

  // `ensureElevation` relève l'altitude sur sampleTrack(mainline, 100), pas sur le
  // tracé entier : rejouer le même échantillonnage réaligne exactement les deux
  // (et ne fait rien quand ils coïncident déjà, cas des itinéraires planifiés).
  let pts = track && track.length === eles.length ? track
    : track ? sampleTrack(track, eles.length) : null;
  if (pts && pts.length !== eles.length) pts = null;

  const cum = pts ? cumulativeKm(pts) : eles.map((_, i) => i);
  const rawTotal = cum[cum.length - 1] || 1;
  // Le cumul d'un échantillon coupe les virages et sous-estime la distance : on le
  // recale sur la distance annoncée du tracé, sinon l'axe s'arrêterait avant elle.
  const kmScale = pts && totalKm > 0 ? totalKm / rawTotal : 1;
  const km = cum.map((c) => c * kmScale);
  const total = km[km.length - 1] || 1;

  const bands = pts ? surfaceBands(ways, total) : null;
  const totals = surfaceTotals(bands);

  const PAD_L = 8, PAD_R = 8;
  const padTop = compact ? 4 : 8;
  const axisH = compact ? 12 : 15;
  const bandH = bands ? (compact ? 4 : 6) : 0;
  const bandGap = bands ? 4 : 0;

  container.innerHTML = `
    <div class="prof${compact ? " prof-compact" : ""}">
      <div class="prof-plot">
        <svg class="prof-svg" role="img"></svg>
        <div class="prof-tip hidden"></div>
        <button class="prof-unzoom hidden" type="button" title="Revoir tout le tracé">↺</button>
      </div>
      ${totals.length ? `<div class="prof-legend">${totals
        .map(({ cls, km: k }) => `<span class="prof-leg" title="${SURFACE_HINT[cls]}">
            <i class="prof-swatch" data-cls="${cls}"></i>${SURFACE_LABEL[cls]}
            <b>${fmtKm(k)} km</b></span>`)
        .join("")}</div>` : ""}
    </div>`;

  const root = container.querySelector(".prof");
  const plot = container.querySelector(".prof-plot");
  const svg = container.querySelector(".prof-svg");
  const tip = container.querySelector(".prof-tip");
  const unzoomBtn = container.querySelector(".prof-unzoom");
  plot.style.height = `${height}px`;

  const gStatic = document.createElementNS(SVG_NS, "g");
  const gCursor = document.createElementNS(SVG_NS, "g");
  gCursor.setAttribute("class", "prof-cursor hidden");
  gCursor.innerHTML =
    `<line class="prof-cursor-line" y1="0" y2="0" vector-effect="non-scaling-stroke" />` +
    `<circle class="prof-cursor-dot" r="3.5" />`;
  const selRect = document.createElementNS(SVG_NS, "rect");
  selRect.setAttribute("class", "prof-sel hidden");
  svg.append(gStatic, selRect, gCursor);

  let W = 0, plotTop = padTop, plotBot = 0;
  let view = [0, total];
  let vMin = 0, vSpan = 1;

  const xOf = (k) => PAD_L + ((k - view[0]) / (view[1] - view[0])) * (W - PAD_L - PAD_R);
  const yOf = (a) => plotBot - ((a - vMin) / vSpan) * (plotBot - plotTop);
  const kmAtX = (x) =>
    clamp(view[0] + ((x - PAD_L) / (W - PAD_L - PAD_R)) * (view[1] - view[0]), view[0], view[1]);

  const classAtKm = (k) => bands?.find((b) => k >= b.startKm && k <= b.endKm)?.cls ?? null;

  function paint() {
    W = Math.round(plot.clientWidth);
    if (W < 40) return;
    const H = height;
    plotBot = H - axisH - bandH - bandGap;
    if (plotBot - plotTop < 20) return;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);

    // Fenêtre visible, avec le point de part et d'autre : sans eux la courbe se
    // détacherait des bords au lieu de sortir du cadre.
    let i0 = indexAtKm(km, view[0]);
    let i1 = Math.min(km.length - 1, indexAtKm(km, view[1]) + 1);
    if (i1 <= i0) i1 = Math.min(km.length - 1, i0 + 1);

    // L'échelle verticale suit la fenêtre : c'est tout l'intérêt du zoom — sinon on
    // agrandirait une portion en la laissant écrasée au fond du cadre.
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= i1; i++) { if (eles[i] < lo) lo = eles[i]; if (eles[i] > hi) hi = eles[i]; }
    const pad = Math.max(5, (hi - lo) * 0.08);
    vMin = lo - pad;
    vSpan = (hi - lo) + pad * 2 || 1;

    const pt = [];
    for (let i = i0; i <= i1; i++) pt.push(`${xOf(km[i]).toFixed(1)},${yOf(eles[i]).toFixed(1)}`);
    const x0 = xOf(km[i0]).toFixed(1), x1 = xOf(km[i1]).toFixed(1);

    const step = niceStep(view[1] - view[0]);
    const dec = Math.max(0, -Math.floor(Math.log10(step)));
    let ticks = "";
    for (let k = Math.ceil(view[0] / step) * step; k <= view[1] + 1e-9; k += step) {
      const x = xOf(k);
      if (x < PAD_L + 6 || x > W - PAD_R - 6) continue;
      ticks +=
        `<line class="prof-grid" x1="${x.toFixed(1)}" y1="${plotTop}" x2="${x.toFixed(1)}" y2="${plotBot}" vector-effect="non-scaling-stroke" />` +
        `<text class="prof-axis-label" x="${x.toFixed(1)}" y="${H - 3}" text-anchor="middle">${fmtKm(k, dec)}</text>`;
    }

    const bandY = plotBot + bandGap;
    const bandsSvg = (bands || [])
      .filter((b) => b.endKm > view[0] && b.startKm < view[1])
      .map((b) => {
        const bx = Math.max(xOf(Math.max(b.startKm, view[0])), PAD_L);
        const bw = Math.min(xOf(Math.min(b.endKm, view[1])), W - PAD_R) - bx;
        return bw > 0.2
          ? `<rect class="prof-band" data-cls="${b.cls}" x="${bx.toFixed(1)}" y="${bandY}" width="${bw.toFixed(1)}" height="${bandH}"><title>${SURFACE_LABEL[b.cls]}</title></rect>`
          : "";
      })
      .join("");

    gStatic.innerHTML =
      ticks +
      `<polygon class="prof-area" points="${x0},${plotBot} ${pt.join(" ")} ${x1},${plotBot}" />` +
      `<polyline class="prof-line" points="${pt.join(" ")}" vector-effect="non-scaling-stroke" />` +
      bandsSvg +
      `<text class="prof-alt" x="${PAD_L + 3}" y="${plotTop + 11}">${fr(Math.round(hi))} m</text>` +
      (compact ? "" : `<text class="prof-alt prof-alt-min" x="${PAD_L + 3}" y="${plotBot - 4}">${fr(Math.round(lo))} m</text>`);

    gCursor.querySelector("line").setAttribute("y1", plotTop);
    gCursor.querySelector("line").setAttribute("y2", plotBot);
    selRect.setAttribute("y", plotTop);
    selRect.setAttribute("height", plotBot - plotTop);
    svg.setAttribute("aria-label",
      `Profil d'altitude : ${fmtKm(total)} km, de ${fr(Math.round(Math.min(...eles)))} à ${fr(Math.round(Math.max(...eles)))} mètres.`);
  }

  // ---------- Curseur ----------
  function showCursor(k, { notify = true } = {}) {
    if (k == null || k < view[0] || k > view[1]) return hideCursor({ notify });
    const i = indexAtKm(km, k);
    const x = xOf(km[i]), y = yOf(eles[i]);
    gCursor.querySelector("line").setAttribute("x1", x.toFixed(1));
    gCursor.querySelector("line").setAttribute("x2", x.toFixed(1));
    gCursor.querySelector("circle").setAttribute("cx", x.toFixed(1));
    gCursor.querySelector("circle").setAttribute("cy", y.toFixed(1));
    gCursor.classList.remove("hidden");

    const cls = classAtKm(km[i]);
    tip.innerHTML =
      `<b>${fmtKm(km[i])} km</b> · ${fr(Math.round(eles[i]))} m` +
      (cls && cls !== "autre" ? ` · <span class="prof-tip-surf" data-cls="${cls}">${SURFACE_LABEL[cls]}</span>` : "") +
      // L'annotation arrive de façon asynchrone (fetch météo) : évaluée à chaque
      // survol, elle est simplement vide tant que les données ne sont pas là.
      (annotate ? annotate(km[i]) || "" : "");
    tip.classList.remove("hidden");
    // Recentré sur le curseur mais maintenu dans le cadre : une bulle qui déborde
    // provoquerait un débordement horizontal du panneau.
    const tw = tip.offsetWidth;
    tip.style.left = `${clamp(x - tw / 2, 2, Math.max(2, W - tw - 2))}px`;

    if (notify && onHover && pts) onHover({ lat: pts[i][0], lon: pts[i][1], km: km[i], alt: eles[i], index: i });
  }

  function hideCursor({ notify = true } = {}) {
    gCursor.classList.add("hidden");
    tip.classList.add("hidden");
    if (notify && onHover) onHover(null);
  }

  // ---------- Survol + glisser pour zoomer ----------
  let dragFrom = null, dragged = false;

  const localX = (e) => {
    const r = svg.getBoundingClientRect();
    return (e.clientX - r.left) * (W / (r.width || W));
  };

  svg.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    dragFrom = localX(e);
    dragged = false;
    svg.setPointerCapture?.(e.pointerId);
  });

  svg.addEventListener("pointermove", (e) => {
    const x = localX(e);
    if (dragFrom != null) {
      if (Math.abs(x - dragFrom) >= DRAG_MIN_PX) dragged = true;
      if (dragged) {
        const a = Math.min(dragFrom, x), b = Math.max(dragFrom, x);
        selRect.setAttribute("x", a.toFixed(1));
        selRect.setAttribute("width", (b - a).toFixed(1));
        selRect.classList.remove("hidden");
        hideCursor();
        return;
      }
    }
    showCursor(kmAtX(x));
  });

  const endDrag = (e) => {
    selRect.classList.add("hidden");
    if (dragFrom == null) return;
    const x = localX(e);
    const from = dragFrom;
    dragFrom = null;
    if (!dragged) return;
    dragged = false;
    const a = kmAtX(Math.min(from, x)), b = kmAtX(Math.max(from, x));
    // Un zoom plus serré que 50 m n'apporte plus rien : le relevé d'altitude
    // lui-même n'a pas cette résolution.
    if (b - a < 0.05) return;
    view = [a, b];
    unzoomBtn.classList.remove("hidden");
    root.classList.add("prof-zoomed");
    paint();
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", () => { dragFrom = null; dragged = false; selRect.classList.add("hidden"); });
  svg.addEventListener("pointerleave", () => { if (dragFrom == null) hideCursor(); });

  function resetZoom() {
    view = [0, total];
    unzoomBtn.classList.add("hidden");
    root.classList.remove("prof-zoomed");
    paint();
  }
  unzoomBtn.addEventListener("click", resetZoom);
  svg.addEventListener("dblclick", resetZoom);

  const ro = new ResizeObserver(() => paint());
  ro.observe(plot);
  paint();

  return {
    destroy() { ro.disconnect(); container.innerHTML = ""; },
    resetZoom,
    // Pilotage depuis la carte : `notify: false` coupe le retour vers onHover, sinon
    // carte → profil → carte boucle sur lui-même.
    setCursorKm(k) { k == null ? hideCursor({ notify: false }) : showCursor(k, { notify: false }); },
    // Position (km) du point du tracé le plus proche d'une latlng — pour que le survol
    // de la carte déplace le curseur du profil.
    kmNear(lat, lon) {
      if (!pts) return null;
      let best = 0, bestD = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = (pts[i][0] - lat) ** 2 + (pts[i][1] - lon) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      return km[best];
    },
  };
}
