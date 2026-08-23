// Sancho Rossi — champs météo sur la carte (S-V3-METEO)
//
// Le seul calque météo du projet était le radar RainViewer : de la pluie OBSERVÉE, à
// l'instant présent. Pour choisir où marcher samedi, ça ne répond à rien. Ici la carte
// porte une PRÉVISION, et on peut la faire défiler.
//
// Aucun fournisseur de tuiles météo n'est gratuit sans clé. La donnée vient donc d'une
// grille de points Open-Meteo (le même service que les fiches, weather.js) demandée en UN
// SEUL appel : mesuré sur les Écrins, 108 points × 72 h × 4 variables = 0,35 s et ~300 Ko.
// Open-Meteo renvoie l'ALTITUDE RÉELLE de chaque point (711 m à 3 506 m sur cette grille)
// et corrige la température en conséquence : le champ montre donc l'isotherme 0 °C au lieu
// d'un aplat de vallée étalé sur le massif. C'est tout l'intérêt en montagne.
//
// Rendu : la grille est interpolée dans un canevas, posé sur la carte en source `canvas`
// (créée par map.js, qui en a besoin dès la construction du style). MapLibre consomme une
// source `canvas` avec une couche `raster` — visibilité, opacité et assombrissement
// nocturne réutilisent donc tout le chemin raster existant.
import {
  map, mapZoom, layersConfig, applyLayer, whenMapReady, fieldCanvas, setFieldHandler,
} from "./map.js";
import { fetchRetry } from "./net.js";

const el = (id) => document.getElementById(id);

// ---------- Échelles de couleur ----------
// Paliers [valeur, r, g, b, a], interpolés linéairement. Le vert est absent partout : la
// charte le bannit, et il porte de toute façon mal la lecture sur un fond satellite.
const SCALES = {
  // Divergente froid → chaud, articulée sur le 0 °C : c'est la limite qu'on cherche.
  // Chroma volontairement FRANC et alpha haut : première version calée à ~0,35 d'opacité
  // effective, les tons 5–15 °C tombaient pile sur les beiges de roche ensoleillée du
  // satellite et le champ était invisible (constaté en capture). Un calque météo doit
  // dominer le fond — c'est lui qu'on regarde ; la réglette d'opacité permet de le lever.
  temperature_2m: {
    unit: "°C",
    stops: [
      [-20, 88, 40, 156, 0.72], [-10, 54, 78, 198, 0.72], [-5, 40, 128, 214, 0.72],
      [0, 56, 178, 220, 0.70], [5, 130, 208, 226, 0.66],
      // Palier NEUTRE entre le cyan et le jaune : sans lui, l'interpolation directe passe
      // par un vert franc — banni par la charte, et trompeur sur un fond de forêt.
      [8, 210, 224, 222, 0.64],
      [11, 240, 226, 152, 0.66],
      [15, 250, 190, 84, 0.68], [20, 246, 142, 56, 0.70], [25, 236, 88, 48, 0.74],
      [30, 202, 40, 44, 0.78], [38, 150, 22, 62, 0.82],
    ],
  },
  // 0 mm = totalement transparent : une carte sans pluie ne doit rien montrer du tout.
  precipitation: {
    unit: "mm/h",
    stops: [
      [0, 90, 160, 235, 0], [0.1, 90, 160, 235, 0.34], [0.5, 58, 128, 226, 0.55],
      [2, 40, 88, 214, 0.72], [5, 112, 70, 206, 0.80], [10, 176, 54, 176, 0.86],
      [20, 226, 44, 108, 0.90],
    ],
  },
  // Le vent faible ne s'affiche pas — seul ce qui fait renoncer à une crête est coloré.
  wind_gusts_10m: {
    unit: "km/h",
    stops: [
      [0, 250, 220, 120, 0], [20, 250, 220, 120, 0.26], [40, 250, 178, 70, 0.52],
      [60, 240, 120, 50, 0.68], [80, 224, 60, 50, 0.80], [100, 190, 40, 110, 0.86],
      [130, 138, 30, 150, 0.90],
    ],
  },
  // Un voile blanc, d'autant plus dense que le ciel est bouché : la métaphore est directe.
  cloud_cover: {
    unit: "%",
    stops: [
      [0, 236, 240, 246, 0], [25, 236, 240, 246, 0.14], [50, 238, 242, 248, 0.32],
      [75, 242, 246, 250, 0.50], [100, 250, 252, 255, 0.66],
    ],
  },
};

