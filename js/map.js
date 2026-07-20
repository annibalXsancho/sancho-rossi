// Sancho Rossi — carte MapLibre GL : fonds, calques, POI Overpass, marqueurs, prévisualisation
// Migré de Leaflet à MapLibre GL JS au sprint S-V2-CARTE-A : rotation/boussole, échelle et
// rendu GPU sont le socle d'Explorer (vague 2), de la vue de navigation et du terrain 3D.
// Les mini-cartes de fiche (detail.js) restent en Leaflet jusqu'au sprint B.
import { state, trackOf } from "./state.js";
import { overpassFetch } from "./api.js";
import { fetchRetry } from "./net.js";
import { toast } from "./toast.js";
import { photoOf, photoStyle } from "./photos.js";
import { planner, plannerMapClick } from "./planner.js";
import { loops, setStart as setLoopStart } from "./loops.js";
import { renderList } from "./trails.js";
import { renderDetail } from "./detail.js";
import { startNavigation } from "./nav.js";
import { savePos } from "./security.js";

// ---------- Description des calques (source unique) ----------
// Une entrée décrit tout ce qu'un calque a besoin d'exposer : URL modèle, sous-domaines,
// zoom NATIF du fournisseur, attribution, opacité par défaut. C'est l'« architecture de
// sources extensible » du ROADMAP : ajouter swisstopo ou l'IGN = ajouter une ligne ici.
//
// `url` garde le placeholder `{s}` : js/offline.js le substitue lui-même pour construire
// les URL de pack (et sw.js normalise la clé en retirant le sous-domaine). Ne pas y toucher
// sans mettre les trois à jour ensemble.
//
// `maxZoom` est le dernier niveau où de VRAIES tuiles existent : il devient le `maxzoom` de
// la source MapLibre (qui sur-échantillonne au-delà, comme le faisait `maxNativeZoom`) et
// le plafond de téléchargement des packs.
//
// CORS : audité calque par calque le 20/07/2026 (WebGL refuse une tuile sans en-tête
// `Access-Control-Allow-Origin`). Les 9 calques répondent `*` — aucun n'est écarté.
export const TILE_TEMPLATES = {
  plan: {
    url: "https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png",
    // openstreetmap.fr ne répond PAS sans préfixe de sous-domaine (vérifié : 000 sans, 200
    // avec) — MapLibre n'ayant pas de placeholder {s}, on énumère les hôtes dans `tiles`.
    subdomains: ["a", "b", "c"],
    maxZoom: 19,
    op: 100,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
  topo: {
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c"],
    maxZoom: 17,
    op: 100,
    attribution: '&copy; OSM, <a href="https://opentopomap.org">OpenTopoMap</a>',
  },
  satellite: {
    // L'ordre {y}/{x} d'ArcGIS est déjà encodé dans l'URL.
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 19,
    op: 100,
    attribution: "Tiles &copy; Esri — Maxar, Earthstar Geographics",
  },
  sombre: {
    // Pas de `{r}` (retina) : sous Leaflet la carte demandait `{y}{r}.png` → `@2x.png` sur
    // écran retina alors que le pack téléchargeait `.png`, si bien que la tuile embarquée
    // n'était jamais servie sur ces appareils. MapLibre n'a pas ce placeholder : bug clos.
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c"],
    maxZoom: 19,
    op: 100,
    attribution: '&copy; OSM, &copy; <a href="https://carto.com/">CARTO</a>',
  },
  terrainhd: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 13,
    op: 100,
    attribution: "Esri World Terrain",
  },
  hillshade: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 16,
    op: 45,
    attribution: "Esri World Hillshade",
  },
  trails: {
    url: "https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png",
    maxZoom: 18,
    op: 85,
    attribution: '<a href="https://hiking.waymarkedtrails.org">Waymarked Trails</a>',
  },
  // Exclus des packs offline (js/offline.js PACK_LAYERS) : hors-sujet sur le terrain
  // (mtb/ski) ou périssable en quelques minutes (rain).
  mtb: {
    url: "https://tile.waymarkedtrails.org/mtb/{z}/{x}/{y}.png",
    maxZoom: 18,
    op: 85,
    attribution: '<a href="https://mtb.waymarkedtrails.org">Waymarked Trails</a>',
  },
  ski: {
    url: "https://tile.waymarkedtrails.org/slopes/{z}/{x}/{y}.png",
    maxZoom: 18,
    op: 85,
    attribution: '<a href="https://slopes.waymarkedtrails.org">Waymarked Trails</a>',
  },
  rain: {
    // URL vraie fixée à l'activation (dernière image radar RainViewer, cf. refreshRainLayer)
    url: "",
    maxZoom: 18,
    op: 70,
    dynamic: true,
    attribution: '<a href="https://rainviewer.com">RainViewer</a>',
  },
};

