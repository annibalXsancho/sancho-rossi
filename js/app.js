// Sancho Rossi — logique applicative v4
// Outil mono-utilisateur : pas de comptes, pas d'avis. Tout est stocké en local.

import {
  state, BASE_TRAILS as TRAILS, CATALOG,
  allTrails, getTrail, trackOf, normalizeOsmTrail,
  sampleTrack, haversineKm, trackDistanceKm, saveNote,
} from "./state.js";

const weatherCache = new Map();

// ---------- Thème ----------
const themeBtn = document.getElementById("btn-theme");
const themeSelect = document.getElementById("setting-theme");

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("sr-theme", theme);
  themeBtn.textContent = theme === "dark" ? "☀️" : "🌙";
  themeSelect.value = theme;
}

applyTheme(document.documentElement.dataset.theme || "light");
themeBtn.addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")
);
themeSelect.addEventListener("change", () => applyTheme(themeSelect.value));

// ---------- Photos réelles des lieux (Wikipédia italien) ----------
const WIKI = {
  "tre-cime-bivouac": "Tre_Cime_di_Lavaredo",
  "braies-fanes": "Lago_di_Braies",
  "gran-paradiso-vittorio": "Gran_Paradiso",
  "sentiero-roma-sud": "Sentiero_Roma",
  "val-grande-traversata": "Parco_nazionale_della_Val_Grande",
  "laghi-gemelli": "Rifugio_Laghi_Gemelli",
  "puez-odle": "Gruppo_delle_Odle",
  "catinaccio-antermoia": "Catinaccio",
  "monviso-tour": "Monviso",
  "devero-veglia": "Alpe_Devero",
  "rosa-ayas-lacs": "Val_d'Ayas",
  "sassolungo-tour": "Sassolungo",
  "sorapis-lago": "Lago_di_Sorapiss",
  "grigna-settentrionale": "Grigna_settentrionale",
  "baldo-crete": "Monte_Baldo",
  "val-genova-cascades": "Val_Genova",
  "marmolada-viel-del-pan": "Marmolada",
};

function photoOf(trail) {
  return state.photos[trail.id] || trail.image || null;
}

function photoStyle(trail) {
  const url = photoOf(trail);
  return url
    ? `background-image: url('${url}'), ${trail.gradient};`
    : `background-image: ${trail.gradient};`;
}

async function loadWikiPhotos() {
  const missing = TRAILS.filter((t) => WIKI[t.id] && !state.photos[t.id]);
  if (!missing.length) return;
  await Promise.allSettled(
    missing.map(async (t) => {
      const res = await fetch(
        `https://it.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(WIKI[t.id])}`
      );
      if (!res.ok) return;
      const data = await res.json();
      const url = data.thumbnail?.source?.split("?")[0];
      if (url) state.photos[t.id] = url;
    })
  );
  localStorage.setItem("sr-photos", JSON.stringify(state.photos));
  renderAll();
}

// Photos des itinéraires du catalogue : article Wikipédia le plus proche du tracé
async function geoPhoto(trail) {
  const [lat, lon] = trail.center;
  const url =
    `https://it.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
    `&generator=geosearch&ggscoord=${lat}%7C${lon}&ggsradius=9000&ggslimit=1` +
    `&prop=pageimages&piprop=thumbnail&pithumbsize=640`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status);
  const pages = (await res.json()).query?.pages || {};
  return Object.values(pages)[0]?.thumbnail?.source || null;
}

function updateCardPhotos(trail) {
  document
    .querySelectorAll(`.trail-card[data-id="${trail.id}"] .card-photo`)
    .forEach((el) => (el.style.cssText = photoStyle(trail)));
}

let photoQueueRunning = false;
async function prefetchCatalogPhotos() {
  if (photoQueueRunning) return;
  photoQueueRunning = true;
  let sinceSave = 0;
  for (const t of CATALOG) {
    if (state.photos[t.id] !== undefined) continue;
    try {
      state.photos[t.id] = await geoPhoto(t);
    } catch {
      break; // réseau ou quota : on reprendra à la prochaine session
    }
    if (state.photos[t.id]) updateCardPhotos(t);
    if (++sinceSave % 10 === 0) localStorage.setItem("sr-photos", JSON.stringify(state.photos));
    await new Promise((r) => setTimeout(r, 350));
  }
  localStorage.setItem("sr-photos", JSON.stringify(state.photos));
  photoQueueRunning = false;
}

// ---------- Navigation par onglets ----------
function switchTab(name) {
  // Un clic d'onglet doit toujours répondre : on referme la fiche qui recouvre tout
  if (!detailPanel.classList.contains("hidden")) closeDetail();
  state.view = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.getElementById(`view-${name}`).classList.remove("hidden");
  document.querySelectorAll(".tab-nav-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name)
  );
  if (name === "carte") setTimeout(() => map.invalidateSize(), 60);
  if (name === "securite") renderSafety();
}

// Échap : referme fiche puis panneau de calques
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!detailPanel.classList.contains("hidden")) closeDetail();
  else document.getElementById("layers-panel").classList.add("hidden");
});

// Bouton retour du navigateur : referme la fiche au lieu de quitter l'app
window.addEventListener("popstate", () => {
  if (!detailPanel.classList.contains("hidden")) closeDetail(true);
});

document.querySelectorAll(".tab-nav-btn").forEach((b) =>
  b.addEventListener("click", () => switchTab(b.dataset.view))
);
document.getElementById("go-home").addEventListener("click", () => switchTab("accueil"));

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

const map = L.map("map", { zoomControl: false }).setView([45.9, 9.8], 7);
L.control.zoom({ position: "bottomright" }).addTo(map);

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

const layersConfig = Object.assign(
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

const layersControl = document.getElementById("layers-control");
const layersPanel = document.getElementById("layers-panel");
L.DomEvent.disableClickPropagation(layersControl);
L.DomEvent.disableScrollPropagation(layersControl);

document.getElementById("layers-toggle").addEventListener("click", () =>
  layersPanel.classList.toggle("hidden")
);

function applyLayer(name) {
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

// ---- Couches de points d'intérêt (Overpass) : eau, refuges, secours ----
// Interrogation Overpass avec miroir de secours en cas de saturation (429)
async function overpassFetch(query) {
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  let lastErr;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const POI_DEFS = {
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

const poiHint = document.getElementById("poi-hint");

async function refreshPoi(kind) {
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
});

map.on("locationerror", (e) => alert(`Position introuvable : ${e.message}`));

// Clic sur la carte : point de dessin en mode créateur, sinon referme les calques
map.on("click", (e) => {
  if (builder.active && builder.mode === "draw") {
    builderAddPoint(e.latlng);
    return;
  }
  layersPanel.classList.add("hidden");
});

const markers = new Map();
let activeTrack = null;

// Aperçu au survol d'un marqueur : tracé en pointillés + carte-info
let hoverTrack = null;

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

function addMarker(trail) {
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
const previewEl = document.getElementById("trail-preview");
const accessCache = new Map();

function hidePreview() {
  previewEl.classList.add("hidden");
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

function showPreview(trail) {
  state.selectedId = trail.id;
  if (activeTrack) activeTrack.remove();
  activeTrack = L.polyline(trail.segments || trail.track, {
    color: "#ff2d20", weight: 4, opacity: 0.95,
  }).addTo(map);
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
  previewEl.classList.remove("hidden");
}

document.getElementById("preview-close").addEventListener("click", () => {
  hidePreview();
  state.selectedId = null;
  if (activeTrack) activeTrack.remove();
  renderList();
});

document.getElementById("preview-open").addEventListener("click", () => {
  if (state.selectedId) renderDetail(state.selectedId);
});

document.getElementById("preview-follow").addEventListener("click", () => {
  if (state.selectedId) startNavigation(state.selectedId);
});

[...state.imported, ...TRAILS, ...CATALOG].forEach(addMarker);

// ---------- Filtres / tri ----------
function filteredTrails() {
  const q = state.search.trim().toLowerCase();
  let list = [...state.imported, ...TRAILS, ...CATALOG].filter((t) => {
    if (state.favoritesOnly && !state.favorites.has(t.id)) return false;
    if (state.source === "bivouac" && t.osm) return false;
    if (state.source === "osm" && !t.osm) return false;
    if (state.days && String(t.days) !== state.days) return false;
    if (state.difficulty && t.difficulty !== state.difficulty) return false;
    if (state.region && t.region !== state.region) return false;
    if (state.type && t.type !== state.type) return false;
    if (state.distMin != null && t.distance < state.distMin) return false;
    if (state.distMax != null && t.distance > state.distMax) return false;
    if (state.gainMax != null) {
      const g = t.elevationGain ?? state.elev[t.id]?.gain;
      if (g != null && g > state.gainMax) return false;
    }
    if (q) {
      const haystack = `${t.name} ${t.location} ${t.region}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const gain = (t) => t.elevationGain ?? state.elev[t.id]?.gain ?? 0;
  const sorters = {
    reco: (a, b) =>
      (b.bivouac ? 1 : 0) - (a.bivouac ? 1 : 0) ||
      (a.osm ? 1 : 0) - (b.osm ? 1 : 0) ||
      gain(b) - gain(a),
    "distance-asc": (a, b) => a.distance - b.distance,
    "distance-desc": (a, b) => b.distance - a.distance,
    elevation: (a, b) => gain(b) - gain(a),
  };
  return list.sort(sorters[state.sortBy]);
}

// ---------- Rendu des cartes d'itinéraires ----------
function cardHTML(t) {
  const faved = state.favorites.has(t.id);
  const gain = t.elevationGain ?? state.elev[t.id]?.gain;
  return `
  <article class="trail-card ${t.id === state.selectedId ? "selected" : ""}" data-id="${t.id}">
    <div class="card-photo" style="${photoStyle(t)}">
      <button class="card-fav ${faved ? "faved" : ""}" data-fav="${t.id}" title="${faved ? "Retirer" : "Enregistrer"}">${faved ? "♥" : "♡"}</button>
      ${t.imported
        ? `<span class="card-badge badge-gpx">${t.custom ? "Mon circuit" : "GPX importé"}</span>`
        : t.osm
        ? `<span class="card-badge badge-gpx">Balisé officiel</span>`
        : `<span class="card-badge badge-${t.difficulty}">${t.difficulty}</span>`}
      ${t.bivouac ? `<span class="card-badge badge-bivouac">⛺ 2 j</span>` : ""}
    </div>
    <div class="card-body">
      <h3 class="card-title">${t.name}</h3>
      <div class="card-location">${t.location}</div>
      <div class="card-meta">
        <span>${t.distance} km</span>
        <span class="dot">•</span>
        <span>${gain ? `${Math.round(gain)} m D+` : "D+ à calculer"}</span>
        <span class="dot">•</span>
        <span>${t.duration}</span>
      </div>
    </div>
  </article>`;
}

