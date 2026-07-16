// Sancho Rossi — carte Leaflet : fonds, calques, POI Overpass, marqueurs, prévisualisation
import { state, trackOf } from "./state.js";
import { overpassFetch } from "./api.js";
import { photoOf, photoStyle } from "./photos.js";
import { builder, builderAdd, builderAddPoint } from "./builder.js";
import { loops, setStart as setLoopStart } from "./loops.js";
import { renderList } from "./trails.js";
import { renderDetail } from "./detail.js";
import { startNavigation } from "./nav.js";
import { savePos } from "./security.js";

// ---------- Modèles de tuiles (source unique, réutilisée par le pack offline S5) ----------
// name → { url (avec {s}{z}{x}{y}), maxZoom }. L'ordre {y}/{x} d'ArcGIS est déjà
// encodé dans l'URL. Sert à construire les couches Leaflet ci-dessous ET à télécharger
// les corridors de tuiles (js/offline.js). Exclus des packs : mtb, ski, rain.
export const TILE_TEMPLATES = {
  plan: { url: "https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png", maxZoom: 19 },
  topo: { url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", maxZoom: 17 },
  satellite: { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", maxZoom: 19 },
  sombre: { url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", maxZoom: 19 },
  terrainhd: { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}", maxZoom: 13 },
  hillshade: { url: "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}", maxZoom: 16 },
  trails: { url: "https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png", maxZoom: 18 },
};

// ---------- Carte + calques ----------
const baseLayers = {
  plan: L.tileLayer("https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }),
  topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17,
    attribution: '&copy; OSM, <a href="https://opentopomap.org">OpenTopoMap</a>',
  }),
  satellite: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Tiles &copy; Esri — Maxar, Earthstar Geographics" }
  ),
  sombre: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    attribution: '&copy; OSM, &copy; <a href="https://carto.com/">CARTO</a>',
  }),
  terrainhd: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 13, attribution: "Esri World Terrain" }
  ),
};

const overlayLayers = {
  trails: L.tileLayer("https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png", {
    maxZoom: 18,
    opacity: 0.85,
    attribution: '<a href="https://hiking.waymarkedtrails.org">Waymarked Trails</a>',
  }),
  hillshade: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 16, opacity: 0.45, attribution: "Esri World Hillshade" }
  ),
  mtb: L.tileLayer("https://tile.waymarkedtrails.org/mtb/{z}/{x}/{y}.png", {
    maxZoom: 18, opacity: 0.85, attribution: '<a href="https://mtb.waymarkedtrails.org">Waymarked Trails</a>',
  }),
  ski: L.tileLayer("https://tile.waymarkedtrails.org/slopes/{z}/{x}/{y}.png", {
    maxZoom: 18, opacity: 0.85, attribution: '<a href="https://slopes.waymarkedtrails.org">Waymarked Trails</a>',
  }),
  // URL fixée dynamiquement (dernière image radar RainViewer) à l'activation
  rain: L.tileLayer("", { maxZoom: 18, opacity: 0.7, attribution: '<a href="https://rainviewer.com">RainViewer</a>' }),
};

// Radar de précipitations : récupère l'horodatage de la dernière image
async function refreshRainLayer() {
  try {
    const res = await fetch("https://api.rainviewer.com/public/weather-maps.json");
    const data = await res.json();
    const frame = data.radar?.nowcast?.[0] || data.radar?.past?.at(-1);
    if (frame) overlayLayers.rain.setUrl(`${data.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`);
  } catch { /* radar indisponible : la couche reste vide */ }
}

export const map = L.map("map", { zoomControl: false }).setView([45.9, 9.8], 7);

// ---- Calques empilables avec interrupteur + opacité (façon Maria) ----
const LAYERS = {
  plan: baseLayers.plan.setZIndex(1),
  topo: baseLayers.topo.setZIndex(2),
  satellite: baseLayers.satellite.setZIndex(3),
  sombre: baseLayers.sombre.setZIndex(4),
  terrainhd: baseLayers.terrainhd.setZIndex(5),
  hillshade: overlayLayers.hillshade.setZIndex(6),
  trails: overlayLayers.trails.setZIndex(7),
  mtb: overlayLayers.mtb.setZIndex(8),
  ski: overlayLayers.ski.setZIndex(9),
  rain: overlayLayers.rain.setZIndex(10),
};