// Ordre d'empilement, du fond vers le dessus. Sous MapLibre l'ordre des couches du style
// EST le z-index : tous les calques sont déclarés une fois pour toutes à l'initialisation
// (cachés par défaut), si bien qu'allumer/éteindre ne réordonne jamais rien.
const LAYER_ORDER = [
  "plan", "topo", "satellite", "sombre", "terrainhd",
  "hillshade", "trails", "mtb", "ski", "rain",
];

// ---------- Zooms ----------
// MapLibre compte les zooms pour des tuiles de 512 px ; le projet — et tous les
// fournisseurs de tuiles utilisés — raisonne en tuiles de 256 px, comme Leaflet.
// D'où un décalage constant de 1 : zoomProjet = zoomMapLibre + 1. Tout ce qui sort d'ici
// (mapZoom, fitBoundsL, flyToL) parle en zoom PROJET, pour que catalog/geosearch/offline
// gardent leurs seuils historiques sans conversion dispersée dans le code.
const ZOOM_OFFSET = 1;

// Sur-agrandissement (S-V2-ZOOM) : au-delà du zoom natif, MapLibre ré-échelonne les tuiles
// du dernier niveau réel au lieu d'afficher du gris. Plafonné à +2 niveaux — à +3 le flou
// efface les micro-détails (intersections, courbes de niveau) et donne une fausse confiance.
export const OVERZOOM = 2;

// Zoom natif de chaque calque, y compris mtb/ski/rain qui ne sont pas embarquables mais
// comptent pour le plafond de zoom en ligne.
const NATIVE_MAX = Object.fromEntries(
  Object.entries(TILE_TEMPLATES).map(([k, v]) => [k, v.maxZoom])
);

export const layersConfig = Object.assign(
  Object.fromEntries(LAYER_ORDER.map((n) => [n, { on: n === "plan", op: TILE_TEMPLATES[n].op }])),
  JSON.parse(localStorage.getItem("sr-layers") || "{}")
);

// Un modèle d'URL → le tableau `tiles` de MapLibre (un hôte par sous-domaine, à défaut
// l'URL telle quelle). C'est l'équivalent de la rotation {s} de Leaflet.
function tileUrls(def) {
  if (!def.url) return [];
  if (!def.subdomains) return [def.url];
  return def.subdomains.map((s) => def.url.replace("{s}", s));
}

function buildStyle() {
  const sources = {};
  const layers = [];
  for (const name of LAYER_ORDER) {
    const def = TILE_TEMPLATES[name];
    sources[`src-${name}`] = {
      type: "raster",
      tiles: tileUrls(def),
      tileSize: 256,
      maxzoom: def.maxZoom,
      attribution: def.attribution,
    };
    layers.push({
      id: `lyr-${name}`,
      type: "raster",
      source: `src-${name}`,
      layout: { visibility: "none" },
      paint: { "raster-opacity": (layersConfig[name]?.op ?? def.op) / 100 },
    });
  }
  return { version: 8, sources, layers };
}

export const map = new maplibregl.Map({
  container: "map",
  style: buildStyle(),
  center: [9.8, 45.9],
  zoom: 7 - ZOOM_OFFSET,
  maxZoom: 19 + OVERZOOM - ZOOM_OFFSET,
  attributionControl: false,
  // Le halo bleu du canvas au focus clavier n'apporte rien ici et casse le rendu épuré.
  refreshExpiredTiles: false,
});

// ---------- Attente du style ----------
// Ajouter une source ou une couche avant le chargement du style lève une erreur. Les
// consommateurs (tracé actif au boot, marqueurs) n'ont pas à connaître ce détail : ils
// appellent normalement, l'opération est rejouée dès que le style est prêt.
let styleReady = false;
const pending = [];
export function whenMapReady(fn) {
  if (styleReady) fn();
  else pending.push(fn);
}
map.on("load", () => {
  styleReady = true;
  pending.splice(0).forEach((fn) => fn());
});

// ---------- Conversions lat/lon ----------
// Le projet manipule partout des [lat, lon] ; MapLibre attend des [lng, lat]. Toutes les
// primitives ci-dessous prennent du lat/lon EN ENTRÉE et convertissent en un seul endroit :
// c'est la seule protection sérieuse contre l'inversion silencieuse.
const toLngLat = (p) =>
  Array.isArray(p) ? [p[1], p[0]] : [p.lng ?? p.lon, p.lat];