function bindCardEvents(container) {
  container.addEventListener("click", (e) => {
    const favBtn = e.target.closest("[data-fav]");
    if (favBtn) {
      toggleFavorite(favBtn.dataset.fav);
      return;
    }
    const card = e.target.closest(".trail-card");
    if (card) selectTrail(card.dataset.id);
  });
}

const listEl = document.getElementById("trail-list");
const gridEl = document.getElementById("grid-list");
const homeEl = document.getElementById("home-suggestions");
const countEl = document.getElementById("results-count");
bindCardEvents(listEl);
bindCardEvents(gridEl);
bindCardEvents(homeEl);
bindCardEvents(document.getElementById("agent-output"));

function renderList() {
  const trails = filteredTrails();
  countEl.textContent = `${trails.length} itinéraire${trails.length > 1 ? "s" : ""}`;
  listEl.innerHTML = trails.length
    ? trails.slice(0, 80).map(cardHTML).join("") +
      (trails.length > 80 ? `<p class="muted" style="text-align:center">… et ${trails.length - 80} autres (affinez les filtres)</p>` : "")
    : `<div class="empty-state"><div class="empty-icon">🥾</div><p>Aucun itinéraire ne correspond.</p></div>`;

  // Les itinéraires exclus par les filtres disparaissent aussi de la carte
  const visible = new Set(trails.map((t) => t.id));
  markers.forEach((marker, id) => {
    if (visible.has(id) || id === state.selectedId) {
      if (!map.hasLayer(marker)) marker.addTo(map);
    } else if (map.hasLayer(marker)) {
      marker.remove();
    }
  });
  updateFiltersBadge(trails.length);
}

function renderGrid() {
  const trails = filteredTrails();
  const total = [...state.imported, ...TRAILS, ...CATALOG].length;
  document.getElementById("grid-count").textContent = `(${trails.length}/${total})`;
  gridEl.innerHTML = trails.length
    ? trails.map(cardHTML).join("")
    : `<div class="empty-state"><div class="empty-icon">🥾</div><p>Aucun itinéraire ne correspond aux filtres.</p></div>`;
}

function renderHome() {
  document.getElementById("home-tagline").textContent =
    `Italie du Nord · ${TRAILS.length + CATALOG.length} itinéraires dont ${CATALOG.length} tracés balisés officiels · hors-ligne et sans compte.`;
  homeEl.innerHTML = TRAILS.filter((t) => t.bivouac).slice(0, 3).map(cardHTML).join("");
}

function renderAll() {
  renderList();
  renderGrid();
  renderHome();
  if (state.selectedId && getTrail(state.selectedId)) renderDetail(state.selectedId);
}

// ---------- Favoris ----------
const favCountEl = document.getElementById("fav-count");
const favBtnEl = document.getElementById("btn-favorites");

function toggleFavorite(id) {
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  localStorage.setItem("sr-favorites", JSON.stringify([...state.favorites]));
  renderAll();
  renderFavCount();
}

function renderFavCount() {
  favCountEl.textContent = state.favorites.size;
}

favBtnEl.addEventListener("click", () => {
  state.favoritesOnly = !state.favoritesOnly;
  favBtnEl.classList.toggle("active", state.favoritesOnly);
  switchTab("carte");
  renderList();
});

// ---------- Sélection d'un itinéraire ----------
function selectTrail(id, { pan = true, openDetail = true } = {}) {
  state.selectedId = id;
  const trail = getTrail(id);

  if (activeTrack) activeTrack.remove();
  activeTrack = L.polyline(trail.segments || trail.track, {
    color: "#ff2d20",
    weight: 4,
    opacity: 0.95,
  }).addTo(map);

  if (pan) map.fitBounds(activeTrack.getBounds(), { padding: [60, 60], maxZoom: 14 });

  renderList();
  if (openDetail) renderDetail(id);
}

// ---------- Altitudes réelles (API Open-Meteo Elevation) ----------
async function ensureElevation(trail) {
  if (trail.eles?.length > 1) return trail.eles;
  if (state.elev[trail.id]) return state.elev[trail.id].eles;
  // Profil calculé sur le fil principal du tracé (chaîné), pas sur les segments épars
  const pts = sampleTrack(trail.mainline || trackOf(trail));
  const url =
    `https://api.open-meteo.com/v1/elevation` +
    `?latitude=${pts.map((p) => p[0].toFixed(5)).join(",")}` +
    `&longitude=${pts.map((p) => p[1].toFixed(5)).join(",")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Elevation ${res.status}`);
  const eles = (await res.json()).elevation;

  // D+ avec seuil de 4 m pour lisser le bruit du modèle de terrain
  let gain = 0;
  let ref = eles[0];
  for (const e of eles) {
    if (e - ref > 4) { gain += e - ref; ref = e; }
    else if (ref - e > 4) ref = e;
  }
  state.elev[trail.id] = { eles, gain: Math.round(gain), max: Math.round(Math.max(...eles)) };
  localStorage.setItem("sr-elev", JSON.stringify(state.elev));
  return eles;
}

// ---------- Profil d'altitude ----------
function profileSVGFromValues(values, W = 640, H = 150) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 6;
  const coords = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (W - pad * 2);
    const y = H - pad - ((v - min) / span) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `
    <svg class="elevation-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Profil d'altitude">
      <polygon points="${pad},${H - pad} ${coords.join(" ")} ${W - pad},${H - pad}"
        fill="rgba(45,106,47,0.25)" />
      <polyline points="${coords.join(" ")}" fill="none" stroke="var(--green-line, #2d6a2f)" stroke-width="2.5"
        stroke-linejoin="round" stroke-linecap="round" />
      <text x="${pad + 4}" y="15" font-size="12" font-weight="700" fill="var(--chart-text, #1e4a20)">${Math.round(max)} m</text>
      <text x="${pad + 4}" y="${H - 10}" font-size="12" font-weight="700" fill="var(--chart-text2, #5c6b5c)">${Math.round(min)} m</text>
    </svg>`;
}

// ---------- Météo (Open-Meteo) : 7 jours + heure par heure ----------
const WMO = [
  [[0], "☀️", "Ciel clair"],
  [[1, 2], "🌤", "Peu nuageux"],
  [[3], "☁️", "Couvert"],
  [[45, 48], "🌫", "Brouillard"],
  [[51, 53, 55, 56, 57], "🌦", "Bruine"],
  [[61, 63, 65, 66, 67], "🌧", "Pluie"],
  [[71, 73, 75, 77, 85, 86], "🌨", "Neige"],
  [[80, 81, 82], "🌧", "Averses"],
  [[95, 96, 99], "⛈", "Orage"],
];

function wmoInfo(code) {
  const found = WMO.find(([codes]) => codes.includes(code));
  return found ? { icon: found[1], label: found[2] } : { icon: "❓", label: "—" };
}

async function fetchWeather(trail) {
  if (weatherCache.has(trail.id)) return weatherCache.get(trail.id);
  const [lat, lon] = trail.center;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max` +
    `&hourly=temperature_2m,precipitation,cloud_cover,wind_speed_10m,weather_code` +
    `&timezone=auto&forecast_days=7`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const data = await res.json();
  weatherCache.set(trail.id, data);
  return data;
}

function renderHourly(el, data, dayIndex) {
  const rows = [];
  for (let h = 5; h <= 21; h++) {
    const i = dayIndex * 24 + h;
    const { icon } = wmoInfo(data.hourly.weather_code[i]);
    rows.push(`
      <div class="hour-row">
        <span class="hour-h">${String(h).padStart(2, "0")} h</span>
        <span class="hour-icon">${icon}</span>
        <span class="hour-t">${Math.round(data.hourly.temperature_2m[i])}°</span>
        <span class="hour-rain ${data.hourly.precipitation[i] >= 1 ? "warn" : ""}">💧 ${data.hourly.precipitation[i].toFixed(1)}</span>
        <span class="hour-cloud">☁️ ${data.hourly.cloud_cover[i]} %</span>
        <span class="hour-wind">💨 ${Math.round(data.hourly.wind_speed_10m[i])}</span>
      </div>`);
  }
  el.innerHTML = rows.join("");
}

function renderWeatherInto(el, data) {
  const daily = data.daily;
  const days = daily.time.map((iso, i) => {
    const d = new Date(iso);
    const { icon, label } = wmoInfo(daily.weather_code[i]);
    const rain = daily.precipitation_sum[i];
    return `
      <button class="weather-day ${rain >= 5 ? "weather-alert" : ""} ${i === 0 ? "active" : ""}" data-day="${i}">
        <div class="weather-date">${d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" })}</div>
        <div class="weather-icon" title="${label}">${icon}</div>
        <div class="weather-temp">${Math.round(daily.temperature_2m_max[i])}° <span>/ ${Math.round(daily.temperature_2m_min[i])}°</span></div>
        <div class="weather-rain">💧 ${rain.toFixed(1)} mm</div>
      </button>`;
  });
  el.innerHTML = `
    <div class="weather-row">${days.join("")}</div>
    <h3 class="section-title">Heure par heure — <span id="hourly-day-label">aujourd'hui</span></h3>
    <div id="hourly-rows"></div>
    <p class="muted">Prévisions Open-Meteo pour le point de départ (${el.dataset.spot}).
    Choisissez le jour prévu de votre trek. Indicatif au-delà de 48 h en montagne.</p>`;

  const hourlyEl = el.querySelector("#hourly-rows");
  renderHourly(hourlyEl, data, 0);
  el.querySelectorAll(".weather-day").forEach((btn) => {
    btn.addEventListener("click", () => {
      el.querySelectorAll(".weather-day").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const i = Number(btn.dataset.day);
      el.querySelector("#hourly-day-label").textContent = new Date(daily.time[i])
        .toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
      renderHourly(hourlyEl, data, i);
    });
  });
}

// ---------- Météo sur la route (trajet en voiture vers le départ) ----------
async function geocodeCity(name) {
  const res = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=fr`
  );
  if (!res.ok) throw new Error("géocodage indisponible");
  const r = (await res.json()).results?.[0];
  if (!r) throw new Error(`ville « ${name} » introuvable`);
  return { lat: r.latitude, lon: r.longitude, label: `${r.name}${r.admin1 ? ` (${r.admin1})` : ""}` };
}