export const layersConfig = Object.assign(
  {
    plan: { on: true, op: 100 },
    topo: { on: false, op: 100 },
    satellite: { on: false, op: 100 },
    sombre: { on: false, op: 100 },
    terrainhd: { on: false, op: 100 },
    hillshade: { on: false, op: 45 },
    trails: { on: false, op: 85 },
    mtb: { on: false, op: 85 },
    ski: { on: false, op: 85 },
    rain: { on: false, op: 70 },
  },
  JSON.parse(localStorage.getItem("sr-layers") || "{}")
);

export function applyLayer(name) {
  const cfg = layersConfig[name];
  const layer = LAYERS[name];
  if (cfg.on) {
    if (name === "rain") refreshRainLayer();
    layer.addTo(map);
    layer.setOpacity(cfg.op / 100);
  } else {
    layer.remove();
  }
  const row = document.querySelector(`.layer-row[data-layer="${name}"]`);
  if (row) {
    row.querySelector("input[type=checkbox]").checked = cfg.on;
    row.querySelector(".layer-op").value = cfg.op;
    row.querySelector(".op-val").textContent = `${cfg.op}%`;
  }
  localStorage.setItem("sr-layers", JSON.stringify(layersConfig));
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

const poiState = {};
Object.keys(POI_DEFS).forEach((k) => {
  poiState[k] = { on: false, group: L.layerGroup(), loading: false };
});

async function refreshPoi(kind) {
  const poiHint = document.getElementById("poi-hint");
  const st = poiState[kind];
  const def = POI_DEFS[kind];
  if (!st.on || st.loading) return;
  if (map.getZoom() < 10) {
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
    st.group.clearLayers();
    elements.forEach((el) => {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null) return;
      const tags = el.tags || {};
      const marker = L.marker([lat, lon], {
        icon: L.divIcon({ className: "poi-marker", html: def.icon, iconSize: [22, 22] }),
      });
      // En mode dessin, un point d'intérêt cliqué devient une étape du parcours
      marker.on("click", () => {
        if (builder.active && builder.mode === "draw") {
          marker.closePopup();
          builderAddPoint(L.latLng(lat, lon));
        }
      });
      marker.bindPopup(
        `<div class="popup-title">${def.icon} ${def.label(tags)}</div>
         <div class="popup-meta">${tags.ele ? `${tags.ele} m · ` : ""}${tags.operator || ""}
         ${tags.opening_hours ? `<br>${tags.opening_hours}` : ""}</div>
         <div class="popup-meta"><a href="https://maps.google.com/?q=${lat},${lon}" target="_blank">Itinéraire vers ce point</a></div>`,
        { className: "map-popup" }
      );
      st.group.addLayer(marker);
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

// Tracé rouge du parcours sélectionné : dessiné/effacé depuis plusieurs domaines
// (preview, sélection, fermeture de fiche) — encapsulé ici.
export function drawActiveTrack(trail) {
  if (activeTrack) activeTrack.remove();
  activeTrack = L.polyline(trail.segments || trail.track, {
    color: "#ff2d20", weight: 4, opacity: 0.95,
  }).addTo(map);
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

export function addMarker(trail) {
  // Idempotent : un même id peut être reposé (copie enregistrée + entrée catalogue,
  // ré-hydratation au boot) — on retire l'ancien marqueur avant d'en poser un neuf.
  markers.get(trail.id)?.remove();
  const marker = L.marker(trail.center, {
    icon: L.divIcon({
      className: trail.osm ? "trail-marker trail-marker-osm" : "trail-marker",
      iconSize: [trail.osm ? 12 : 16, trail.osm ? 12 : 16],
    }),
  }).addTo(map);
  marker.bindTooltip(() => hoverCardHTML(trail), {
    direction: "top",
    offset: [0, -10],
    opacity: 1,
    className: "hover-tooltip",
  });
  marker.on("mouseover", () => {
    if (state.selectedId === trail.id) return;
    hoverTrack?.remove();
    hoverTrack = L.polyline(trail.segments || trail.track, {
      color: "#ff2d20",
      weight: 3,
      opacity: 0.85,
      dashArray: "7 7",
      interactive: false,
    }).addTo(map);
  });
  marker.on("mouseout", () => {
    hoverTrack?.remove();
    hoverTrack = null;
  });
  marker.on("click", () => {
    hoverTrack?.remove();
    hoverTrack = null;
    marker.closeTooltip();
    if (builder.active) {
      if (builder.mode === "trails") builderAdd(trail);
      else builderAddPoint(L.latLng(trail.center[0], trail.center[1]));
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
  const pt = map.latLngToContainerPoint(trail.center);
  const size = map.getSize();
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
      const res = await fetch(
        `https://router.project-osrm.org/route/v1/driving/` +
        `${state.lastPos.lon},${state.lastPos.lat};${dest[1]},${dest[0]}?overview=false`
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

function showCoordPopup(latlng) {
  const dec = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
  const html =
    `<div class="coord-popup">` +
    `<div class="coord-label">Coordonnées</div>` +
    `<div class="coord-dec">${dec}</div>` +
    `<div class="coord-dms">${toDMS(latlng.lat, ["N", "S"])} · ${toDMS(latlng.lng, ["E", "O"])}</div>` +
    `<button class="coord-copy" data-coord="${dec}">Copier</button>` +
    `</div>`;
  // `minWidth` doit être passé à Leaflet (et non en CSS sur .coord-popup) : Leaflet
  // dimensionne le wrapper à l'ouverture d'après le contenu et ignore un min-width
  // interne — le texte débordait alors hors du fond. 190 px tient la ligne DMS.
  L.popup({ className: "map-popup coord", autoPan: true, closeButton: true, minWidth: 190 })
    .setLatLng(latlng)
    .setContent(html)
    .openOn(map);
}

export function initMap() {
  L.control.zoom({ position: "bottomright" }).addTo(map);

  const layersControl = document.getElementById("layers-control");
  const layersPanel = document.getElementById("layers-panel");
  L.DomEvent.disableClickPropagation(layersControl);
  L.DomEvent.disableScrollPropagation(layersControl);

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

  Object.keys(LAYERS).forEach(applyLayer);

  document.querySelectorAll(".layer-row[data-poi]").forEach((row) => {
    const kind = row.dataset.poi;
    row.querySelector("input[type=checkbox]").addEventListener("change", (e) => {
      poiState[kind].on = e.target.checked;
      if (e.target.checked) {
        poiState[kind].group.addTo(map);
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
  map.on("move zoom", () => {
    if (previewTrail && !document.getElementById("trail-preview").classList.contains("hidden")) {
      positionPreview(previewTrail);
    }
  });

  // ---- Bouton de localisation ----
  let locMarker = null;
  let locCircle = null;

  document.getElementById("btn-locate").addEventListener("click", () => {
    map.locate({ setView: true, maxZoom: 15, enableHighAccuracy: true });
  });

  map.on("locationfound", (e) => {
    if (locMarker) { locMarker.remove(); locCircle.remove(); }
    locCircle = L.circle(e.latlng, { radius: e.accuracy, weight: 1, color: "#2b7de0", fillOpacity: 0.12 }).addTo(map);
    locMarker = L.circleMarker(e.latlng, { radius: 8, color: "#fff", weight: 2.5, fillColor: "#2b7de0", fillOpacity: 1 }).addTo(map);
    savePos({ coords: { latitude: e.latlng.lat, longitude: e.latlng.lng, accuracy: e.accuracy } });
    if (loops.active) setLoopStart(e.latlng); // « ma position » = départ de la boucle
  });

  map.on("locationerror", (e) => alert(`Position introuvable : ${e.message}`));

  // Clic sur la carte : point de dessin en mode créateur, sinon referme les calques
  map.on("click", (e) => {
    if (builder.active && builder.mode === "draw") {
      builderAddPoint(e.latlng);
      return;
    }
    if (loops.active) { setLoopStart(e.latlng); return; }
    layersPanel.classList.add("hidden");
  });

  // Clic droit (desktop) / appui long (mobile) : bulle des coordonnées du point pointé
  map.on("contextmenu", (e) => showCoordPopup(e.latlng));

  // Copie des coordonnées depuis la bulle (délégué à l'ouverture de n'importe quel popup)
  map.on("popupopen", (e) => {
    const btn = e.popup.getElement()?.querySelector(".coord-copy");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.coord);
        btn.textContent = "✓ Copié";
      } catch {
        btn.textContent = "⚠ copie impossible";
      }
      setTimeout(() => (btn.textContent = "Copier"), 1500);
    });
  });

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