// Étiquette lisible d'une valeur — utilisée par la légende et l'infobulle.
const FORMATS = {
  temperature_2m: (v) => `${Math.round(v)} °C`,
  precipitation: (v) => (v < 1 ? `${v.toFixed(1)} mm` : `${Math.round(v)} mm`),
  wind_gusts_10m: (v) => `${Math.round(v)} km/h`,
  cloud_cover: (v) => `${Math.round(v)} %`,
};

const FIELD_OF = { temp: "temperature_2m", pluie: "precipitation", rafales: "wind_gusts_10m", nuages: "cloud_cover" };
const LABELS = { temp: "Température", pluie: "Pluie prévue", rafales: "Rafales de vent", nuages: "Nuages" };
const VARIABLES = Object.values(FIELD_OF);

// ---------- Grille ----------
const GRID_NX = 12;
const GRID_NY = 9;            // 108 points : le meilleur compromis mesuré temps/finesse
const FORECAST_DAYS = 3;      // 72 h depuis minuit UTC → toujours ≥ 48 h devant nous
const HORIZON_H = 48;
const MARGIN = 0.22;          // marge autour de la vue : un petit déplacement ne refetch pas
const MIN_ZOOM = 6;           // en deçà, 12 points couvriraient 2 000 km : sans objet
const DEBOUNCE_MS = 500;

let grid = null;              // { west, east, south, north, times[], values{}, }
let hourIndex = 0;
let active = null;            // clé de calque active (temp | pluie | rafales | nuages)
let fetching = false;
let moveTimer = null;
let failed = false;

// ---------- Mercator ----------
// Le canevas est étiré LINÉAIREMENT en Mercator par MapLibre, alors que la grille est
// régulière en latitude. Sans cette conversion, le champ glisse vers le nord de plusieurs
// kilomètres en haut de l'image — invisible sur un aplat, faux sur une limite pluie/neige.
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const invMercY = (y) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;

// ---------- Chargement de la grille ----------
function neededBounds() {
  const b = map.getBounds();
  const dLat = (b.getNorth() - b.getSouth()) * MARGIN;
  const dLon = (b.getEast() - b.getWest()) * MARGIN;
  return {
    north: Math.min(84, b.getNorth() + dLat),
    south: Math.max(-84, b.getSouth() - dLat),
    west: b.getWest() - dLon,
    east: b.getEast() + dLon,
  };
}

// Faut-il recharger ? Deux raisons, et la seconde s'est fait oublier une première fois :
//   1. la vue est sortie de la grille (comparée à la vue NUE — la marge est justement le
//      matelas qui évite un appel réseau à chaque petit glissement) ;
//   2. la grille est devenue BEAUCOUP trop large. Après un zoom d'un massif depuis
//      l'Europe entière, elle « couvre » toujours la vue mais avec 180 km entre deux
//      points : le champ dégénère en aplat lisse et ne dit plus rien. Mesuré en capture,
//      c'était le défaut le plus visible du premier jet.
const OVERSIZE = 3;

function needsGrid(g) {
  if (!g) return true;
  const b = map.getBounds();
  const outside = !(g.north >= b.getNorth() && g.south <= b.getSouth()
                 && g.west <= b.getWest() && g.east >= b.getEast());
  return outside || (g.east - g.west) > (b.getEast() - b.getWest()) * OVERSIZE;
}