async function routeWeather(trail, origin, departISO) {
  const dest = trackOf(trail)[0];
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${origin.lon},${origin.lat};${dest[1]},${dest[0]}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("calcul d'itinéraire indisponible");
  const route = (await res.json()).routes?.[0];
  if (!route) throw new Error("aucun itinéraire routier trouvé");

  const coords = route.geometry.coordinates; // [lon, lat]
  const N = 6;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const [lon, lat] = coords[Math.round((i * (coords.length - 1)) / (N - 1))];
    pts.push({ lat, lon, frac: i / (N - 1) });
  }

  const depart = new Date(departISO);
  const wres = await fetch(
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${pts.map((p) => p.lat.toFixed(3)).join(",")}` +
    `&longitude=${pts.map((p) => p.lon.toFixed(3)).join(",")}` +
    `&hourly=temperature_2m,precipitation,weather_code&timezone=auto&forecast_days=7`
  );
  if (!wres.ok) throw new Error("météo indisponible");
  let wdata = await wres.json();
  if (!Array.isArray(wdata)) wdata = [wdata];

  const steps = pts.map((p, i) => {
    const eta = new Date(depart.getTime() + p.frac * route.duration * 1000);
    const hourly = wdata[i].hourly;
    const idx = Math.max(0, Math.min(
      hourly.time.length - 1,
      Math.round((eta - new Date(hourly.time[0])) / 3600000)
    ));
    return {
      km: Math.round((p.frac * route.distance) / 1000),
      eta,
      temp: Math.round(hourly.temperature_2m[idx]),
      rain: hourly.precipitation[idx],
      ...wmoInfo(hourly.weather_code[idx]),
    };
  });
  return { steps, distKm: Math.round(route.distance / 1000), durMin: Math.round(route.duration / 60) };
}

function routeWeatherHTML(trail) {
  const tomorrow = new Date(Date.now() + 86400000);
  const defaultDate = `${tomorrow.toISOString().slice(0, 10)}T07:00`;
  return `
    <h3 class="section-title">Météo sur la route pour y aller</h3>
    <div class="route-form">
      <input id="route-origin" type="text" placeholder="Ville de départ (ex. Milan, Lyon…)" />
      <button class="btn" id="route-mypos" title="Partir de ma position">📍</button>
      <input id="route-depart" type="datetime-local" value="${defaultDate}" />
      <button class="btn btn-primary" id="route-go">Calculer</button>
    </div>
    <div id="route-result"></div>`;
}

function bindRouteWeather(trail, container) {
  const resultEl = container.querySelector("#route-result");
  let myPos = null;

  container.querySelector("#route-mypos").addEventListener("click", (e) => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        myPos = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: "Ma position" };
        container.querySelector("#route-origin").value = "📍 Ma position";
        e.target.classList.add("faved");
      },
      (err) => (resultEl.innerHTML = `<p class="muted">Position indisponible : ${err.message}</p>`)
    );
  });

  container.querySelector("#route-origin").addEventListener("input", () => {
    myPos = null;
    container.querySelector("#route-mypos").classList.remove("faved");
  });

  container.querySelector("#route-go").addEventListener("click", async (e) => {
    const btn = e.target;
    const originText = container.querySelector("#route-origin").value.trim();
    const departISO = container.querySelector("#route-depart").value;
    if (!myPos && !originText) {
      resultEl.innerHTML = `<p class="muted">Indiquez une ville de départ ou utilisez 📍.</p>`;
      return;
    }
    if (new Date(departISO) - Date.now() > 6.5 * 86400000) {
      resultEl.innerHTML = `<p class="muted">Prévisions limitées à 7 jours — choisissez un départ plus proche.</p>`;
      return;
    }
    btn.disabled = true;
    btn.textContent = "⏳";
    try {
      const origin = myPos || (await geocodeCity(originText));
      const { steps, distKm, durMin } = await routeWeather(trail, origin, departISO);
      const rows = steps.map((s, i) => `
        <div class="route-step">
          <span class="route-km">${i === 0 ? "Départ" : i === steps.length - 1 ? "Arrivée" : `km ${s.km}`}</span>
          <span class="route-eta">${s.eta.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
          <span class="route-ico" title="${s.label}">${s.icon}</span>
          <span class="route-t">${s.temp}°</span>
          <span class="route-rain ${s.rain >= 0.5 ? "warn" : ""}">💧 ${s.rain.toFixed(1)} mm</span>
        </div>`).join("");
      resultEl.innerHTML = `
        <p class="route-summary">🚗 ${origin.label} → ${trail.location} :
        <strong>${distKm} km · ${Math.floor(durMin / 60)} h ${String(durMin % 60).padStart(2, "0")}</strong></p>
        ${rows}
        <p class="muted">Conditions prévues à l'heure de passage estimée à chaque point du trajet (OSRM + Open-Meteo).</p>`;
    } catch (err) {
      resultEl.innerHTML = `<p class="muted">Impossible : ${err.message}.</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Calculer";
    }
  });
}

// ---------- GPX : export ----------
// Pleine résolution, un <trkseg> par tronçon : pas de lignes droites entre
// segments disjoints, pas de sous-échantillonnage.
function trailToGPX(trail) {
  const segs = trail.segments || [trail.track];
  // Altitudes incluses seulement si relevées point par point (GPX importés)
  const eles = trail.eles && trail.eles.length === trackOf(trail).length ? trail.eles : null;
  let k = 0;
  const segXml = segs
    .map(
      (seg) =>
        "    <trkseg>\n" +
        seg
          .map(([lat, lon]) => {
            const e = eles ? `<ele>${Math.round(eles[k++])}</ele>` : "";
            return `      <trkpt lat="${lat}" lon="${lon}">${e}</trkpt>`;
          })
          .join("\n") +
        "\n    </trkseg>"
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Sancho Rossi" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${trail.name}</name></metadata>
  <trk>
    <name>${trail.name}</name>
${segXml}
  </trk>
</gpx>`;
}

function downloadGPX(trail) {
  const blob = new Blob([trailToGPX(trail)], { type: "application/gpx+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${trail.id}.gpx`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- GPX : import ----------
function parseGPX(xmlText, fileName) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("XML invalide");
  let pts = [...doc.querySelectorAll("trkpt")];
  if (!pts.length) pts = [...doc.querySelectorAll("rtept")];
  if (pts.length < 2) throw new Error("aucun point de trace (trkpt/rtept)");

  const track = pts.map((p) => [parseFloat(p.getAttribute("lat")), parseFloat(p.getAttribute("lon"))]);
  const eles = pts.map((p) => parseFloat(p.querySelector("ele")?.textContent)).filter((v) => !isNaN(v));

  let dPlus = 0;
  for (let i = 1; i < eles.length; i++) {
    const diff = eles[i] - eles[i - 1];
    if (diff > 0) dPlus += diff;
  }

  const name =
    doc.querySelector("trk > name")?.textContent.trim() ||
    doc.querySelector("metadata > name")?.textContent.trim() ||
    fileName.replace(/\.gpx$/i, "");

  return {
    id: `gpx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    imported: true,
    name,
    location: "Tracé GPX personnel",
    region: "Mes GPX",
    difficulty: "importé",
    type: "importé",
    days: null,
    bivouac: false,
    distance: Math.round(trackDistanceKm(track) * 10) / 10,
    elevationGain: Math.round(dPlus),
    altMax: eles.length ? Math.round(Math.max(...eles)) : null,
    duration: "—",
    center: track[Math.floor(track.length / 2)],
    gradient: "linear-gradient(135deg, #2d6a2f, #71b280)",
    description: `Fichier « ${fileName} » importé le ${new Date().toLocaleDateString("fr-FR")} — ${track.length} points de trace.`,
    eau: "—",
    bivouacSpot: "—",
    periode: "—",
    track,
    eles,
  };
}

const gpxInput = document.getElementById("gpx-file-input");
document.getElementById("btn-import-gpx").addEventListener("click", () => gpxInput.click());

gpxInput.addEventListener("change", async () => {
  const errors = [];
  let lastId = null;
  for (const file of gpxInput.files) {
    try {
      const trail = parseGPX(await file.text(), file.name);
      state.imported.unshift(trail);
      addMarker(trail);
      lastId = trail.id;
    } catch (err) {
      errors.push(`${file.name} : ${err.message}`);
    }
  }
  gpxInput.value = "";
  localStorage.setItem("sr-gpx", JSON.stringify(state.imported));
  renderAll();
  if (lastId) {
    switchTab("carte");
    selectTrail(lastId);
  }
  if (errors.length) alert("Import impossible —\n" + errors.join("\n"));
});

function deleteImported(id) {
  state.imported = state.imported.filter((t) => t.id !== id);
  localStorage.setItem("sr-gpx", JSON.stringify(state.imported));
  markers.get(id)?.remove();
  markers.delete(id);
  state.favorites.delete(id);
  localStorage.setItem("sr-favorites", JSON.stringify([...state.favorites]));
  closeDetail();
  renderAll();
  renderFavCount();
}

// ---------- Sentiers OSM à la volée (API Overpass) ----------
const osmBtn = document.getElementById("btn-osm-search");
const osmResultsEl = document.getElementById("osm-results");
let osmLayer = null;

osmBtn.addEventListener("click", async () => {
  if (map.getZoom() < 10) {
    alert("Zoomez davantage (une vallée ou un massif) avant de chercher les sentiers.");
    return;
  }
  const b = map.getBounds();
  const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
  const query = `[out:json][timeout:25];relation["route"="hiking"](${bbox});out geom 40;`;

  osmBtn.disabled = true;
  osmBtn.textContent = "⏳";
  try {
    const data = await overpassFetch(query);
    showOsmResults(data.elements || []);
  } catch (err) {
    alert(`Recherche impossible (${err.message}). Réessayez dans quelques secondes.`);
  } finally {
    osmBtn.disabled = false;
    osmBtn.textContent = "🔎";
  }
});

function showOsmResults(relations) {
  if (osmLayer) osmLayer.remove();
  const known = new Set(CATALOG.map((t) => t.id));
  state.osmLive = relations
    .map((rel) => {
      if (known.has(`osmc-${rel.id}`)) return null;
      const segments = (rel.members || [])
        .filter((m) => m.type === "way" && m.geometry)
        .map((m) => m.geometry.map((g) => [g.lat, g.lon]));
      const track = segments.flat();
      if (track.length < 2) return null;
      const tags = rel.tags || {};
      const parts = [tags.from && `de ${tags.from}`, tags.to && `à ${tags.to}`].filter(Boolean).join(" ");
      return normalizeOsmTrail({
        id: `osm-${rel.id}`,
        osm: true,
        name: tags.name || tags.ref || `Sentier OSM ${rel.id}`,
        location: parts || "Itinéraire balisé OpenStreetMap",
        region: "Sentiers OSM",
        difficulty: tags.sac_scale ? tags.sac_scale.replace(/_/g, " ") : "non renseignée",
        type: "balisé",
        days: null,
        bivouac: false,
        distance: Math.round(trackDistanceKm(track) * 10) / 10,
        elevationGain: null,
        altMax: null,
        duration: "—",
        center: track[Math.floor(track.length / 2)],
        gradient: "linear-gradient(135deg, #4a5d8a, #8fa3cc)",
        description:
          `Itinéraire balisé issu d'OpenStreetMap${tags.ref ? ` (réf. ${tags.ref})` : ""}` +
          `${tags.network ? `, réseau ${tags.network}` : ""}. Tracé réel relevé par la communauté — exportable en GPX.`,
        eau: "—",
        bivouacSpot: "—",
        periode: "—",
        track,
        segments,
      });
    })
    .filter(Boolean)
    .sort((a, b) => b.distance - a.distance);

  osmLayer = L.layerGroup(
    state.osmLive.map((t) =>
      L.polyline(t.segments, { color: "#7b4bb7", weight: 3, opacity: 0.7 })
        .on("click", () => selectTrail(t.id, { pan: false }))
    )
  ).addTo(map);

  osmResultsEl.innerHTML = state.osmLive.length
    ? `<div class="osm-head">🟣 ${state.osmLive.length} sentier${state.osmLive.length > 1 ? "s" : ""} supplémentaire${state.osmLive.length > 1 ? "s" : ""} dans la zone
         <button id="osm-clear" title="Effacer">✕</button></div>` +
      state.osmLive
        .map(
          (t) => `
        <button class="osm-item" data-id="${t.id}">
          <strong>${t.name}</strong>
          <span>${t.distance} km</span>
        </button>`
        )
        .join("")
    : `<div class="osm-head">Aucun sentier supplémentaire trouvé (les balisés officiels sont déjà dans le catalogue).</div>`;

  osmResultsEl.querySelectorAll(".osm-item").forEach((el) =>
    el.addEventListener("click", () => selectTrail(el.dataset.id))
  );
  osmResultsEl.querySelector("#osm-clear")?.addEventListener("click", () => {
    state.osmLive = [];
    osmLayer?.remove();
    osmResultsEl.innerHTML = "";
  });
}