// Attend des points du projet ([lat, lon] ou {lat, lon}). Pour une liste DÉJÀ convertie en
// [lng, lat] — celle que garde drawTrack en interne — passer par boundsOfLngLat : appliquer
// la conversion deux fois ré-inverse les axes et envoie le cadrage à l'autre bout du monde.
export function boundsOf(points) {
  return boundsOfLngLat(points.map(toLngLat));
}

export function boundsOfLngLat(lngLats) {
  const b = new maplibregl.LngLatBounds();
  lngLats.forEach((p) => b.extend(p));
  return b;
}

// `LngLatBounds.contains` attend un [lng, lat] : lui passer un [lat, lon] du projet
// « marche » sans erreur et renvoie faux au mauvais endroit. D'où ce passage obligé.
export const boundsContain = (bounds, latlon) => bounds.contains(toLngLat(latlon));

// Zoom courant en échelle PROJET (256 px), comparable aux seuils historiques.
export const mapZoom = () => map.getZoom() + ZOOM_OFFSET;

// Cadrage acceptant les options en échelle projet (maxZoom) et un padding uniforme ou
// détaillé {top,right,bottom,left}, comme le faisait fitBounds côté Leaflet.
export function fitBoundsL(bounds, opts = {}) {
  const { maxZoom, padding = 0, ...rest } = opts;
  map.fitBounds(bounds, {
    padding,
    ...(maxZoom != null ? { maxZoom: maxZoom - ZOOM_OFFSET } : {}),
    ...rest,
  });
}

export function flyToL(lat, lon, zoom, opts = {}) {
  map.flyTo({
    center: [lon, lat],
    ...(zoom != null ? { zoom: zoom - ZOOM_OFFSET } : {}),
    ...opts,
  });
}

// Zoom projet le plus serré qui contient la bbox — remplace getBoundsZoom de Leaflet.
export function boundsZoomL(bounds, padding = 40) {
  const cam = map.cameraForBounds(bounds, { padding });
  return cam ? cam.zoom + ZOOM_OFFSET : mapZoom();
}

// ---------- Primitives de dessin ----------
// Cercle géodésique : `L.circle` de Leaflet prenait un rayon en MÈTRES, alors que le
// `circle-radius` de MapLibre est en pixels (il ne suivrait pas le zoom). On produit donc
// un vrai polygone. Sert au cercle de précision GPS, et à l'anneau des boucles au sprint B.
export function circlePolygon(lat, lon, radiusM, steps = 72) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180) || 1);
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
}

// Élément DOM d'un marqueur — remplace les `L.divIcon`. Les règles CSS qui neutralisaient
// le style par défaut de Leaflet (`background:none;border:none`) n'ont plus d'objet.
export function makeIcon(className, html = "", size = null) {
  const el = document.createElement("div");
  el.className = className;
  if (html) el.innerHTML = html;
  if (size) {
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
  }
  return el;
}

export function domMarker(lat, lon, { element, draggable = false, anchor = "center" } = {}) {
  return new maplibregl.Marker({ element, draggable, anchor }).setLngLat([lon, lat]);
}

// Un marqueur MapLibre est du DOM posé au-dessus du canvas : le montrer ou le cacher est
// plus économique que de le détacher puis rattacher (ce que faisait `map.hasLayer` +
// `addTo`/`remove` côté Leaflet), et évite de perdre popup et écouteurs au passage.
export function setMarkerVisible(marker, on) {
  const el = marker?.getElement();
  if (el) el.style.display = on ? "" : "none";
}

// ---------- Tracé à liseré (S-V2-TRACE) ----------
// Retour terrain : « l'actuel est très peu visible ». Un trait plat de 4 px disparaît dans
// les courbes de niveau orange du topo (qui rend lui-même les routes de rando en rouge),
// dans les verts du satellite et en plein soleil. Rendu façon AllTrails/Komoot : un liseré
// sombre porte le contraste sur TOUS les fonds (clair comme sombre — c'est un écart de
// luminance, pas de teinte) et le cœur vif porte l'identification.
export const TRACK_COLOR = "#ff2d20";
export const TRACK_CASING = "rgba(9, 9, 11, 0.62)";

let trackSeq = 0;

