// Sancho Rossi — socle vectoriel (S-V3-VECTOR).
//
// Ce que ce module débloque, et pourquoi il existe : sous MapLibre, un fond raster est une
// IMAGE — les noms de villes, de lacs et de sommets y sont peints, inséparables du reste.
// C'est pourquoi la lisibilité était jusqu'ici une propriété du fond CHOISI : le satellite
// est muet, le topo est chargé, et on ne pouvait pas avoir l'un avec les noms de l'autre.
// Dans un style VECTORIEL les étiquettes sont des couches à part : la lisibilité cesse
// d'être un fond et devient un RÉGLAGE, superposable à n'importe quelle imagerie.
//
// Trois surcouches + un fond, tous sans clé :
//   • « Noms »   — étiquettes OpenFreeMap (schéma OpenMapTiles), en `name:fr`.
//   • « Courbes de niveau » — CALCULÉES dans le navigateur (maplibre-contour) depuis les
//     mêmes tuiles Terrarium que le relief 3D et le mode soleil. Aucun fournisseur de
//     courbes n'est nécessaire : l'équidistance devient un réglage, pas une image figée.
//   • « Relief détaillé » — ombrage MapLibre calculé sur ce même MNT (le calque « Relief »
//     existant est une image Esri plafonnée à z16 ; celui-ci suit le zoom et la rotation).
//   • Fond « Sancho » — un style rando ÉCRIT ICI aux tokens du projet (nuances de noir,
//     sentiers en accent rouge). S-V2-CARTE-A avait essayé les styles vector tout faits et
//     les avait écartés à raison — « la cartographie est routière ». La v3 ne l'attend plus
//     d'un tiers : elle le compose.
//
// Chargé en `import()` différé par map.js (lignée S11) : rien de tout ceci n'entre dans le
// poids du premier écran tant que l'utilisateur n'allume pas un de ces calques.

import { map, DEM_SOURCE, DEM_TILES, ensureDem, insertBeforeTracks } from "./map.js";

const OFM_TILEJSON = "https://tiles.openfreemap.org/planet";
const OFM_ATTR =
  '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://openmaptiles.org">OpenMapTiles</a> &copy; OSM';
const OFM_SOURCE = "src-ofm";

// Nom en français quand la donnée le porte, nom local sinon — jamais de case vide.
const NAME_FR = ["coalesce", ["get", "name:fr"], ["get", "name"], ["get", "name:latin"], ""];

// Halo sombre : c'est lui qui fait tenir une étiquette blanche sur une ortho enneigée
// comme sur un topo clair — le contraste vient de la VALEUR, pas de la teinte.
const HALO = "rgba(9, 9, 11, 0.85)";

// ---------- Source vectorielle partagée ----------
// « Noms » et le fond « Sancho » lisent la MÊME source : l'allumer deux fois ne double ni
// les requêtes ni la mémoire.
function ensureOfmSource() {
  if (!map.getSource(OFM_SOURCE)) {
    map.addSource(OFM_SOURCE, { type: "vector", url: OFM_TILEJSON, attribution: OFM_ATTR });
  }
}