// ---------- Agent local (Accueil) ----------
const AGENT_REGIONS = {
  dolomites: "Dolomites", aoste: "Val d'Aoste", aosta: "Val d'Aoste",
  lombardie: "Lombardie", piémont: "Piémont", piemont: "Piémont",
  trentin: "Trentin", garde: "Lac de Garde", garda: "Lac de Garde",
};

function agentAnswer(query) {
  const q = query.toLowerCase();
  const wants = {
    bivouac: /bivouac|2 jours|deux jours|nuit|week/.test(q),
    day: /1 jour|journée|demi/.test(q) && !/2 jours/.test(q),
    facile: /facile|tranquille|famille|débutant|pas trop dur|simple/.test(q),
    difficile: /difficile|dur|engagé|alpin|sportif|grosse/.test(q),
    lac: /lac|lago|baignade/.test(q),
    sauvage: /sauvage|isolé|seul|tranquillité|désert/.test(q),
    denivele: /dénivelé|d\+|grimpe/.test(q),
    region: Object.keys(AGENT_REGIONS).find((k) => q.includes(k)),
  };

  const scored = [...TRAILS, ...CATALOG].map((t) => {
    let score = 0;
    const reasons = [];
    if (wants.bivouac && t.bivouac) { score += 4; reasons.push("2 j · bivouac"); }
    if (wants.day && t.days === 1) { score += 4; reasons.push("à la journée"); }
    if (wants.facile) {
      if (t.difficulty === "facile") { score += 3; reasons.push("facile"); }
      else if (t.difficulty === "modéré") { score += 1.5; reasons.push("modéré"); }
      else if (t.difficulty === "difficile") score -= 2;
    }
    if (wants.difficile && t.difficulty === "difficile") { score += 3; reasons.push("engagé"); }
    if (wants.lac && /lac|lago|laghi/i.test(t.name + t.description)) { score += 3; reasons.push("lac"); }
    if (wants.sauvage && /sauvage|isolement|wilderness|à l'écart|fréquentation faible/i.test(t.description)) {
      score += 3; reasons.push("coin sauvage");
    }
    if (wants.denivele) score += (t.elevationGain || 0) / 800;
    if (wants.region && t.region === AGENT_REGIONS[wants.region]) { score += 4; reasons.push(t.region); }
    return { t, score, reasons };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (!scored.length) {
    return {
      text: "Je n'ai rien trouvé d'assez proche. Essayez avec une durée (« 2 jours »), une difficulté ou un massif (Dolomites, Piémont, Val d'Aoste…).",
      trails: [],
    };
  }
  const criteria = [
    wants.bivouac && "bivouac 2 jours", wants.day && "à la journée",
    wants.facile && "niveau accessible", wants.difficile && "engagé",
    wants.lac && "avec lac", wants.sauvage && "sauvage",
    wants.region && AGENT_REGIONS[wants.region],
  ].filter(Boolean).join(", ");
  return {
    text: `D'après vos critères (${criteria || "libres"}), voici mes ${scored.length} suggestions — la première coche ${scored[0].reasons.join(" + ") || "le plus de cases"} :`,
    trails: scored.map((x) => x.t),
  };
}

const agentInput = document.getElementById("agent-input");
const agentOutput = document.getElementById("agent-output");

function runAgent(q) {
  if (!q.trim()) return;
  const { text, trails } = agentAnswer(q);
  agentOutput.innerHTML =
    `<p class="agent-text">${text}</p>` +
    (trails.length ? `<div class="cards-grid">${trails.map(cardHTML).join("")}</div>` : "");
}

document.getElementById("agent-send").addEventListener("click", () => runAgent(agentInput.value));
agentInput.addEventListener("keydown", (e) => { if (e.key === "Enter") runAgent(agentInput.value); });
document.querySelectorAll(".agent-quick .chip").forEach((c) =>
  c.addEventListener("click", () => { agentInput.value = c.dataset.q; runAgent(c.dataset.q); })
);

// ---------- Fiche itinéraire (page plein écran, façon AllTrails) ----------
const detailPanel = document.getElementById("detail-panel");
const detailContent = document.getElementById("detail-content");
const breadcrumbEl = document.getElementById("detail-breadcrumb");
let miniMap = null;
let viewer3dActive = false;

function destroyMiniMap() {
  if (miniMap) { miniMap.remove(); miniMap = null; }
}

function renderDetail(id) {
  const t = getTrail(id);
  const faved = state.favorites.has(id);
  const gain = t.elevationGain ?? state.elev[id]?.gain;
  const amax = t.altMax ?? state.elev[id]?.max;
  // Entrée dans l'historique à l'ouverture : le bouton retour referme la fiche
  if (detailPanel.classList.contains("hidden")) history.pushState({ srDetail: true }, "");
  destroyMiniMap();
  window.SR3D?.dispose();
  viewer3dActive = false;

  breadcrumbEl.innerHTML =
    `<button class="bc-link" data-bc="all">Italie</button> / ` +
    `<button class="bc-link" data-bc="region">${t.region}</button> / <strong>${t.name}</strong>`;
  breadcrumbEl.querySelectorAll(".bc-link").forEach((b) =>
    b.addEventListener("click", () => {
      const region = b.dataset.bc === "region" ? t.region : "";
      state.region = region;
      document.getElementById("filter-region").value = region;
      switchTab("carte"); // referme la fiche et affiche la carte filtrée
      renderList();
    })
  );

  detailContent.innerHTML = `
    <h1 class="detail-title">${t.name}</h1>
    <div class="detail-subline">
      ${t.imported ? `<span class="pill pill-gpx">${t.custom ? "Circuit personnel" : "GPX importé"}</span>`
        : t.osm ? `<span class="pill pill-gpx">Tracé balisé officiel · OSM</span>`
        : `<span class="pill pill-${t.difficulty}">${t.difficulty}</span><span class="pill pill-warn">tracé indicatif</span>`}
      <span class="pill">${t.type}</span>
      ${t.bivouac ? `<span class="pill pill-bivouac">⛺ 2 jours · 1 nuit</span>` : ""}
      <span class="detail-location">📍 ${t.location}</span>
    </div>

    <div class="detail-media">
      <div class="detail-hero" style="${photoStyle(t)}"></div>
      <div class="detail-side">
        <div id="mini-map"></div>
        <div class="side-profile" id="side-profile">
          <p class="muted">Profil d'altitude réel — chargement…</p>
        </div>
      </div>
    </div>

    <div class="detail-statsbar">
      <div class="bigstat"><div class="bigstat-v">${t.distance}<small> km</small></div><div class="bigstat-l">Distance</div></div>
      <div class="bigstat"><div class="bigstat-v" id="stat-gain">${gain ? Math.round(gain).toLocaleString("fr-FR") + '<small> m</small>' : "…"}</div><div class="bigstat-l">Dénivelé positif</div></div>
      <div class="bigstat"><div class="bigstat-v" id="stat-amax">${amax ? Math.round(amax).toLocaleString("fr-FR") + '<small> m</small>' : "…"}</div><div class="bigstat-l">Altitude max</div></div>
      <div class="bigstat"><div class="bigstat-v">${t.duration}</div><div class="bigstat-l">Durée</div></div>
    </div>

    <div class="detail-actions">
      <button class="btn btn-primary" id="btn-follow">▶ Suivre ce tracé</button>
      <button class="btn ${faved ? "faved" : ""}" id="btn-detail-fav">${faved ? "♥ Enregistré" : "♡ Sauvegarder"}</button>
      <button class="btn" id="btn-itinerary">🧭 Voir sur la carte</button>
      <button class="btn" id="btn-gpx">⤓ GPX</button>
      <button class="btn" id="btn-safety">🛟 Partager</button>
      ${t.imported ? `<button class="btn btn-danger" id="btn-delete-gpx">🗑</button>` : ""}
    </div>

    <div class="tab-bar">
      <button class="tab active" data-tab="apercu">Aperçu</button>
      <button class="tab" data-tab="meteo">Météo</button>
      <button class="tab" data-tab="3d">Vue 3D</button>
    </div>

    <div class="tab-content" id="tab-apercu">
      ${t.eau !== "—" ? `
      <h3 class="section-title">Infos terrain</h3>
      <div class="terrain-list">
        <div class="terrain-item"><span class="terrain-icon">💧</span><div><strong>Eau</strong><br>${t.eau}</div></div>
        <div class="terrain-item"><span class="terrain-icon">⛺</span><div><strong>Bivouac</strong><br>${t.bivouacSpot}</div></div>
        <div class="terrain-item"><span class="terrain-icon">🗓</span><div><strong>Période conseillée</strong><br>${t.periode}</div></div>
      </div>` : ""}
      <h3 class="section-title">Description</h3>
      <p class="detail-description">${t.description}</p>
      ${!t.osm && !t.imported ? `
      <h3 class="section-title">Tracés GPX officiels du secteur</h3>
      <p class="muted">Le tracé de cette fiche est indicatif. Pour naviguer sur le terrain,
      utilisez ces itinéraires balisés à géométrie réelle :</p>
      <div id="nearby-official" class="nearby-list"></div>` : ""}
      <h3 class="section-title">Mes notes</h3>
      <textarea id="trail-notes" class="notes-area" rows="4"
        placeholder="Repérages, variantes, matériel, horaires de bus… (sauvegarde automatique)">${state.notes[id] || ""}</textarea>
      <div class="notes-status" id="notes-status"></div>
    </div>

    <div class="tab-content hidden" id="tab-meteo" data-spot="${t.location}">
      <p class="muted">Chargement des prévisions…</p>
    </div>

    <div class="tab-content hidden" id="tab-3d">
      <div class="viewer3d-intro">
        <p class="muted">Relief réel drapé d'imagerie satellite. Molette pour zoomer, glisser pour orbiter,
        puis déplacez le curseur pour suivre un point le long du tracé.</p>
        <button class="btn btn-primary" id="btn-load-3d">▶ Charger la vue 3D</button>
      </div>
      <div id="viewer3d" class="viewer3d hidden"></div>
      <div id="progress-row" class="progress-row hidden">
        <span class="progress-label">Position sur le tracé</span>
        <input type="range" id="track-progress" min="0" max="1000" value="0" />
        <span id="progress-info" class="progress-info">départ</span>
      </div>
    </div>`;

  detailPanel.classList.remove("hidden");
  detailPanel.scrollTop = 0;

  // Mini-carte
  miniMap = L.map("mini-map", {
    zoomControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, attributionControl: false,
  });
  L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17 }).addTo(miniMap);
  const line = L.polyline(t.segments || t.track, { color: "#ff2d20", weight: 4 }).addTo(miniMap);
  miniMap.fitBounds(line.getBounds(), { padding: [18, 18] });

  // Profil réel
  ensureElevation(t)
    .then((eles) => {
      document.getElementById("side-profile").innerHTML = profileSVGFromValues(eles);
      const e = state.elev[id];
      if (e) {
        document.getElementById("stat-gain").innerHTML = `${e.gain.toLocaleString("fr-FR")}<small> m</small>`;
        document.getElementById("stat-amax").innerHTML = `${e.max.toLocaleString("fr-FR")}<small> m</small>`;
      }
    })
    .catch(() => {
      document.getElementById("side-profile").innerHTML =
        `<p class="muted">Profil indisponible hors connexion.</p>`;
      document.getElementById("stat-gain").textContent = gain ? Math.round(gain) : "—";
      document.getElementById("stat-amax").textContent = amax ? Math.round(amax) : "—";
    });

  // Tracés officiels proches (fiches de la sélection bivouac uniquement)
  const nearbyEl = document.getElementById("nearby-official");
  if (nearbyEl) {
    const near = CATALOG
      .map((c) => ({ c, d: haversineKm(c.center, t.center) }))
      .filter((x) => x.d < 12)
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);
    nearbyEl.innerHTML = near.length
      ? near
          .map(
            (x) => `
        <button class="osm-item" data-id="${x.c.id}">
          <strong>${x.c.name}</strong>
          <span>${x.c.distance} km · à ${x.d.toFixed(1)} km</span>
        </button>`
          )
          .join("")
      : `<p class="muted">Aucun tracé officiel du catalogue à moins de 12 km —
         utilisez « 🔎 Sentiers de la zone » sur la carte.</p>`;
    nearbyEl.querySelectorAll(".osm-item").forEach((el) =>
      el.addEventListener("click", () => { renderDetail(el.dataset.id); state.selectedId = el.dataset.id; })
    );
  }

  // Photo réelle du lieu pour les itinéraires du catalogue (article Wikipédia le plus proche)
  if (t.osm && state.photos[t.id] === undefined) {
    geoPhoto(t)
      .then((url) => {
        state.photos[t.id] = url;
        localStorage.setItem("sr-photos", JSON.stringify(state.photos));
        if (url && state.selectedId === id) {
          document.querySelector(".detail-hero").style.cssText = photoStyle(t);
          updateCardPhotos(t);
        }
      })
      .catch(() => {});
  }

  document.getElementById("btn-detail-fav").addEventListener("click", () => toggleFavorite(id));
  document.getElementById("btn-gpx").addEventListener("click", () => downloadGPX(t));
  document.getElementById("btn-itinerary").addEventListener("click", () => {
    switchTab("carte");
    // Sur la carte uniquement : la fiche ne doit pas se rouvrir par-dessus
    setTimeout(() => selectTrail(id, { openDetail: false }), 100);
  });
  document.getElementById("btn-follow").addEventListener("click", () => startNavigation(id));
  document.getElementById("btn-safety").addEventListener("click", () => {
    closeDetail();
    switchTab("securite");
    const sel = document.getElementById("plan-trail");
    sel.value = id;
    sel.dispatchEvent(new Event("change"));
  });
  document.getElementById("btn-delete-gpx")?.addEventListener("click", () => {
    if (confirm(`Supprimer « ${t.name} » ?`)) deleteImported(id);
  });

  const tabs = detailContent.querySelectorAll(".tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((x) => x.classList.remove("active"));
      tab.classList.add("active");
      detailContent.querySelectorAll(".tab-content").forEach((c) => c.classList.add("hidden"));
      const target = document.getElementById(`tab-${tab.dataset.tab}`);
      target.classList.remove("hidden");
      if (tab.dataset.tab === "meteo") loadWeatherTab(t, target);
    });
  });

  document.getElementById("btn-load-3d").addEventListener("click", () => load3D(t));

  const notesEl = document.getElementById("trail-notes");
  const statusEl = document.getElementById("notes-status");
  let noteTimer;
  notesEl.addEventListener("input", () => {
    clearTimeout(noteTimer);
    statusEl.textContent = "…";
    noteTimer = setTimeout(() => {
      saveNote(id, notesEl.value);
      statusEl.textContent = "✓ Enregistré";
      setTimeout(() => (statusEl.textContent = ""), 1600);
    }, 500);
  });
}