// Un tracé = une source GeoJSON + deux couches `line` superposées (liseré, puis cœur).
// Renvoie une poignée au contrat stable : setData / remove / getBounds — celui dont
// dépendent trails.js, nav.js et, au sprint B, le planificateur.
export function drawTrack(latlngs, opts = {}) {
  const { color = TRACK_COLOR, weight = 4.5, opacity = 1, dashArray = null } = opts;
  const id = `trk-${++trackSeq}`;
  const casingId = `${id}-casing`;
  const coreId = `${id}-core`;
  let coords = latlngs.map(toLngLat);
  let added = false;
  let removed = false;

  const feature = () => ({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: coords },
  });

  // `dashArray` de Leaflet est en pixels ; `line-dasharray` de MapLibre est en multiples
  // de la largeur du trait — d'où la division, pour garder le même rythme visuel.
  const dashFor = (w) =>
    dashArray
      ? { "line-dasharray": dashArray.split(/[\s,]+/).map((n) => Number(n) / w) }
      : {};

  whenMapReady(() => {
    if (removed) return;
    map.addSource(id, { type: "geojson", data: feature() });
    const layout = { "line-cap": "round", "line-join": "round" };
    map.addLayer({
      id: casingId, type: "line", source: id, layout,
      paint: {
        "line-color": TRACK_CASING,
        "line-width": weight + 5,
        "line-opacity": opacity,
        ...dashFor(weight + 5),
      },
    });
    map.addLayer({
      id: coreId, type: "line", source: id, layout,
      paint: {
        "line-color": color,
        "line-width": weight,
        "line-opacity": opacity,
        ...dashFor(weight),
      },
    });
    added = true;
  });

  return {
    id,
    layerIds: [casingId, coreId],
    setData(next) {
      coords = next.map(toLngLat);
      if (added) map.getSource(id)?.setData(feature());
    },
    getBounds() {
      return boundsOfLngLat(coords); // `coords` est déjà en [lng, lat]
    },
    remove() {
      removed = true;
      if (!added) return;
      [coreId, casingId].forEach((l) => map.getLayer(l) && map.removeLayer(l));
      if (map.getSource(id)) map.removeSource(id);
      added = false;
    },
  };
}

// ---------- Radar de précipitations ----------
async function refreshRainLayer() {
  try {
    const res = await fetchRetry("https://api.rainviewer.com/public/weather-maps.json", { timeout: 10000, retries: 1 });
    const data = await res.json();
    const frame = data.radar?.nowcast?.[0] || data.radar?.past?.at(-1);
    if (!frame) return;
    // `setTiles` remplace l'URL de la source raster sans reconstruire le style (et donc
    // sans perdre les tracés et couches ajoutés par-dessus).
    map.getSource("src-rain")?.setTiles([`${data.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`]);
  } catch { /* radar indisponible : la couche reste vide */ }
}

// ---------- Calques ----------
// Plafond de zoom de la carte = meilleur zoom natif parmi les calques allumés, + OVERZOOM.
// Ainsi le sur-agrandissement reste borné à ce que la donnée la plus fine peut honnêtement
// porter : topo seul (natif 17) monte à z19, plan ou satellite (natif 19) à z21.
export function updateZoomCap() {
  const natives = LAYER_ORDER.filter((n) => layersConfig[n]?.on).map((n) => NATIVE_MAX[n] ?? 17);
  const cap = (natives.length ? Math.max(...natives) : 17) + OVERZOOM;
  const glCap = cap - ZOOM_OFFSET;
  if (map.getMaxZoom() !== glCap) map.setMaxZoom(glCap); // MapLibre dézoome s'il était au-dessus
  return cap;
}

export function applyLayer(name) {
  const cfg = layersConfig[name];
  whenMapReady(() => {
    if (cfg.on && name === "rain") refreshRainLayer();
    map.setLayoutProperty(`lyr-${name}`, "visibility", cfg.on ? "visible" : "none");
    map.setPaintProperty(`lyr-${name}`, "raster-opacity", cfg.op / 100);
  });
  // Toutes les rangées de ce calque (panneau carte + onglet Navigation) restent en phase
  document.querySelectorAll(`.layer-row[data-layer="${name}"]`).forEach((row) => {
    row.querySelector("input[type=checkbox]").checked = cfg.on;
    row.querySelector(".layer-op").value = cfg.op;
    row.querySelector(".op-val").textContent = `${cfg.op}%`;
  });
  localStorage.setItem("sr-layers", JSON.stringify(layersConfig));
  updateZoomCap();
}

// ---- Couches de points d'intérêt (Overpass) : eau, refuges, secours ----
export const POI_DEFS = {
  water: {
    icon: "💧",
    label: (t) => t.name || "Eau potable",
    query: (b) =>
      `node["amenity"="drinking_water"](${b});node["natural"="spring"]["drinking_water"="yes"](${b});`,
  },
  huts: {
    icon: "🏠",
    label: (t) => t.name || (t.tourism === "alpine_hut" ? "Refuge" : "Abri"),
    query: (b) =>
      `nwr["tourism"="alpine_hut"](${b});nwr["tourism"="wilderness_hut"](${b});nwr["amenity"="shelter"](${b});`,
  },
  rescue: {
    icon: "⛑",
    label: (t) => t.name || (t.emergency === "phone" ? "Borne SOS" : "Secours en montagne"),
    query: (b) => `nwr["emergency"="mountain_rescue"](${b});node["emergency"="phone"](${b});`,
  },
};