// ---------- 1. Surcouche « Noms » ----------
// Une échelle éditoriale, pas un déversement : les tailles montent avec l'importance
// (capitale > ville > village > lieu-dit) et les couches n'apparaissent qu'au zoom où
// elles ont un sens. Le halo sombre est ce qui les fait tenir sur une ortho.
function nameLayers() {
  const label = (over) => ({
    type: "symbol",
    source: OFM_SOURCE,
    layout: {
      "text-field": NAME_FR,
      "text-font": ["Noto Sans Regular"],
      "text-max-width": 8,
      ...over.layout,
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": HALO,
      "text-halo-width": 1.6,
      "text-halo-blur": 0.6,
      ...over.paint,
    },
    ...(over.filter ? { filter: over.filter } : {}),
    ...(over.minzoom != null ? { minzoom: over.minzoom } : {}),
    ...(over.maxzoom != null ? { maxzoom: over.maxzoom } : {}),
    "source-layer": over.src,
  });

  return [
    // Régions et pays : en capitales espacées, la même grammaire que les micro-étiquettes
    // de l'interface — et ils s'effacent dès qu'on entre dans le détail.
    { id: "lyr-noms-region", ...label({
      src: "place",
      filter: ["match", ["get", "class"], ["country", "state"], true, false],
      maxzoom: 9,
      layout: {
        "text-font": ["Noto Sans Bold"],
        "text-letter-spacing": 0.18,
        "text-transform": "uppercase",
        "text-size": ["interpolate", ["linear"], ["zoom"], 3, 10, 8, 14],
      },
      paint: { "text-color": "#c9c9d1" },
    }) },
    { id: "lyr-noms-ville", ...label({
      src: "place",
      filter: ["match", ["get", "class"], ["city", "town"], true, false],
      layout: {
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["exponential", 1.2], ["zoom"], 4, 11, 8, 14, 12, 18],
      },
    }) },
    { id: "lyr-noms-lieu", ...label({
      src: "place",
      filter: ["match", ["get", "class"], ["village", "hamlet", "suburb", "neighbourhood"], true, false],
      minzoom: 10,
      layout: { "text-size": ["interpolate", ["linear"], ["zoom"], 10, 11, 15, 14] },
      paint: { "text-color": "#e2e2e6" },
    }) },
    // Lacs et rivières : italique, la convention cartographique de l'hydrographie.
    { id: "lyr-noms-eau", ...label({
      src: "water_name",
      layout: {
        "text-font": ["Noto Sans Italic"],
        "text-letter-spacing": 0.12,
        "text-size": ["interpolate", ["linear"], ["zoom"], 6, 10, 14, 14],
      },
      paint: { "text-color": "#9fc4e8" },
    }) },
    { id: "lyr-noms-riviere", ...label({
      src: "waterway",
      minzoom: 12,
      layout: {
        "text-font": ["Noto Sans Italic"],
        "symbol-placement": "line",
        "text-size": 11,
      },
      paint: { "text-color": "#9fc4e8" },
    }) },
    // Parcs et espaces protégés — la donnée que S-PROTEGE devra recouper.
    { id: "lyr-noms-parc", ...label({
      src: "park",
      minzoom: 9,
      layout: {
        "text-font": ["Noto Sans Italic"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 14, 13],
      },
      paint: { "text-color": "#a9c9a0" },
    }) },
    // Sommets et cols : LE point d'intérêt de cette app. L'altitude fait partie du nom —
    // « Aiguille du Midi 3842 m » se lit d'un coup d'œil, sans ouvrir quoi que ce soit.
    {
      id: "lyr-noms-sommet-pt",
      type: "circle",
      source: OFM_SOURCE,
      "source-layer": "mountain_peak",
      minzoom: 9,
      paint: {
        "circle-radius": 2.6,
        "circle-color": "#ff2d20",
        "circle-stroke-width": 1.2,
        "circle-stroke-color": HALO,
      },
    },
    { id: "lyr-noms-sommet", ...label({
      src: "mountain_peak",
      minzoom: 9,
      layout: {
        "text-font": ["Noto Sans Bold"],
        "text-anchor": "bottom",
        "text-offset": [0, -0.5],
        "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 14, 13],
        "text-field": [
          "case",
          ["has", "ele"],
          ["concat", NAME_FR, "\n", ["to-string", ["round", ["get", "ele"]]], " m"],
          NAME_FR,
        ],
      },
      paint: { "text-color": "#ffd9d5" },
    }) },
    // Monuments et curiosités : au zoom de préparation seulement, sinon c'est un mur.
    { id: "lyr-noms-poi", ...label({
      src: "poi",
      minzoom: 14,
      filter: ["match", ["get", "class"],
        ["attraction", "monument", "castle", "ruins", "church", "museum", "viewpoint", "information"],
        true, false],
      layout: { "text-size": 11, "text-max-width": 7 },
      paint: { "text-color": "#d8d8dc" },
    }) },
  ];
}