async function load3D(trail) {
  const intro = document.querySelector(".viewer3d-intro");
  const container = document.getElementById("viewer3d");
  intro.querySelector("#btn-load-3d").textContent = "⏳ Chargement du relief…";
  try {
    const eles = await ensureElevation(trail).catch(() => null);
    // import() dans un script classique : résolu par rapport à l'URL de app.js (dossier js/)
    const mod = await import("./viewer3d.js");
    container.classList.remove("hidden");
    await mod.open(container, trail, sampleTrack(trail.mainline || trackOf(trail), 300), eles);
    window.SR3D = mod;
    viewer3dActive = true;
    intro.classList.add("hidden");

    // Jauge : suit un point le long du tracé dans la vue 3D
    const row = document.getElementById("progress-row");
    const slider = document.getElementById("track-progress");
    const info = document.getElementById("progress-info");
    row.classList.remove("hidden");
    slider.value = 0;
    const update = () => {
      const r = mod.setProgress(Number(slider.value) / 1000);
      if (r) info.textContent = `${r.km.toFixed(1)} km · ${Math.round(r.alt)} m`;
    };
    slider.addEventListener("input", update);
    update();
  } catch (err) {
    intro.querySelector("#btn-load-3d").textContent = "▶ Réessayer";
    alert(`Vue 3D indisponible : ${err.message}`);
  }
}

async function loadWeatherTab(trail, el) {
  try {
    const data = await fetchWeather(trail);
    renderWeatherInto(el, data);
    el.insertAdjacentHTML("beforeend", routeWeatherHTML(trail));
    bindRouteWeather(trail, el);
  } catch (err) {
    el.innerHTML = `<p class="muted">Prévisions indisponibles (${err.message}). Vérifiez la connexion internet.</p>`;
  }
}

function closeDetail(fromPopstate = false) {
  if (detailPanel.classList.contains("hidden")) return;
  detailPanel.classList.add("hidden");
  destroyMiniMap();
  window.SR3D?.dispose();
  hidePreview();
  state.selectedId = null;
  if (activeTrack) activeTrack.remove();
  renderList();
  if (!fromPopstate && history.state?.srDetail) history.back();
}

document.getElementById("detail-close").addEventListener("click", closeDetail);

// ---------- Créateur de parcours : dessin libre snappé + tracés existants ----------
const builder = {
  active: false,
  mode: "draw",
  steps: [],          // {kind:'trail'|'leg', name, distance, track, segments?, eles?}
  waypoints: [],      // points cliqués en dessin libre
  routing: false,
  targetKm: null,
  layer: L.layerGroup(),
};

const builderBar = document.getElementById("builder-bar");
const builderBtn = document.getElementById("btn-builder");

function builderRender() {
  const stepsEl = document.getElementById("builder-steps");
  stepsEl.innerHTML = builder.steps.length
    ? builder.steps
        .map(
          (s, i) => `
      <span class="builder-step">${i + 1}. ${s.name} <em>${s.distance.toFixed(1)} km</em>
        <button data-rm-step="${i}" title="Retirer">✕</button></span>`
        )
        .join("")
    : `<span class="muted">${builder.mode === "draw"
        ? "Cliquez sur la carte pour poser le premier point."
        : "Cliquez un marqueur pour ajouter son tracé."}</span>`;
  const total = builder.steps.reduce((a, s) => a + s.distance, 0);
  document.getElementById("builder-stats").textContent =
    `${total.toFixed(1)} km · ${builder.steps.length} étape${builder.steps.length > 1 ? "s" : ""}` +
    (builder.routing ? " · ⏳ routage…" : "");
  const targetEl = document.getElementById("builder-target-info");
  if (builder.targetKm) {
    const ratio = total / builder.targetKm;
    targetEl.textContent = `${total.toFixed(1)} / ${builder.targetKm} km`;
    targetEl.className = "builder-target-info " +
      (ratio > 1.1 ? "over" : ratio > 0.85 ? "near" : "");
  } else {
    targetEl.textContent = "";
  }
  stepsEl.querySelectorAll("[data-rm-step]").forEach((b) =>
    b.addEventListener("click", () => {
      builder.steps.splice(Number(b.dataset.rmStep), 1);
      builderRedraw();
    })
  );
}

function builderRedraw() {
  builder.layer.clearLayers();
  builder.steps.forEach((s) =>
    builder.layer.addLayer(
      L.polyline(s.segments || [s.track], { color: "#ffd23e", weight: 4, opacity: 0.9 })
    )
  );
  builder.waypoints.forEach((ll) =>
    builder.layer.addLayer(
      L.circleMarker(ll, { radius: 5, color: "#0b0b0c", weight: 2, fillColor: "#ffd23e", fillOpacity: 1 })
    )
  );
  builderRender();
}

function builderAdd(trail) {
  builder.steps.push({
    kind: "trail",
    name: trail.name,
    distance: trail.distance,
    segments: trail.segments,
    track: trackOf(trail),
  });
  builderRedraw();
}