// MapLibre n'a pas de LayerGroup : un groupe de marqueurs DOM est simplement une liste
// qu'on pose et retire d'un bloc. Même contrat que L.layerGroup pour les appelants.
export function markerGroup() {
  let items = [];
  let attached = false;
  return {
    add(marker) {
      items.push(marker);
      if (attached) marker.addTo(map);
      return this;
    },
    addTo() {
      attached = true;
      items.forEach((m) => m.addTo(map));
      return this;
    },
    clear() {
      items.forEach((m) => m.remove());
      items = [];
    },
    remove() {
      attached = false;
      items.forEach((m) => m.remove());
    },
  };
}

const poiState = {};
Object.keys(POI_DEFS).forEach((k) => {
  poiState[k] = { on: false, group: markerGroup(), loading: false };
});

function poiPopupHTML(def, tags, lat, lon) {
  return `<div class="popup-title">${def.icon} ${def.label(tags)}</div>
     <div class="popup-meta">${tags.ele ? `${tags.ele} m · ` : ""}${tags.operator || ""}
     ${tags.opening_hours ? `<br>${tags.opening_hours}` : ""}</div>
     <div class="popup-meta"><a href="https://maps.google.com/?q=${lat},${lon}" target="_blank">Itinéraire vers ce point</a></div>`;
}

async function refreshPoi(kind) {
  const poiHint = document.getElementById("poi-hint");
  const st = poiState[kind];
  const def = POI_DEFS[kind];
  if (!st.on || st.loading) return;
  if (mapZoom() < 10) {
    poiHint.textContent = "Zoomez sur un massif : les points se chargent pour la zone affichée.";
    return;
  }
  st.loading = true;
  poiHint.textContent = "Chargement des points…";
  try {
    const b = map.getBounds();
    const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
    const query = `[out:json][timeout:20];(${def.query(bbox)});out center 300;`;
    const elements = (await overpassFetch(query)).elements || [];
    st.group.clear();
    elements.forEach((el) => {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null) return;
      const tags = el.tags || {};
      const marker = domMarker(lat, lon, { element: makeIcon("poi-marker", def.icon, 22) })
        .setPopup(new maplibregl.Popup({ className: "map-popup", offset: 14 })
          .setHTML(poiPopupHTML(def, tags, lat, lon)));
      // Planificateur ouvert : un point d'intérêt cliqué devient un point de passage
      // (ou un repère nommé d'après le POI, si le mode annotation est armé)
      marker.getElement().addEventListener("click", (ev) => {
        if (!planner.active) return;
        ev.stopPropagation();
        marker.getPopup()?.remove();
        plannerMapClick({ lat, lng: lon }, def.label(tags));
      });
      st.group.add(marker);
    });
    poiHint.textContent = `${elements.length} point(s) chargé(s) sur la zone affichée.`;
  } catch (err) {
    poiHint.textContent = `Chargement impossible (${err.message}) — réessayez dans quelques secondes.`;
  } finally {
    st.loading = false;
  }
}

// ---- Marqueurs de tracés + survol ----
export const markers = new Map();
let activeTrack = null;
let hoverTrack = null;

// Tracé du parcours sélectionné : dessiné/effacé depuis plusieurs domaines
// (preview, sélection, fermeture de fiche) — encapsulé ici.
export function drawActiveTrack(trail) {
  if (activeTrack) activeTrack.remove();
  activeTrack = drawTrack(trail.segments || trail.track);
  return activeTrack;
}

export function clearActiveTrack() {
  if (activeTrack) activeTrack.remove();
  activeTrack = null;
}

function hoverCardHTML(trail) {
  const url = photoOf(trail);
  const gain = trail.elevationGain ?? state.elev[trail.id]?.gain;
  return `
    <div class="hover-card">
      <div class="hover-photo" style="${url ? `background-image:url('${url}')` : `background-image:${trail.gradient}`}"></div>
      <div class="hover-body">
        <div class="hover-title">${trail.name}</div>
        <div class="hover-meta">${trail.distance} km${gain ? ` · ${Math.round(gain)} m D+` : ""} · ${trail.duration}${trail.bivouac ? " · ⛺" : ""}</div>
      </div>
    </div>`;
}

// MapLibre n'a pas de primitive Tooltip : la carte de survol est un Popup sans chrome
// (ni croix, ni fermeture au clic carte), neutralisé en CSS comme l'était celui de Leaflet.
let hoverPopup = null;