// ---------- 2. Fond « Sancho » ----------
// Un style rando écrit à la main sur le schéma OpenMapTiles, aux tokens du projet. Ce qui
// le distingue d'un fond routier : les SENTIERS sont la strate la plus lisible (accent
// rouge, pointillés), les routes reculent au rang de repère, et tout le reste est en
// nuances de noir pour que le tracé actif garde le premier plan.
function sanchoLayers() {
  const l = (id, over) => ({ id: `lyr-sancho-${id}`, source: OFM_SOURCE, ...over });
  return [
    { id: "lyr-sancho-bg", type: "background", paint: { "background-color": "#101012" } },
    l("landcover", {
      type: "fill", "source-layer": "landcover",
      paint: {
        "fill-color": ["match", ["get", "class"],
          "wood", "#16201a", "grass", "#182018", "ice", "#1e232a", "#141416"],
        "fill-opacity": 0.9,
      },
    }),
    l("park", {
      type: "fill", "source-layer": "park",
      paint: { "fill-color": "#152016", "fill-opacity": 0.55 },
    }),
    l("water", {
      type: "fill", "source-layer": "water",
      paint: { "fill-color": "#16283d" },
    }),
    l("waterway", {
      type: "line", "source-layer": "waterway",
      paint: {
        "line-color": "#1d3a56",
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.6, 16, 2.4],
      },
    }),
    // Routes : présentes pour se repérer et rejoindre un départ, jamais dominantes.
    l("road-minor", {
      type: "line", "source-layer": "transportation",
      filter: ["match", ["get", "class"], ["minor", "service", "track"], true, false],
      minzoom: 12,
      paint: { "line-color": "#2c2c31", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.6, 18, 4] },
    }),
    l("road-major", {
      type: "line", "source-layer": "transportation",
      filter: ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary"], true, false],
      paint: {
        "line-color": "#3a3a42",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 6, 0.6, 12, 2.4, 18, 9],
      },
    }),
    // Sentiers : la strate qui justifie ce fond. Liseré sombre + cœur rouge en pointillés,
    // exactement la grammaire du tracé actif (S-V2-TRACE), un cran plus discrète.
    l("path-casing", {
      type: "line", "source-layer": "transportation",
      filter: ["match", ["get", "class"], ["path", "track"], true, false],
      minzoom: 11,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "rgba(9, 9, 11, 0.7)",
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 2, 18, 6],
      },
    }),
    l("path", {
      type: "line", "source-layer": "transportation",
      filter: ["match", ["get", "class"], ["path", "track"], true, false],
      minzoom: 11,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#e0574b",
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.9, 18, 2.6],
        "line-dasharray": [2.5, 1.6],
      },
    }),
    l("building", {
      type: "fill", "source-layer": "building", minzoom: 14,
      paint: { "fill-color": "#26262b", "fill-opacity": 0.8 },
    }),
    l("boundary", {
      type: "line", "source-layer": "boundary",
      filter: ["<=", ["get", "admin_level"], 4],
      paint: {
        "line-color": "#4a4a55",
        "line-width": 1,
        "line-dasharray": [4, 3],
      },
    }),
  ];
}

// ---------- 3. Relief détaillé (ombrage calculé) ----------
// Le calque « Relief » historique est une IMAGE Esri : plafonnée à z16, éclairage figé,
// floue au-delà. Celui-ci est calculé par le GPU depuis le MNT Terrarium déjà en place —
// net à tout zoom, et il tourne avec la carte.
function shadeLayer() {
  return [{
    id: "lyr-ombrage",
    type: "hillshade",
    source: DEM_SOURCE,
    paint: {
      // Volontairement sourd : un `highlight` crème (essayé d'abord) repeignait toute la
      // carte en gris clair et sortait de la charte « nuances de noir ». Ici le relief se
      // lit par l'ombre, pas par la lumière.
      "hillshade-shadow-color": "#03050a",
      "hillshade-highlight-color": "#aeb3bb",
      "hillshade-accent-color": "#171b21",
      "hillshade-exaggeration": 0.5,
    },
  }];
}

// ---------- 4. Courbes de niveau ----------
// Calculées dans le navigateur à partir des tuiles Terrarium. `maplibre-contour` enregistre
// un protocole MapLibre et rend des tuiles VECTORIELLES d'isolignes ; le travail se fait
// dans un Web Worker que la lib construit elle-même en blob (donc utilisable depuis un CDN,
// où un `new Worker(url)` cross-origin serait refusé).
const CONTOUR_SOURCE = "src-contour";
let demSourceObj = null;

// Équidistances par palier de zoom. La règle est cartographique, pas technique : on veut
// une dizaine de courbes lisibles à l'écran, donc l'équidistance se resserre en zoomant.
// La courbe MAÎTRESSE (la 5ᵉ) est plus épaisse et porte seule l'altitude — sans quoi le
// relief devient un moiré de chiffres.
const THRESHOLDS = {
  9: [500, 2500],
  11: [200, 1000],
  12: [100, 500],
  14: [50, 250],
  15: [20, 100],
};

async function ensureContourSource() {
  if (map.getSource(CONTOUR_SOURCE)) return;
  const mlcontour = (await import("https://unpkg.com/maplibre-contour@0.1.0/dist/index.mjs")).default;
  if (!demSourceObj) {
    demSourceObj = new mlcontour.DemSource({
      url: DEM_TILES,
      encoding: "terrarium",
      maxzoom: 15,
      worker: true,
    });
    demSourceObj.setupMaplibre(maplibregl);
  }
  map.addSource(CONTOUR_SOURCE, {
    type: "vector",
    tiles: [demSourceObj.contourProtocolUrl({
      thresholds: THRESHOLDS,
      elevationKey: "ele",
      levelKey: "level",
      contourLayer: "contours",
      overzoom: 1,
    })],
    maxzoom: 15,
  });
}