// Dessin libre : chaque point est relié au précédent en suivant les sentiers (BRouter)
async function builderAddPoint(latlng) {
  builder.waypoints.push(latlng);
  builderRedraw();
  if (builder.waypoints.length < 2 || builder.routing) return;
  const a = builder.waypoints[builder.waypoints.length - 2];
  const b = builder.waypoints[builder.waypoints.length - 1];
  builder.routing = true;
  builderRender();
  let track;
  let eles = null;
  let dist;
  try {
    const res = await fetch(
      `https://brouter.de/brouter?lonlats=${a.lng.toFixed(6)},${a.lat.toFixed(6)}|` +
      `${b.lng.toFixed(6)},${b.lat.toFixed(6)}&profile=hiking-mountain&alternativeidx=0&format=geojson`,
      { signal: AbortSignal.timeout(20000) }
    );
    if (!res.ok) throw new Error();
    const feat = (await res.json()).features[0];
    track = feat.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    eles = feat.geometry.coordinates.map((c) => c[2]).filter((v) => v != null);
    dist = Number(feat.properties["track-length"]) / 1000;
    if (eles.length !== track.length) eles = null;
  } catch {
    // Routage indisponible : segment en ligne droite (signalé dans le nom)
    track = [[a.lat, a.lng], [b.lat, b.lng]];
    dist = haversineKm(track[0], track[1]);
  }
  builder.routing = false;
  builder.steps.push({
    kind: "leg",
    name: eles ? `Tronçon ${builder.steps.length + 1}` : `Tronçon ${builder.steps.length + 1} (direct)`,
    distance: Math.round(dist * 100) / 100,
    track,
    eles,
  });
  builderRedraw();
}

function builderUndo() {
  if (builder.mode === "draw") {
    if (builder.waypoints.length > builder.steps.filter((s) => s.kind === "leg").length) {
      builder.waypoints.pop(); // point isolé sans tronçon
    } else if (builder.steps.length) {
      builder.steps.pop();
      builder.waypoints.pop();
    }
  } else {
    builder.steps.pop();
  }
  builderRedraw();
}

function builderExit() {
  builder.active = false;
  builder.steps = [];
  builder.waypoints = [];
  builder.routing = false;
  builder.layer.clearLayers();
  builder.layer.remove();
  builderBar.classList.add("hidden");
  builderBtn.classList.remove("active");
}

document.getElementById("builder-undo").addEventListener("click", builderUndo);

document.getElementById("builder-target").addEventListener("input", (e) => {
  builder.targetKm = e.target.value ? Number(e.target.value) : null;
  builderRender();
});

document.querySelectorAll("#builder-mode .chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    document.querySelectorAll("#builder-mode .chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    builder.mode = chip.dataset.bmode;
    document.getElementById("builder-hint").textContent =
      builder.mode === "draw"
        ? "Cliquez sur la carte : chaque point est relié au précédent en suivant les sentiers connus. Activez les couches 💧🏠 pour passer par des points d'intérêt (cliquez-les pour les ajouter)."
        : "Cliquez les marqueurs des tracés existants à enchaîner, dans l'ordre.";
    builderRender();
  })
);

builderBtn.addEventListener("click", () => {
  if (builder.active) { builderExit(); return; }
  closeDetail();
  builder.active = true;
  builder.layer.addTo(map);
  builderBar.classList.remove("hidden");
  builderBtn.classList.add("active");
  builderRender();
});

document.getElementById("builder-cancel").addEventListener("click", builderExit);

document.getElementById("builder-save").addEventListener("click", () => {
  if (!builder.steps.length) { alert("Ajoutez au moins un tracé au circuit."); return; }
  const name = prompt(
    "Nom du circuit :",
    `Circuit ${new Date().toLocaleDateString("fr-FR")}`
  );
  if (!name) return;
  const segments = builder.steps.flatMap((s) => s.segments || [s.track]);
  const track = segments.flat();
  const distance = Math.round(builder.steps.reduce((a, s) => a + s.distance, 0) * 10) / 10;
  // Altitudes réelles si le parcours est entièrement dessiné (BRouter les fournit)
  const legEles = builder.steps.every((s) => s.kind === "leg" && s.eles)
    ? builder.steps.flatMap((s) => s.eles)
    : null;
  const eles = legEles && legEles.length === track.length ? legEles : undefined;
  const hours = distance / 3.5;
  const trail = {
    id: `custom-${Date.now()}`,
    imported: true,
    custom: true,
    eles,
    name,
    location: "Circuit personnel",
    region: "Mes circuits",
    difficulty: "personnalisé",
    type: "circuit",
    days: null,
    bivouac: false,
    distance,
    elevationGain: null,
    altMax: null,
    duration: hours < 9 ? `${Math.floor(hours)} h ${String(Math.round((hours % 1) * 60)).padStart(2, "0")}` : `${Math.round(hours / 7)} j (est.)`,
    center: track[Math.floor(track.length / 2)],
    gradient: "linear-gradient(135deg, #3a3a40, #6a6a72)",
    description:
      `Circuit composé le ${new Date().toLocaleDateString("fr-FR")} à partir de : ` +
      builder.steps.map((s) => s.name).join(" → ") + ".",
    eau: "—",
    bivouacSpot: "—",
    periode: "—",
    track,
    segments,
  };
  state.imported.unshift(trail);
  localStorage.setItem("sr-gpx", JSON.stringify(state.imported));
  addMarker(trail);
  builderExit();
  renderAll();
  selectTrail(trail.id);
});

// ---------- Navigation : suivi du tracé en temps réel ----------
const nav = {
  active: false,
  survivor: false,
  trail: null,
  watchId: null,
  samples: null,
  cum: null,        // distances cumulées (km) le long des échantillons
  total: 0,
  lastUi: 0,
  marker: null,
  lastPan: 0,
  wakeLock: null,
};

async function requestWakeLock() {
  try {
    nav.wakeLock = await navigator.wakeLock?.request("screen");
  } catch { /* refusé ou non supporté : sans gravité */ }
}

function releaseWakeLock() {
  nav.wakeLock?.release().catch(() => {});
  nav.wakeLock = null;
}