function showHoverCard(trail) {
  hideHoverCard();
  hoverPopup = new maplibregl.Popup({
    className: "hover-tooltip",
    closeButton: false,
    closeOnClick: false,
    closeOnMove: false,
    offset: 14,
    maxWidth: "none",
  })
    .setLngLat([trail.center[1], trail.center[0]])
    .setHTML(hoverCardHTML(trail))
    .addTo(map);
}

function hideHoverCard() {
  hoverPopup?.remove();
  hoverPopup = null;
}

export function addMarker(trail) {
  // Idempotent : un même id peut être reposé (copie enregistrée + entrée catalogue,
  // ré-hydratation au boot) — on retire l'ancien marqueur avant d'en poser un neuf.
  markers.get(trail.id)?.remove();
  const size = trail.osm ? 12 : 16;
  const el = makeIcon(trail.osm ? "trail-marker trail-marker-osm" : "trail-marker", "", size);
  const marker = domMarker(trail.center[0], trail.center[1], { element: el }).addTo(map);

  el.addEventListener("mouseenter", () => {
    showHoverCard(trail);
    if (state.selectedId === trail.id) return;
    hoverTrack?.remove();
    hoverTrack = drawTrack(trail.segments || trail.track, {
      weight: 3.5,
      opacity: 0.9,
      dashArray: "7 9",
    });
  });
  el.addEventListener("mouseleave", () => {
    hideHoverCard();
    hoverTrack?.remove();
    hoverTrack = null;
  });
  el.addEventListener("click", (ev) => {
    // Sans cela le clic atteindrait la carte, qui poserait un point de passage en plus.
    ev.stopPropagation();
    hideHoverCard();
    hoverTrack?.remove();
    hoverTrack = null;
    if (planner.active) {
      plannerMapClick({ lat: trail.center[0], lng: trail.center[1] }, trail.name);
      return;
    }
    showPreview(trail);
  });

  markers.set(trail.id, marker);
}

// ---------- Prévisualisation d'un parcours (clic sur la carte) ----------
const accessCache = new Map();

let previewTrail = null;

export function hidePreview() {
  previewTrail = null;
  document.getElementById("trail-preview").classList.add("hidden");
}