function contourLayers() {
  return [
    {
      id: "lyr-courbes-line",
      type: "line",
      source: CONTOUR_SOURCE,
      "source-layer": "contours",
      layout: { "line-join": "round" },
      paint: {
        // Tan chaud plutôt qu'un gris : il se détache de la roche comme de la neige de
        // l'ortho, où un trait clair disparaissait.
        "line-color": "rgba(206, 162, 110, 0.78)",
        // `level` vaut 1 pour une courbe maîtresse, 0 pour une intercalaire.
        "line-width": ["match", ["get", "level"], 1, 1.4, 0.7],
      },
    },
    {
      id: "lyr-courbes-label",
      type: "symbol",
      source: CONTOUR_SOURCE,
      "source-layer": "contours",
      filter: [">", ["get", "level"], 0],
      layout: {
        "symbol-placement": "line",
        "text-field": ["concat", ["to-string", ["get", "ele"]], " m"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 10.5,
        "text-max-angle": 25,
        "symbol-spacing": 400,
      },
      paint: {
        "text-color": "#e8cfae",
        "text-halo-color": HALO,
        "text-halo-width": 1.4,
      },
    },
  ];
}

// ---------- Registre ----------
// Chaque calque vectoriel décrit ses couches GL et sa préparation éventuelle (source,
// bibliothèque). `applyLayer` (map.js) ne connaît que ça ; la propriété par laquelle
// l'opacité agit se déduit du TYPE de la couche, plus bas.
const DEFS = {
  sancho: { build: sanchoLayers, prepare: ensureOfmSource },
  // La source DEM n'était posée que par le relief 3D : l'ombrage calculé doit pouvoir
  // l'exiger tout seul (sans ça, `layers.lyr-ombrage: source "src-dem" not found`).
  ombrage: { build: shadeLayer, prepare: () => ensureDem() },
  courbes: { build: contourLayers, prepare: ensureContourSource },
  noms: { build: nameLayers, prepare: ensureOfmSource },
};

const installed = new Set();
const layerIds = new Map(); // nom → ids des couches GL posées

// Opacité : chaque type de couche a SA propriété. Un `raster-opacity` sur une couche
// `symbol` est rejeté par le validateur MapLibre — d'où cette table, plutôt qu'un
// `setPaintProperty` unique qui marcherait par accident sur les rasters seulement.
const OPACITY_PROPS = {
  fill: ["fill-opacity"],
  line: ["line-opacity"],
  symbol: ["text-opacity", "icon-opacity"],
  circle: ["circle-opacity", "circle-stroke-opacity"],
  background: ["background-opacity"],
};

// Opacités de repos, pour que le curseur MULTIPLIE le rendu voulu au lieu de l'écraser :
// un fond de bois à 0,9 et un halo à 1 doivent garder leur rapport quand on descend à 50 %.
const baseOpacity = new Map();

export async function ensureVector(name) {
  if (installed.has(name)) return;
  const def = DEFS[name];
  if (!def) return;
  if (def.prepare) await def.prepare();
  if (installed.has(name)) return; // une seconde bascule pendant l'await
  const ids = [];
  // L'ancre est calculée UNE FOIS pour tout le groupe : la recalculer à chaque couche
  // ferait de la précédente la nouvelle ancre et EMPILERAIT LE GROUPE À L'ENVERS — le
  // fond du style « Sancho » se retrouvait par-dessus ses propres sentiers.
  const before = insertBeforeTracks(name);
  for (const spec of def.build()) {
    if (map.getLayer(spec.id)) { ids.push(spec.id); continue; }
    // Posé SOUS les tracés : le rouge du parcours doit rester au-dessus de la carte, y
    // compris de ses étiquettes (S-V2-TRACE — « visible au premier regard »).
    map.addLayer({ ...spec, layout: { ...(spec.layout || {}), visibility: "none" } }, before);
    for (const [prop, val] of Object.entries(spec.paint || {})) {
      if (prop.endsWith("-opacity") && typeof val === "number") baseOpacity.set(`${spec.id}.${prop}`, val);
    }
    ids.push(spec.id);
  }
  layerIds.set(name, ids);
  installed.add(name);
}

export function paintVector(name, cfg, dim = 1) {
  const ids = layerIds.get(name);
  if (!ids) return;
  const factor = (cfg.op / 100) * dim;
  for (const id of ids) {
    if (!map.getLayer(id)) continue;
    map.setLayoutProperty(id, "visibility", cfg.on ? "visible" : "none");
    if (!cfg.on) continue;
    const type = map.getLayer(id).type;
    if (type === "hillshade") {
      // Une couche `hillshade` n'a pas d'opacité : le curseur pilote l'INTENSITÉ du
      // relief, ce qui est de toute façon le réglage qu'on cherche sur ce calque.
      map.setPaintProperty(id, "hillshade-exaggeration", Math.max(0.05, factor * 0.85));
      continue;
    }
    for (const prop of OPACITY_PROPS[type] || []) {
      const rest = baseOpacity.get(`${id}.${prop}`) ?? 1;
      map.setPaintProperty(id, prop, rest * factor);
    }
  }
}

export function isVectorInstalled(name) {
  return installed.has(name);
}