function bearingDeg([lat1, lon1], [lat2, lon2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];

function navMetrics(lat, lon) {
  let best = 0;
  let bestD = Infinity;
  nav.samples.forEach((p, i) => {
    const d = haversineKm([lat, lon], p);
    if (d < bestD) { bestD = d; best = i; }
  });
  const next = nav.samples[Math.min(best + 3, nav.samples.length - 1)];
  return {
    done: nav.cum[best],
    remaining: nav.total - nav.cum[best],
    offM: Math.round(bestD * 1000),
    heading: bearingDeg([lat, lon], next),
  };
}

function startNavigation(id) {
  if (!navigator.geolocation) { alert("Géolocalisation non supportée sur cet appareil."); return; }
  stopNavigation();
  const t = getTrail(id);
  nav.trail = t;
  nav.active = true;

  const line = t.mainline || trackOf(t);
  nav.samples = sampleTrack(line, 400);
  nav.cum = [0];
  for (let i = 1; i < nav.samples.length; i++) {
    nav.cum.push(nav.cum[i - 1] + haversineKm(nav.samples[i - 1], nav.samples[i]));
  }
  nav.total = nav.cum[nav.cum.length - 1];

  switchTab("carte");
  setTimeout(() => selectTrail(id, { openDetail: false }), 80);
  document.body.classList.add("nav-active");
  document.getElementById("nav-hud").classList.remove("hidden");
  document.getElementById("nav-title").textContent = t.name;
  document.getElementById("surv-title").textContent = t.name;

  nav.watchId = navigator.geolocation.watchPosition(onNavFix, (err) => {
    document.getElementById("nav-offtrack").classList.remove("hidden");
    document.getElementById("nav-offdist").textContent = `GPS : ${err.message}`;
  }, { enableHighAccuracy: true, maximumAge: 5000 });
  requestWakeLock();
}

function onNavFix(pos) {
  savePos(pos); // alimente la dernière position connue (volet Sécurité)
  const throttle = nav.survivor ? 20000 : 2500; // Survivor : écran rafraîchi toutes les 20 s
  const now = Date.now();
  if (now - nav.lastUi < throttle) return;
  nav.lastUi = now;

  const { latitude: lat, longitude: lon, altitude, speed } = pos.coords;
  const m = navMetrics(lat, lon);
  const altText = altitude != null ? `${Math.round(altitude)} m` : "—";

  if (nav.survivor) {
    document.getElementById("surv-remaining").textContent = m.remaining.toFixed(1);
    document.getElementById("surv-alt").textContent = altText;
    document.getElementById("surv-heading").textContent =
      `${COMPASS[Math.round(m.heading / 45) % 8]} ${Math.round(m.heading)}°`;
    document.getElementById("surv-time").textContent =
      new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    document.getElementById("surv-off").classList.toggle("hidden", m.offM <= 120);
    return;
  }

  document.getElementById("nav-remaining").textContent = m.remaining.toFixed(1);
  document.getElementById("nav-done").textContent = m.done.toFixed(1);
  document.getElementById("nav-alt").textContent = altText;
  document.getElementById("nav-speed").textContent =
    speed != null ? (speed * 3.6).toFixed(1) : "—";
  const off = m.offM > 120;
  document.getElementById("nav-offtrack").classList.toggle("hidden", !off);
  if (off) document.getElementById("nav-offdist").textContent = m.offM;

  if (!nav.marker) {
    nav.marker = L.circleMarker([lat, lon], {
      radius: 9, color: "#fff", weight: 2.5, fillColor: "#ff2d20", fillOpacity: 1,
    }).addTo(map);
  } else {
    nav.marker.setLatLng([lat, lon]);
  }
  if (now - nav.lastPan > 4000) {
    map.panTo([lat, lon]);
    nav.lastPan = now;
  }
}

function setSurvivor(on) {
  nav.survivor = on;
  document.getElementById("nav-survivor").classList.toggle("hidden", !on);
  document.body.classList.toggle("survivor-active", on);
  if (on) {
    releaseWakeLock(); // écran libre de se mettre en veille : conso minimale
  } else {
    requestWakeLock();
    setTimeout(() => map.invalidateSize(), 60);
  }
}

function stopNavigation() {
  if (nav.watchId !== null) navigator.geolocation.clearWatch(nav.watchId);
  nav.watchId = null;
  nav.active = false;
  nav.marker?.remove();
  nav.marker = null;
  releaseWakeLock();
  setSurvivor(false);
  document.body.classList.remove("nav-active");
  document.getElementById("nav-hud").classList.add("hidden");
}

document.getElementById("nav-stop").addEventListener("click", stopNavigation);
document.getElementById("surv-stop").addEventListener("click", stopNavigation);
document.getElementById("nav-mode").addEventListener("click", () => setSurvivor(true));
document.getElementById("surv-advanced").addEventListener("click", () => setSurvivor(false));

// ---------- Veille automatique : alerte si aucune activité après l'heure prévue ----------
let watchTopic = localStorage.getItem("sr-topic");
if (!watchTopic) {
  watchTopic = "sancho-" + Math.random().toString(36).slice(2, 10);
  localStorage.setItem("sr-topic", watchTopic);
}
let watch = JSON.parse(localStorage.getItem("sr-watch") || "null");

const ALERT_DELAY_H = 5;    // alerte 5 h après l'heure de retour prévue
const PREWARN_MIN = 30;     // pré-alerte adressée à l'utilisateur 30 min avant

// Toute interaction ou position GPS compte comme signe de vie
let lastActThrottle = 0;
function markActivity() {
  const now = Date.now();
  if (now - lastActThrottle < 30000) return;
  lastActThrottle = now;
  localStorage.setItem("sr-lastact", String(now));
}
["pointerdown", "keydown", "touchstart"].forEach((evt) =>
  document.addEventListener(evt, markActivity, { capture: true, passive: true })
);

function ntfyPush(title, body, priority = "default") {
  return fetch(`https://ntfy.sh/${watchTopic}`, {
    method: "POST",
    body,
    headers: { Title: title, Priority: priority, Tags: "sos,mountain" },
  }).catch(() => {});
}

function saveWatch() {
  localStorage.setItem("sr-watch", JSON.stringify(watch));
  renderWatchStatus();
}

function armWatch() {
  const t = getTrail(document.getElementById("plan-trail").value);
  const date = document.getElementById("plan-date").value;
  const retour = document.getElementById("plan-retour").value;
  if (!t || !date || !retour) { alert("Complétez le plan de marche (itinéraire, date, heure de retour)."); return; }
  const retourMs = new Date(`${date}T${retour}`).getTime();
  watch = {
    armed: true,
    trailName: t.name,
    retour: retourMs,
    deadline: retourMs + ALERT_DELAY_H * 3600000,
    prewarned: false,
    alertSent: false,
  };
  saveWatch();
  ntfyPush("🛡 Veille armée — Sancho Rossi",
    `${t.name} — retour prévu ${new Date(retourMs).toLocaleString("fr-FR")}. ` +
    `Alerte automatique si aucune activité d'ici ${new Date(watch.deadline).toLocaleString("fr-FR")}.`);
}

function disarmWatch(reason) {
  if (!watch) return;
  watch.armed = false;
  saveWatch();
  document.getElementById("prealert").classList.add("hidden");
  ntfyPush("✓ Veille levée — Sancho Rossi", reason || "Tout va bien, veille désarmée.");
}

function checkWatch() {
  if (!watch?.armed) return;
  const now = Date.now();
  const lastAct = Number(localStorage.getItem("sr-lastact") || 0);

  // Activité après l'heure de retour : tout va bien, la veille se lève seule
  if (lastAct > watch.retour) {
    disarmWatch("Activité détectée après l'heure de retour — veille levée automatiquement.");
    return;
  }
  if (now >= watch.deadline && !watch.alertSent) {
    watch.alertSent = true;
    saveWatch();
    const pos = state.lastPos
      ? `Dernière position connue : https://maps.google.com/?q=${state.lastPos.lat.toFixed(5)},${state.lastPos.lon.toFixed(5)} (${new Date(state.lastPos.ts).toLocaleString("fr-FR")})`
      : "Dernière position inconnue.";
    ntfyPush("🚨 ALERTE — Sancho Rossi",
      `Aucune activité ${ALERT_DELAY_H} h après le retour prévu.\n` +
      `Itinéraire : ${watch.trailName}\nRetour prévu : ${new Date(watch.retour).toLocaleString("fr-FR")}\n${pos}\n` +
      `Prévenir les secours : 112 (118 secours alpin Italie).`, "urgent");
    showPrealert(true);
  } else if (now >= watch.deadline - PREWARN_MIN * 60000 && !watch.prewarned) {
    watch.prewarned = true;
    saveWatch();
    ntfyPush("⚠ Pré-alerte — Sancho Rossi",
      `Aucune activité détectée. Sans confirmation dans les ${PREWARN_MIN} min, l'alerte sera envoyée.`, "high");
    navigator.vibrate?.([300, 100, 300, 100, 300]);
    showPrealert(false);
  }
}

function showPrealert(sent) {
  const el = document.getElementById("prealert");
  document.getElementById("prealert-text").textContent = sent
    ? `L'alerte a été envoyée automatiquement sur ntfy.sh/${watchTopic} (retour prévu dépassé de ${ALERT_DELAY_H} h sans activité). Si c'est une fausse alerte, désarmez et prévenez vos proches.`
    : `Aucune activité détectée depuis votre heure de retour prévue (${new Date(watch.retour).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}). Sans réponse d'ici ${new Date(watch.deadline).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}, l'alerte sera envoyée automatiquement à vos proches.`;
  document.getElementById("prealert-links").innerHTML = sent
    ? state.contacts.map((c) => {
        const msg = encodeURIComponent(`FAUSSE ALERTE / ou besoin d'aide — ${watch.trailName}. ${planMessage()}`);
        const href = c.channel === "whatsapp" ? `https://wa.me/${c.addr.replace(/[^\d]/g, "")}?text=${msg}`
          : c.channel === "sms" ? `sms:${c.addr}?body=${msg}`
          : `mailto:${c.addr}?body=${msg}`;
        return `<a class="btn" href="${href}" target="_blank" rel="noopener">📤 ${c.name}</a>`;
      }).join("")
    : "";
  el.classList.remove("hidden");
}

document.getElementById("prealert-ok").addEventListener("click", () => {
  markActivity();
  disarmWatch("Confirmation « je vais bien » reçue.");
});

document.getElementById("btn-arm-watch").addEventListener("click", () => {
  if (watch?.armed) disarmWatch("Veille désarmée manuellement.");
  else armWatch();
});

document.getElementById("btn-copy-topic").addEventListener("click", async (e) => {
  await navigator.clipboard.writeText(`https://ntfy.sh/${watchTopic}`);
  e.target.textContent = "✓ Copié";
  setTimeout(() => (e.target.textContent = "Copier le lien"), 1600);
});

function renderWatchStatus() {
  const statusEl = document.getElementById("watch-status");
  const btn = document.getElementById("btn-arm-watch");
  const link = document.getElementById("watch-topic-link");
  link.textContent = `ntfy.sh/${watchTopic}`;
  link.href = `https://ntfy.sh/${watchTopic}`;
  if (watch?.armed) {
    statusEl.innerHTML = `🛡 <strong>Veille armée</strong> — ${watch.trailName}, alerte auto le
      ${new Date(watch.deadline).toLocaleString("fr-FR", { weekday: "short", hour: "2-digit", minute: "2-digit" })} sans activité.`;
    btn.textContent = "Désarmer";
  } else {
    statusEl.textContent = watch?.alertSent ? "Alerte envoyée puis veille désarmée." : "Veille désarmée.";
    btn.textContent = "🛡 Armer la veille";
  }
}

setInterval(checkWatch, 60000);
document.addEventListener("visibilitychange", checkWatch);

// ---------- Sécurité : contacts, position, plan de marche ----------
function saveContacts() {
  localStorage.setItem("sr-contacts", JSON.stringify(state.contacts));
}

function renderContacts() {
  const el = document.getElementById("contacts-list");
  el.innerHTML = state.contacts.length
    ? state.contacts
        .map(
          (c) => `
      <div class="contact-row">
        <span><strong>${c.name}</strong> · ${c.channel === "whatsapp" ? "WhatsApp" : c.channel === "sms" ? "SMS" : "E-mail"} · ${c.addr}</span>
        <button class="btn btn-danger" data-del-contact="${c.id}">✕</button>
      </div>`
        )
        .join("")
    : `<p class="muted">Aucun contact pour l'instant — ajoutez au moins une personne de confiance.</p>`;
  el.querySelectorAll("[data-del-contact]").forEach((b) =>
    b.addEventListener("click", () => {
      state.contacts = state.contacts.filter((c) => c.id !== b.dataset.delContact);
      saveContacts();
      renderSafety();
    })
  );
}

document.getElementById("btn-add-contact").addEventListener("click", () => {
  const name = document.getElementById("contact-name").value.trim();
  const channel = document.getElementById("contact-channel").value;
  const addr = document.getElementById("contact-addr").value.trim();
  if (!name || !addr) { alert("Nom et coordonnée (numéro ou e-mail) requis."); return; }
  state.contacts.push({ id: Math.random().toString(36).slice(2, 9), name, channel, addr });
  saveContacts();
  document.getElementById("contact-name").value = "";
  document.getElementById("contact-addr").value = "";
  renderSafety();
});

// Position
let watchId = null;

function savePos(pos) {
  markActivity(); // une position GPS vaut signe de vie pour la veille
  state.lastPos = {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    acc: Math.round(pos.coords.accuracy),
    ts: Date.now(),
  };
  localStorage.setItem("sr-lastpos", JSON.stringify(state.lastPos));
  renderPos();
  renderPlanPreview();
}

function renderPos() {
  const el = document.getElementById("last-pos");
  if (!state.lastPos) { el.textContent = "Aucune position enregistrée."; return; }
  const d = new Date(state.lastPos.ts);
  el.innerHTML = `Dernière position : <strong>${state.lastPos.lat.toFixed(5)}, ${state.lastPos.lon.toFixed(5)}</strong>
    (±${state.lastPos.acc} m) à ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
}

document.getElementById("btn-track-pos").addEventListener("click", (e) => {
  const status = document.getElementById("pos-status");
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    status.textContent = "Suivi GPS désactivé.";
    e.target.textContent = "Activer le suivi";
    return;
  }
  if (!navigator.geolocation) { status.textContent = "Géolocalisation non supportée."; return; }
  watchId = navigator.geolocation.watchPosition(savePos,
    (err) => (status.textContent = `Erreur GPS : ${err.message}`),
    { enableHighAccuracy: true, maximumAge: 30000 });
  status.textContent = "Suivi GPS actif — la dernière position est enregistrée en continu.";
  e.target.textContent = "Désactiver le suivi";
});

document.getElementById("btn-refresh-pos").addEventListener("click", () => {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(savePos, (err) =>
    (document.getElementById("pos-status").textContent = `Erreur GPS : ${err.message}`),
    { enableHighAccuracy: true });
});

// Plan de marche
function planMessage() {
  const t = getTrail(document.getElementById("plan-trail").value);
  if (!t) return "";
  const date = document.getElementById("plan-date").value;
  const retour = document.getElementById("plan-retour").value;
  const gain = t.elevationGain ?? state.elev[t.id]?.gain;
  const start = trackOf(t)[0];
  const dateFr = date
    ? new Date(date + "T00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })
    : "(date à préciser)";
  const posLine = state.lastPos
    ? `Ma dernière position connue : https://maps.google.com/?q=${state.lastPos.lat.toFixed(5)},${state.lastPos.lon.toFixed(5)} (à ${new Date(state.lastPos.ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}, ±${state.lastPos.acc} m)`
    : "Ma dernière position connue : non disponible pour l'instant";
  return `🥾 PLAN DE MARCHE — Sancho Rossi
Itinéraire : ${t.name} (${t.location}, ${t.region})
${t.distance} km · ${gain ? Math.round(gain) + " m D+ · " : ""}${t.duration}${t.bivouac ? " · nuit en bivouac" : ""}
Date : ${dateFr} — retour prévu à ${retour}
Point de départ : https://maps.google.com/?q=${start[0].toFixed(5)},${start[1].toFixed(5)}
${posLine}
🔔 Abonne-toi à mon canal d'alerte automatique : https://ntfy.sh/${watchTopic} (application ou site ntfy — tu recevras une notification si je ne donne pas signe de vie)
⚠️ Sans nouvelles de moi 2 h après l'heure de retour prévue, appelle les secours : 112 (ou 118 secours alpin Italie) en indiquant ce message.`;
}

function renderPlanPreview() {
  const preview = document.getElementById("plan-preview");
  preview.value = planMessage();
  const btns = document.getElementById("plan-share-buttons");
  const msg = encodeURIComponent(preview.value);
  const canNative = !!navigator.share;
  btns.innerHTML =
    state.contacts
      .map((c) => {
        const href =
          c.channel === "whatsapp" ? `https://wa.me/${c.addr.replace(/[^\d]/g, "")}?text=${msg}`
          : c.channel === "sms" ? `sms:${c.addr}?body=${msg}`
          : `mailto:${c.addr}?subject=${encodeURIComponent("Plan de marche — Sancho Rossi")}&body=${msg}`;
        return `<a class="btn btn-primary" href="${href}" target="_blank" rel="noopener">📤 ${c.name}</a>`;
      })
      .join("") +
    (canNative ? `<button class="btn" id="btn-native-share">Partager…</button>` : "") +
    `<button class="btn" id="btn-copy-plan">Copier</button>`;
  document.getElementById("btn-native-share")?.addEventListener("click", () =>
    navigator.share({ title: "Plan de marche", text: preview.value }).catch(() => {})
  );
  document.getElementById("btn-copy-plan").addEventListener("click", async () => {
    await navigator.clipboard.writeText(preview.value);
    document.getElementById("btn-copy-plan").textContent = "✓ Copié";
  });
}

function renderSafety() {
  renderContacts();
  renderPos();
  renderWatchStatus();
  const sel = document.getElementById("plan-trail");
  const current = sel.value;
  const opts = [...state.imported, ...TRAILS, ...CATALOG];
  const favs = opts.filter((t) => state.favorites.has(t.id));
  const rest = opts.filter((t) => !state.favorites.has(t.id));
  sel.innerHTML =
    (favs.length ? `<optgroup label="♥ Enregistrés">${favs.map((t) => `<option value="${t.id}">${t.name}</option>`).join("")}</optgroup>` : "") +
    `<optgroup label="Tous les itinéraires">${rest.map((t) => `<option value="${t.id}">${t.name}</option>`).join("")}</optgroup>`;
  if (current && getTrail(current)) sel.value = current;
  if (!document.getElementById("plan-date").value) {
    document.getElementById("plan-date").value = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  }
  renderPlanPreview();
}

["plan-trail", "plan-date", "plan-retour"].forEach((id) =>
  document.getElementById(id).addEventListener("change", renderPlanPreview)
);

// ---------- Panneau de filtres partagé ----------
const filtersModal = document.getElementById("filters-modal");

function activeFiltersCount() {
  return [
    state.days, state.difficulty, state.source, state.region, state.type,
    state.distMin != null ? "x" : "", state.distMax != null ? "x" : "",
    state.gainMax != null ? "x" : "",
  ].filter(Boolean).length;
}

function updateFiltersBadge(resultCount) {
  const n = activeFiltersCount();
  ["filters-badge", "filters-badge-2"].forEach((id) => {
    const el = document.getElementById(id);
    el.textContent = n;
    el.classList.toggle("hidden", n === 0);
  });
  document.getElementById("filters-count").textContent =
    `${resultCount ?? filteredTrails().length} itinéraire${(resultCount ?? 0) > 1 ? "s" : ""}`;
}

function openFilters() {
  filtersModal.classList.remove("hidden");
  updateFiltersBadge(filteredTrails().length);
}

function closeFilters() {
  filtersModal.classList.add("hidden");
}

document.getElementById("btn-filters-map").addEventListener("click", openFilters);
document.getElementById("btn-filters-grid").addEventListener("click", openFilters);
document.getElementById("filters-close").addEventListener("click", closeFilters);
document.getElementById("filters-apply").addEventListener("click", closeFilters);
filtersModal.addEventListener("click", (e) => { if (e.target === filtersModal) closeFilters(); });

function bindNumberFilter(id, key) {
  document.getElementById(id).addEventListener("input", (e) => {
    state[key] = e.target.value === "" ? null : Number(e.target.value);
    renderAll();
  });
}
bindNumberFilter("filter-dist-min", "distMin");
bindNumberFilter("filter-dist-max", "distMax");
bindNumberFilter("filter-gain-max", "gainMax");

document.getElementById("filters-reset").addEventListener("click", () => {
  Object.assign(state, {
    days: "", difficulty: "", source: "", region: "", type: "",
    distMin: null, distMax: null, gainMax: null, search: "",
  });
  document.querySelectorAll("#filters-modal .filter-group").forEach((g) => {
    g.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.value === ""));
  });
  ["filter-region", "filter-type"].forEach((id) => (document.getElementById(id).value = ""));
  ["filter-dist-min", "filter-dist-max", "filter-gain-max"].forEach(
    (id) => (document.getElementById(id).value = "")
  );
  document.getElementById("search-input").value = "";
  renderAll();
});