// Ancre la carte de prévisualisation juste à côté du marqueur cliqué (desktop).
// Sur mobile (≤700 px) on garde la bottom-sheet définie en CSS.
function positionPreview(trail) {
  const el = document.getElementById("trail-preview");
  if (window.innerWidth < 700) {
    el.classList.remove("anchored", "preview-below");
    el.style.left = el.style.top = el.style.bottom = "";
    return;
  }
  el.classList.add("anchored");
  const pt = map.project([trail.center[1], trail.center[0]]);
  const canvas = map.getCanvas();
  const size = { x: canvas.clientWidth, y: canvas.clientHeight };
  const w = el.offsetWidth || 320;
  const h = el.offsetHeight || 200;
  const gap = 16;
  const left = Math.max(8, Math.min(pt.x - w / 2, size.x - w - 8));
  let top = pt.y - h - gap;              // au-dessus du point par défaut
  const below = top < 8;
  if (below) top = pt.y + gap;           // pas la place au-dessus → en dessous
  top = Math.min(top, size.y - h - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.bottom = "auto";
  el.classList.toggle("preview-below", below);
}

async function fetchAccess(trail, el) {
  if (!state.lastPos) return;
  const key = `${trail.id}:${state.lastPos.lat.toFixed(3)},${state.lastPos.lon.toFixed(3)}`;
  if (!accessCache.has(key)) {
    el.innerHTML = `<span class="muted">🏍 calcul de l'accès…</span>`;
    try {
      const dest = trackOf(trail)[0];
      const res = await fetchRetry(
        `https://router.project-osrm.org/route/v1/driving/` +
        `${state.lastPos.lon},${state.lastPos.lat};${dest[1]},${dest[0]}?overview=false`,
        { timeout: 15000 }
      );
      const route = (await res.json()).routes?.[0];
      if (!route) throw new Error();
      accessCache.set(key, {
        km: Math.round(route.distance / 1000),
        min: Math.round(route.duration / 60),
      });
    } catch {
      el.innerHTML = `<span class="muted">Accès routier indisponible.</span>`;
      return;
    }
  }
  const a = accessCache.get(key);
  el.innerHTML = `🏍 <strong>${a.km} km</strong> · ${Math.floor(a.min / 60)} h ${String(a.min % 60).padStart(2, "0")} de route depuis ma position`;
}

export function showPreview(trail) {
  state.selectedId = trail.id;
  drawActiveTrack(trail);
  renderList();

  const gain = trail.elevationGain ?? state.elev[trail.id]?.gain;
  document.getElementById("preview-photo").style.cssText = photoStyle(trail);
  document.getElementById("preview-title").textContent = trail.name;
  document.getElementById("preview-meta").innerHTML =
    `<strong>${trail.distance} km</strong> · ${gain ? `${Math.round(gain)} m D+ · ` : ""}` +
    `<span class="preview-type">${trail.type}</span> · ${trail.duration}${trail.bivouac ? " · ⛺" : ""}`;

  const accessEl = document.getElementById("preview-access");
  if (state.lastPos) {
    fetchAccess(trail, accessEl);
  } else {
    accessEl.innerHTML = `<button class="btn" id="preview-locate">📍 Distance depuis ma position</button>`;
    accessEl.querySelector("#preview-locate").addEventListener("click", () => {
      navigator.geolocation?.getCurrentPosition(
        (pos) => { savePos(pos); fetchAccess(trail, accessEl); },
        () => (accessEl.innerHTML = `<span class="muted">Position indisponible.</span>`)
      );
    });
  }
  const previewEl = document.getElementById("trail-preview");
  previewEl.classList.remove("hidden");
  previewTrail = trail;
  positionPreview(trail);
}

// ---------- Coordonnées d'un point (clic droit / appui long) ----------
function toDMS(deg, [pos, neg]) {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = ((a - d - m / 60) * 3600).toFixed(1);
  return `${d}°${String(m).padStart(2, "0")}′${s.padStart(4, "0")}″${deg >= 0 ? pos : neg}`;
}

function showCoordPopup(lngLat) {
  const dec = `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`;
  const html =
    `<div class="coord-popup">` +
    `<div class="coord-label">Coordonnées</div>` +
    `<div class="coord-dec">${dec}</div>` +
    `<div class="coord-dms">${toDMS(lngLat.lat, ["N", "S"])} · ${toDMS(lngLat.lng, ["E", "O"])}</div>` +
    `<button class="coord-copy" data-coord="${dec}">Copier</button>` +
    `</div>`;
  // La largeur minimale est désormais du CSS pur (.map-popup.coord) : Leaflet exigeait un
  // `minWidth` en option parce qu'il dimensionnait le wrapper à l'ouverture, MapLibre non.
  const popup = new maplibregl.Popup({ className: "map-popup coord", closeButton: true })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);

  // Leaflet offrait un `popupopen` global sur la carte ; ici le listener se pose sur
  // l'instance, ce qui est de toute façon plus sûr (pas de délégation à l'aveugle).
  const btn = popup.getElement()?.querySelector(".coord-copy");
  btn?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.coord);
      btn.textContent = "✓ Copié";
    } catch {
      btn.textContent = "⚠ copie impossible";
    }
    setTimeout(() => (btn.textContent = "Copier"), 1500);
  });
}

// MapLibre n'émet pas `contextmenu` sur un appui long tactile (Leaflet le faisait) :
// sans ce détecteur, la bulle de coordonnées deviendrait inaccessible au téléphone.
function enableLongPress(onLongPress) {
  const canvas = map.getCanvasContainer();
  let timer = null;
  let start = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  canvas.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return cancel();
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
    timer = setTimeout(() => {
      timer = null;
      const rect = canvas.getBoundingClientRect();
      onLongPress(map.unproject([start.x - rect.left, start.y - rect.top]));
    }, 550);
  }, { passive: true });
  // Un doigt qui glisse de plus de 10 px, c'est un déplacement de carte, pas un appui.
  canvas.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (!start || !t) return;
    if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) cancel();
  }, { passive: true });
  canvas.addEventListener("touchend", cancel, { passive: true });
  canvas.addEventListener("touchcancel", cancel, { passive: true });
}

// ---------- Boussole ----------
// Épuré par défaut : le bouton n'existe à l'écran que si la carte est effectivement
// pivotée. Un tap remet le nord. La rotation elle-même (deux doigts, clic droit glissé)
// est native à MapLibre.
function initCompass() {
  const btn = document.getElementById("btn-compass");
  if (!btn) return;
  const needle = btn.querySelector(".compass-needle");
  const sync = () => {
    const bearing = map.getBearing();
    btn.classList.toggle("hidden", Math.abs(bearing) < 0.5);
    if (needle) needle.style.transform = `rotate(${-bearing}deg)`;
  };
  map.on("rotate", sync);
  map.on("rotateend", sync);
  btn.addEventListener("click", () => map.easeTo({ bearing: 0, pitch: 0, duration: 300 }));
  sync();
}