async function loadGrid() {
  const box = neededBounds();
  // Points énumérés EN LIGNES DU NORD VERS LE SUD : c'est l'ordre que le rendu suppose
  // (ligne 0 = nord), et Open-Meteo renvoie les résultats dans l'ordre demandé.
  const lats = [];
  const lons = [];
  for (let j = 0; j < GRID_NY; j++) {
    const lat = +(box.north - ((box.north - box.south) * j) / (GRID_NY - 1)).toFixed(4);
    for (let i = 0; i < GRID_NX; i++) {
      lats.push(lat);
      lons.push(+(box.west + ((box.east - box.west) * i) / (GRID_NX - 1)).toFixed(4));
    }
  }
  // `timezone=GMT` est délibéré : en `auto`, chaque point recevrait son propre fuseau et
  // les tableaux horaires ne seraient plus alignés d'un point à l'autre. On affiche
  // ensuite l'heure LOCALE de l'appareil, ce qui est la bonne pour qui prépare sa sortie.
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(",")}&longitude=${lons.join(",")}` +
    `&hourly=${VARIABLES.join(",")}&forecast_days=${FORECAST_DAYS}&timezone=GMT`;

  const res = await fetchRetry(url, { timeout: 20000, retries: 1 });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) throw new Error("grille vide");

  const allTimes = list[0].hourly.time.map((t) => new Date(`${t}Z`).getTime());
  // On ne garde que de l'heure courante à +48 h : le reste alourdirait la réglette sans
  // rien apprendre (au-delà de 3 jours la prévision de montagne ne vaut plus grand-chose).
  const now = Date.now() - 30 * 60 * 1000;
  let from = allTimes.findIndex((t) => t >= now);
  if (from < 0) from = 0;
  const to = Math.min(allTimes.length, from + HORIZON_H + 1);
  const times = allTimes.slice(from, to);
  const nH = times.length;
  const n = list.length;

  const values = {};
  for (const v of VARIABLES) {
    const arr = new Float32Array(nH * n);
    for (let p = 0; p < n; p++) {
      const src = list[p].hourly[v];
      for (let h = 0; h < nH; h++) {
        const x = src?.[from + h];
        arr[h * n + p] = x == null ? NaN : x;
      }
    }
    values[v] = arr;
  }
  return { ...box, nx: GRID_NX, ny: GRID_NY, times, values };
}

function ensureGrid() {
  if (fetching || !needsGrid(grid)) return;
  if (mapZoom() < MIN_ZOOM) { setStatus("Zoomez sur une région pour charger la météo."); return; }
  fetching = true;
  setStatus("Chargement de la prévision…");
  loadGrid()
    .then((g) => {
      grid = g;
      failed = false;
      hourIndex = Math.min(hourIndex, g.times.length - 1);
      buildTimeControls();
      draw();
      setStatus("");
    })
    .catch((err) => {
      console.warn("Grille météo indisponible :", err);
      if (!failed) setStatus("Prévision indisponible — réseau ?");
      failed = true;
    })
    .finally(() => { fetching = false; });
}

// ---------- Rendu du champ ----------
// Interpolation bilinéaire adoucie : sur une grille de 12 × 9, la bilinéaire nue laisse des
// facettes en losange bien visibles sur un aplat. Le lissage de Hermite sur la fraction
// (3t² − 2t³) les efface sans coûter une passe de plus.
const smooth = (t) => t * t * (3 - 2 * t);

function colorAt(scale, v) {
  const s = scale.stops;
  if (!Number.isFinite(v)) return null;
  if (v <= s[0][0]) return s[0];
  if (v >= s[s.length - 1][0]) return s[s.length - 1];
  for (let k = 1; k < s.length; k++) {
    if (v <= s[k][0]) {
      const a = s[k - 1];
      const b = s[k];
      const t = (v - a[0]) / (b[0] - a[0]);
      return [v, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
              a[3] + (b[3] - a[3]) * t, a[4] + (b[4] - a[4]) * t];
    }
  }
  return s[s.length - 1];
}

// Largeur du canevas : assez pour que le GPU n'ait qu'à lisser, jamais assez pour peser.
const CANVAS_W = 256;

function draw() {
  if (!active || !grid) return;
  const cv = fieldCanvas(active);
  const src = grid.values[FIELD_OF[active]];
  if (!cv || !src) return;

  const yTop = mercY(grid.north);
  const yBot = mercY(grid.south);
  const ratio = (yTop - yBot) / ((grid.east - grid.west) * (Math.PI / 180));
  const W = CANVAS_W;
  const H = Math.max(8, Math.min(512, Math.round(W * ratio)));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }

  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(W, H);
  const scale = SCALES[FIELD_OF[active]];
  const { nx, ny } = grid;
  const base = hourIndex * nx * ny;

  for (let py = 0; py < H; py++) {
    const lat = invMercY(yTop - ((yTop - yBot) * (py + 0.5)) / H);
    // Ligne 0 de la grille = NORD (cf. l'ordre de construction des points).
    const gy = ((grid.north - lat) / (grid.north - grid.south)) * (ny - 1);
    const j0 = Math.max(0, Math.min(ny - 2, Math.floor(gy)));
    const ty = smooth(Math.max(0, Math.min(1, gy - j0)));
    for (let px = 0; px < W; px++) {
      const gx = ((px + 0.5) / W) * (nx - 1);
      const i0 = Math.max(0, Math.min(nx - 2, Math.floor(gx)));
      const tx = smooth(Math.max(0, Math.min(1, gx - i0)));
      const v00 = src[base + j0 * nx + i0];
      const v10 = src[base + j0 * nx + i0 + 1];
      const v01 = src[base + (j0 + 1) * nx + i0];
      const v11 = src[base + (j0 + 1) * nx + i0 + 1];
      const v = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
      const c = colorAt(scale, v);
      const o = (py * W + px) * 4;
      if (!c) { img.data[o + 3] = 0; continue; }
      img.data[o] = c[1];
      img.data[o + 1] = c[2];
      img.data[o + 2] = c[3];
      img.data[o + 3] = c[4] * 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  whenMapReady(() => {
    const s = map.getSource(`src-${active}`);
    if (!s) return;
    s.setCoordinates([
      [grid.west, grid.north], [grid.east, grid.north],
      [grid.east, grid.south], [grid.west, grid.south],
    ]);
    // Une source `canvas` ne se relit qu'en lecture continue : un aller-retour
    // play → pause force un unique ré-envoi de la texture, sans laisser MapLibre
    // la ré-uploader à chaque image (ce que ferait `animate: true`).
    s.play();
    setTimeout(() => s.pause(), 60);
  });
  paintWhen();
}

// ---------- Réglette temporelle ----------
const DAY_MS = 86400000;
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / DAY_MS);
  if (diff === 0) return "Auj.";
  if (diff === 1) return "Dem.";
  return capitalize(d.toLocaleDateString("fr-FR", { weekday: "short" }).replace(".", ""));
}

// Puces de jour + réglette d'heure : le grossier et le fin, comme demandé. Une puce saute à
// midi du jour visé (l'heure qu'on regarde en premier quand on choisit une date), la
// réglette affine ensuite heure par heure.
function buildTimeControls() {
  const host = el("meteo-days");
  const slider = el("meteo-hour");
  if (!host || !slider || !grid) return;
  const t = grid.times;
  slider.min = 0;
  slider.max = String(t.length - 1);
  slider.value = String(hourIndex);
  // Le navigateur BORNE la valeur d'un `input[range]` à [min, max] : si la grille précédente
  // était plus longue, l'état du module et celui du widget divergeraient en silence, et la
  // réglette afficherait une heure que le champ ne dessine pas. On relit ce qu'il a retenu.
  hourIndex = Number(slider.value);

  const seen = new Map();
  t.forEach((ts, i) => {
    const k = dayKey(ts);
    if (!seen.has(k)) seen.set(k, { label: dayLabel(ts), first: i, noon: i });
    const d = new Date(ts);
    if (d.getHours() <= 12) seen.get(k).noon = i;
  });
  host.innerHTML = [...seen.values()]
    .map((d) => `<button type="button" class="meteo-day" data-index="${d.noon}">${d.label}</button>`)
    .join("");
  host.querySelectorAll(".meteo-day").forEach((b) =>
    b.addEventListener("click", () => setHour(Number(b.dataset.index)))
  );
  paintLegend();
  paintWhen();
}

function setHour(i) {
  if (!grid) return;
  hourIndex = Math.max(0, Math.min(grid.times.length - 1, i));
  el("meteo-hour").value = String(hourIndex);
  draw();
}

function paintWhen() {
  const when = el("meteo-when");
  if (!when || !grid) return;
  const ts = grid.times[hourIndex];
  const d = new Date(ts);
  const day = dayLabel(ts);
  const full = day === "Auj." ? "Aujourd'hui" : day === "Dem." ? "Demain"
    : capitalize(d.toLocaleDateString("fr-FR", { weekday: "long" }));
  when.textContent = `${full} ${String(d.getHours()).padStart(2, "0")} h`;
  document.querySelectorAll(".meteo-day").forEach((b) => {
    const bi = Number(b.dataset.index);
    b.classList.toggle("active", dayKey(grid.times[bi]) === dayKey(ts));
  });
}

// Barre dégradée + trois repères chiffrés : sans elle, un aplat de couleur ne dit rien.
function paintLegend() {
  const host = el("meteo-legend");
  if (!host || !active) return;
  const key = FIELD_OF[active];
  const scale = SCALES[key];
  const s = scale.stops;
  const lo = s[0][0];
  const hi = s[s.length - 1][0];
  const stops = s
    .map((st) => `rgba(${st[1]},${st[2]},${st[3]},${Math.max(st[4], 0.12)}) ${(((st[0] - lo) / (hi - lo)) * 100).toFixed(1)}%`)
    .join(", ");
  const fmt = FORMATS[key];
  host.innerHTML =
    `<span class="meteo-scale" style="background:linear-gradient(90deg, ${stops})"></span>` +
    `<span class="meteo-ticks"><i>${fmt(lo)}</i><i>${fmt((lo + hi) / 2)}</i><i>${fmt(hi)}</i></span>`;
}

function setStatus(text) {
  const node = el("meteo-status");
  if (!node) return;
  node.textContent = text;
  node.classList.toggle("hidden", !text);
}

// ---------- Ouverture / fermeture ----------
function onFieldToggle(name, on) {
  if (on) {
    active = name;
    el("meteo-field").textContent = LABELS[name];
    el("meteo-bar").classList.remove("hidden");
    paintLegend();
    if (grid && !needsGrid(grid)) { buildTimeControls(); draw(); }
    ensureGrid();
  } else if (active === name) {
    active = null;
    el("meteo-bar").classList.add("hidden");
  }
}

export function initMeteoMap() {
  setFieldHandler(onFieldToggle);

  el("meteo-hour")?.addEventListener("input", (e) => setHour(Number(e.target.value)));
  el("meteo-close")?.addEventListener("click", () => {
    if (!active) return;
    layersConfig[active].on = false;
    applyLayer(active); // referme la barre par le même chemin que le sélecteur de calques
  });

  // Nouvelle zone → nouvelle grille, mais seulement quand la carte s'est arrêtée.
  map.on("moveend", () => {
    if (!active) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(ensureGrid, DEBOUNCE_MS);
  });

  // Un champ peut déjà être allumé au boot (préférence conservée dans `sr-layers`) :
  // applyLayer a tourné avant que ce module ne s'enregistre, on se resynchronise.
  const on = Object.keys(FIELD_OF).find((n) => layersConfig[n]?.on);
  if (on) onFieldToggle(on, true);
}