// Liste repliable (mobile : repliée par défaut pour laisser la carte respirer)
const resultsPanel = document.getElementById("results-panel");
document.getElementById("btn-list").addEventListener("click", () =>
  resultsPanel.classList.toggle("collapsed")
);
if (window.innerWidth < 700) resultsPanel.classList.add("collapsed");

// ---------- Contrôles carte ----------
document.getElementById("search-input").addEventListener("input", (e) => {
  state.search = e.target.value;
  renderList();
});

function bindChips(groupId, key) {
  document.querySelectorAll(`#${groupId} .chip`).forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(`#${groupId} .chip`).forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state[key] = chip.dataset.value;
      renderAll();
    });
  });
}
bindChips("filter-days", "days");
bindChips("filter-difficulty", "difficulty");
bindChips("filter-source", "source");

const regionSelect = document.getElementById("filter-region");
[...new Set([...TRAILS, ...CATALOG].map((t) => t.region))].sort().forEach((r) => {
  const opt = document.createElement("option");
  opt.value = r;
  opt.textContent = r;
  regionSelect.appendChild(opt);
});

regionSelect.addEventListener("change", (e) => { state.region = e.target.value; renderAll(); });
document.getElementById("filter-type").addEventListener("change", (e) => { state.type = e.target.value; renderAll(); });
document.getElementById("sort-by").addEventListener("change", (e) => { state.sortBy = e.target.value; renderAll(); });

document.getElementById("panel-collapse").addEventListener("click", () => {
  document.getElementById("results-panel").classList.toggle("collapsed");
});

// ---------- Réglages ----------
const baseSelect = document.getElementById("setting-baselayer");
baseSelect.value = ["plan", "topo", "satellite", "sombre"].find((n) => layersConfig[n].on) || "plan";
baseSelect.addEventListener("change", () => {
  ["plan", "topo", "satellite", "sombre"].forEach((n) => {
    layersConfig[n].on = n === baseSelect.value;
    applyLayer(n);
  });
});

async function refreshTilesCount() {
  const el = document.getElementById("tiles-count");
  try {
    const cache = await caches.open("sr-tiles-v1");
    const keys = await cache.keys();
    el.textContent = `(${keys.length} tuiles)`;
  } catch {
    el.textContent = "";
  }
}

document.getElementById("btn-clear-tiles").addEventListener("click", async () => {
  await caches.delete("sr-tiles-v1");
  refreshTilesCount();
});

document.getElementById("btn-clear-photos").addEventListener("click", () => {
  state.photos = {};
  localStorage.removeItem("sr-photos");
  loadWikiPhotos();
});

document.getElementById("btn-export-data").addEventListener("click", () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    favorites: [...state.favorites],
    notes: state.notes,
    gpx: state.imported,
    contacts: state.contacts,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "sancho-rossi-backup.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

const dataInput = document.getElementById("data-file-input");
document.getElementById("btn-import-data").addEventListener("click", () => dataInput.click());
dataInput.addEventListener("change", async () => {
  try {
    const payload = JSON.parse(await dataInput.files[0].text());
    (payload.favorites || []).forEach((id) => state.favorites.add(id));
    Object.assign(state.notes, payload.notes || {});
    const known = new Set(state.imported.map((t) => t.id));
    (payload.gpx || []).forEach((t) => {
      if (!known.has(t.id)) { state.imported.push(t); addMarker(t); }
    });
    const knownContacts = new Set(state.contacts.map((c) => c.id));
    (payload.contacts || []).forEach((c) => { if (!knownContacts.has(c.id)) state.contacts.push(c); });
    localStorage.setItem("sr-favorites", JSON.stringify([...state.favorites]));
    localStorage.setItem("sr-notes", JSON.stringify(state.notes));
    localStorage.setItem("sr-gpx", JSON.stringify(state.imported));
    saveContacts();
    renderAll();
    renderFavCount();
    alert("Données restaurées.");
  } catch (err) {
    alert(`Fichier invalide : ${err.message}`);
  }
  dataInput.value = "";
});

document.getElementById("btn-reset-data").addEventListener("click", () => {
  if (!confirm("Effacer favoris, notes, GPX importés, contacts et caches ? Cette action est définitive.")) return;
  ["sr-favorites", "sr-notes", "sr-gpx", "sr-photos", "sr-baselayer", "sr-elev", "sr-contacts", "sr-lastpos", "sr-theme"]
    .forEach((k) => localStorage.removeItem(k));
  caches?.delete("sr-tiles-v1");
  location.reload();
});

// ---------- PWA ----------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ---------- Initialisation ----------
renderAll();
renderFavCount();
refreshTilesCount();
checkWatch();
loadWikiPhotos().then(prefetchCatalogPhotos);