export function initMap() {
  map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 96, unit: "metric" }), "bottom-left");
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
  initCompass();

  const layersControl = document.getElementById("layers-control");
  const layersPanel = document.getElementById("layers-panel");
  // Équivalent de L.DomEvent.disableClickPropagation : la pile de contrôles est du DOM
  // posé au-dessus du canvas, ses clics et molettes ne doivent pas piloter la carte.
  ["click", "dblclick", "mousedown", "pointerdown", "wheel", "touchstart"].forEach((ev) =>
    layersControl.addEventListener(ev, (e) => e.stopPropagation())
  );

  document.getElementById("layers-toggle").addEventListener("click", () =>
    layersPanel.classList.toggle("hidden")
  );

  document.querySelectorAll(".layer-row[data-layer]").forEach((row) => {
    const name = row.dataset.layer;
    row.querySelector("input[type=checkbox]").addEventListener("change", (e) => {
      layersConfig[name].on = e.target.checked;
      applyLayer(name);
    });
    row.querySelector(".layer-op").addEventListener("input", (e) => {
      layersConfig[name].op = Number(e.target.value);
      applyLayer(name);
    });
  });

  LAYER_ORDER.forEach(applyLayer);

  document.querySelectorAll(".layer-row[data-poi]").forEach((row) => {
    const kind = row.dataset.poi;
    row.querySelector("input[type=checkbox]").addEventListener("change", (e) => {
      poiState[kind].on = e.target.checked;
      if (e.target.checked) {
        poiState[kind].group.addTo();
        refreshPoi(kind);
      } else {
        poiState[kind].group.remove();
      }
    });
  });

  let poiMoveTimer;
  map.on("moveend", () => {
    clearTimeout(poiMoveTimer);
    poiMoveTimer = setTimeout(() => Object.keys(poiState).forEach(refreshPoi), 700);
  });

  // La prévisualisation reste collée à son marqueur pendant les déplacements de carte
  map.on("move", () => {
    if (previewTrail && !document.getElementById("trail-preview").classList.contains("hidden")) {
      positionPreview(previewTrail);
    }
  });

  // ---- Bouton de localisation ----
  // MapLibre n'a pas d'équivalent de `map.locate()` : on passe par l'API géoloc du
  // navigateur, ce qui donne au passage la main sur le message d'erreur.
  let locMarker = null;
  const ACCURACY_SRC = "src-accuracy";

  function showAccuracy(lat, lon, accuracy) {
    const data = circlePolygon(lat, lon, accuracy);
    whenMapReady(() => {
      if (map.getSource(ACCURACY_SRC)) {
        map.getSource(ACCURACY_SRC).setData(data);
        return;
      }
      map.addSource(ACCURACY_SRC, { type: "geojson", data });
      map.addLayer({
        id: "lyr-accuracy-fill", type: "fill", source: ACCURACY_SRC,
        paint: { "fill-color": "#2b7de0", "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: "lyr-accuracy-line", type: "line", source: ACCURACY_SRC,
        paint: { "line-color": "#2b7de0", "line-width": 1, "line-opacity": 0.7 },
      });
    });
  }

  document.getElementById("btn-locate").addEventListener("click", () => {
    if (!navigator.geolocation) {
      toast("Géolocalisation indisponible sur cet appareil.", { type: "error" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lon, accuracy } = pos.coords;
        locMarker?.remove();
        locMarker = domMarker(lat, lon, { element: makeIcon("locate-dot", "", 16) }).addTo(map);
        showAccuracy(lat, lon, accuracy);
        flyToL(lat, lon, Math.min(15, mapZoom() > 15 ? mapZoom() : 15), { duration: 900 });
        savePos(pos);
        if (loops.active) setLoopStart({ lat, lng: lon }); // « ma position » = départ de la boucle
      },
      (err) => toast(`Position introuvable : ${err.message}`, { type: "error" }),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });

  // Clic sur la carte : point de passage si le planificateur est ouvert, départ de
  // boucle si le générateur l'est, sinon referme les calques
  map.on("click", (e) => {
    if (planner.active) { plannerMapClick(e.lngLat); return; }
    if (loops.active) { setLoopStart(e.lngLat); return; }
    layersPanel.classList.add("hidden");
  });

  // Clic droit (desktop) / appui long (mobile) : bulle des coordonnées du point pointé
  map.on("contextmenu", (e) => showCoordPopup(e.lngLat));
  enableLongPress(showCoordPopup);

  document.getElementById("preview-close").addEventListener("click", () => {
    hidePreview();
    state.selectedId = null;
    clearActiveTrack();
    renderList();
  });

  document.getElementById("preview-open").addEventListener("click", () => {
    if (state.selectedId) renderDetail(state.selectedId);
  });

  document.getElementById("preview-follow").addEventListener("click", () => {
    if (state.selectedId) startNavigation(state.selectedId);
  });
}
