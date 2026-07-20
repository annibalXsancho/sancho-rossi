// Sancho Rossi — fiche itinéraire (page plein écran, façon AllTrails) + vue 3D + profil
import { state, catalogTrails, getTrail, trackOf, sampleTrack, haversineKm, saveNote } from "./state.js";
import { ensureElevation } from "./api.js";
import { createProfile } from "./profile.js";
import { loadWeatherTab } from "./weather.js";
import { photoStyle, geoPhoto, updateCardPhotos } from "./photos.js";
import { putMeta } from "./storage.js";
import { hidePreview, clearActiveTrack, OVERZOOM, drawTrack } from "./map.js";
import { renderList, selectTrail, toggleFavorite, downloadGPX, deleteImported, renameImported } from "./trails.js";
import { switchTab } from "./ui.js";
import { startNavigation } from "./nav.js";
import { hasPack, buildPack } from "./offline.js";
import { askPackOptions } from "./packdialog.js";
import { createRouteWeather } from "./hikeweather.js";
import { annotKind } from "./annotations.js";
import { toast } from "./toast.js";

const detailPanel = document.getElementById("detail-panel");
const detailContent = document.getElementById("detail-content");
const breadcrumbEl = document.getElementById("detail-breadcrumb");
let miniMap = null;
let miniCursor = null;
let profile = null;
let routeWx = null; // bandeau météo à l'heure de passage (S-METEO)
let viewer3dActive = false;
// Jeton de rendu : `ensureElevation` peut répondre après qu'on a ouvert une AUTRE
// fiche, et le profil de la précédente s'installerait alors dans la nouvelle.
let renderSeq = 0;

// Les noms de tracés sont désormais éditables par l'utilisateur : on échappe
// avant toute injection en innerHTML.
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

export function isDetailOpen() {
  return !detailPanel.classList.contains("hidden");
}

// ---------- Repères personnels d'un tracé planifié (S-PLAN-C) ----------
// Les notes sont de la saisie utilisateur : échappées (escapeHtml ci-dessus) avant
// toute injection HTML.

// Repères → marques du profil (uniquement ceux qui sont SUR l'itinéraire : un point
// hors tracé n'a pas de km honnête à afficher sur une courbe).
const poiProfileMarkers = (t) =>
  (t.pois || [])
    .filter((p) => p.km != null)
    .map((p) => ({ km: p.km, icon: annotKind(p.kind).icon, label: p.note || annotKind(p.kind).label }));

// Pose les repères sur une carte Leaflet de la fiche (mini-carte inerte ou plein
// écran). Même pastille que le planificateur, en plus petit.
function addPoiMarkers(leafletMap, t, { tooltips = false } = {}) {
  (t.pois || []).forEach((p) => {
    const mk = L.marker([p.lat, p.lon], {
      interactive: tooltips,
      keyboard: false,
      icon: L.divIcon({
        className: "plan-annot plan-annot-sm",
        html: `<span class="plan-annot-i">${annotKind(p.kind).icon}</span>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      }),
    }).addTo(leafletMap);
    if (tooltips) mk.bindTooltip(escapeHtml(p.note || annotKind(p.kind).label), { direction: "top", offset: [0, -10] });
  });
}

function poisSectionHtml(t) {
  if (!t.pois?.length) return "";
  const rows = [...t.pois]
    .sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity))
    .map((p) => {
      const d = annotKind(p.kind);
      const meta = [
        p.note ? d.label : null,
        p.km != null ? `km ${p.km.toLocaleString("fr-FR")}` : "hors itinéraire",
      ].filter(Boolean).join(" · ");
      return `<div class="annot-row static">
        <span class="annot-ic">${d.icon}</span>
        <div class="annot-body">
          <span class="annot-name">${escapeHtml(p.note || d.label)}</span>
          <span class="annot-meta">${escapeHtml(meta)}</span>
        </div>
      </div>`;
    })
    .join("");
  return `<h3 class="section-title">Mes repères</h3><div class="plan-annots annot-list-detail">${rows}</div>`;
}

// Renommage en place : le titre devient éditable, Entrée/clic-ailleurs valide,
// Échap annule. Un seul geste, sans boîte de dialogue.
function startRename(id, t) {
  const h = document.getElementById("detail-title");
  if (!h || h.isContentEditable) return;
  const original = t.name;
  h.setAttribute("contenteditable", "plaintext-only");
  h.classList.add("editing");
  h.focus();
  const range = document.createRange();
  range.selectNodeContents(h);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    h.removeEventListener("keydown", onKey);
    h.removeEventListener("blur", onBlur);
    h.removeAttribute("contenteditable");
    h.classList.remove("editing");
    const next = h.textContent.trim();
    if (commit && next && next !== original && renameImported(id, next)) {
      t.name = next;
      h.textContent = next;
      breadcrumbEl.querySelector("strong").textContent = next;
      const fmTitle = document.getElementById("fullmap-title");
      if (fmTitle) fmTitle.textContent = next;
      toast("Itinéraire renommé.", { type: "success" });
    } else {
      h.textContent = original; // annulation ou nom vide/inchangé
    }
  };
  const onKey = (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  h.addEventListener("keydown", onKey);
  h.addEventListener("blur", onBlur);
}

function destroyMiniMap() {
  if (miniMap) { miniMap.remove(); miniMap = null; }
  miniCursor = null;
  profile?.destroy();
  profile = null;
  routeWx?.destroy();
  routeWx = null;
}

// Survol du profil → point sur la mini-carte. C'est ce qui rend le profil lisible :
// « cette rampe, c'est où ? » n'a plus besoin d'être deviné.
function showOnMiniMap(p) {
  if (!miniMap) return;
  if (!p) { miniCursor?.remove(); miniCursor = null; return; }
  if (!miniCursor) {
    miniCursor = L.circleMarker([p.lat, p.lon], {
      radius: 5, color: "#fff", weight: 2, fillColor: "#ff2d20", fillOpacity: 1,
      interactive: false,
    }).addTo(miniMap);
  } else {
    miniCursor.setLatLng([p.lat, p.lon]);
  }
}

// ---------- Carte plein écran (clic sur la mini-carte) ----------
// La mini-carte est volontairement inerte (aperçu) ; l'explorer se fait ici : carte
// entière et interactive + le même profil en bandeau bas, synchronisés dans les deux
// sens. Même contrat d'historique que la fiche : Échap, ✕ et le bouton retour ferment.
let fullMap = null;
let fullProfile = null;
let fullCursor = null;

const fullmapEl = document.getElementById("fullmap-overlay");

export function isFullMapOpen() {
  return !fullmapEl.classList.contains("hidden");
}

// Fermer par Échap ou ✕ appelle history.back() pour dépiler l'entrée d'historique —
// ce qui déclenche un popstate que ui.js relirait comme « l'utilisateur recule » et
// qui fermerait la fiche EN PLUS de la carte. Ce compteur absorbe exactement les
// popstate que nous provoquons nous-mêmes.
let selfBacks = 0;

function selfBack() {
  selfBacks++;
  history.back();
}

export function consumeSelfBack() {
  if (selfBacks <= 0) return false;
  selfBacks--;
  return true;
}

function showOnFullMap(p) {
  if (!fullMap) return;
  if (!p) { fullCursor?.remove(); fullCursor = null; return; }
  if (!fullCursor) {
    fullCursor = L.circleMarker([p.lat, p.lon], {
      radius: 6, color: "#fff", weight: 2, fillColor: "#ff2d20", fillOpacity: 1,
      interactive: false,
    }).addTo(fullMap);
  } else {
    fullCursor.setLatLng([p.lat, p.lon]);
  }
}

function openFullMap(t) {
  if (isFullMapOpen()) return;
  fullmapEl.classList.remove("hidden");
  history.pushState({ srDetail: true, srFullmap: true }, "");

  document.getElementById("fullmap-title").textContent = t.name;
  const gain = t.elevationGain ?? state.elev[t.id]?.gain;
  const amax = t.altMax ?? state.elev[t.id]?.max;
  const fr = (v) => Math.round(v).toLocaleString("fr-FR");
  document.getElementById("fullmap-stats").innerHTML =
    `<span class="fullmap-stat"><b>${t.distance}</b> km</span>` +
    (gain ? `<span class="fullmap-stat"><b>${fr(gain)}</b> m D+</span>` : "") +
    (amax ? `<span class="fullmap-stat"><b>${fr(amax)}</b> m max</span>` : "") +
    `<span class="fullmap-stat"><b>${t.duration}</b></span>`;

  const panel = fullmapEl.querySelector(".fullmap-panel");
  fullMap = L.map("fullmap", { maxZoom: 17 + OVERZOOM });
  L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxNativeZoom: 17, maxZoom: 22 }).addTo(fullMap);
  const line = drawTrack(t.segments || t.track).addTo(fullMap);
  addPoiMarkers(fullMap, t, { tooltips: true });
  // Le bandeau bas recouvre la carte : le cadrage doit en tenir compte, sinon le
  // départ ou l'arrivée se retrouve caché dessous.
  fullMap.fitBounds(line.getBounds(), {
    paddingTopLeft: [40, 60],
    paddingBottomRight: [40, (panel?.offsetHeight || 150) + 30],
  });
  line.on("mousemove", (e) => {
    const km = fullProfile?.kmNear(e.latlng.lat, e.latlng.lng);
    if (km != null) fullProfile.setCursorKm(km);
  });
  line.on("mouseout", () => fullProfile?.setCursorKm(null));

  ensureElevation(t)
    .then((eles) => {
      if (!isFullMapOpen()) return; // fermé pendant la requête
      fullProfile = createProfile(document.getElementById("fullmap-profile"), {
        eles,
        track: t.mainline || trackOf(t),
        ways: t.ways,
        totalKm: t.distance,
        height: window.innerWidth < 700 ? 84 : 110,
        onHover: showOnFullMap,
        markers: poiProfileMarkers(t),
      });
    })
    .catch(() => {}); // hors-ligne : la carte et les stats suffisent, pas de bandeau vide
}

export function closeFullMap(fromPopstate = false) {
  if (!isFullMapOpen()) return;
  fullmapEl.classList.add("hidden");
  fullProfile?.destroy();
  fullProfile = null;
  fullCursor = null;
  if (fullMap) { fullMap.remove(); fullMap = null; }
  document.getElementById("fullmap-profile").innerHTML = "";
  if (!fromPopstate && history.state?.srFullmap) selfBack();
}

export function renderDetail(id) {
  const t = getTrail(id);
  const faved = state.favorites.has(id);
  const seq = ++renderSeq;
  const gain = t.elevationGain ?? state.elev[id]?.gain;
  const amax = t.altMax ?? state.elev[id]?.max;
  // Entrée dans l'historique à l'ouverture : le bouton retour referme la fiche
  if (detailPanel.classList.contains("hidden")) history.pushState({ srDetail: true }, "");
  destroyMiniMap();
  window.SR3D?.dispose();
  viewer3dActive = false;

  breadcrumbEl.innerHTML =
    `<button class="bc-link" data-bc="all">Europe</button> / ` +
    `<button class="bc-link" data-bc="region">${escapeHtml(t.region)}</button> / <strong>${escapeHtml(t.name)}</strong>`;
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
    <div class="detail-title-row">
      <h1 class="detail-title" id="detail-title">${escapeHtml(t.name)}</h1>
      ${t.imported ? `<button class="detail-rename" id="btn-rename" title="Renommer" aria-label="Renommer l'itinéraire">✎</button>` : ""}
    </div>
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
        <div class="mini-map-wrap" id="mini-map-wrap" title="Agrandir la carte" role="button" tabindex="0" aria-label="Ouvrir la carte en plein écran">
          <div id="mini-map"></div>
          <span class="mini-map-expand" aria-hidden="true">⤢</span>
        </div>
        <div class="side-profile" id="side-profile">
          <p class="muted">Profil d'altitude réel — chargement…</p>
        </div>
        <div id="route-wx"></div>
      </div>
    </div>

    <div class="detail-statsbar">
      <div class="bigstat"><div class="bigstat-v">${t.distance}<small> km</small></div><div class="bigstat-l">Distance</div></div>
      <div class="bigstat"><div class="bigstat-v" id="stat-gain">${gain ? Math.round(gain).toLocaleString("fr-FR") + '<small> m</small>' : "…"}</div><div class="bigstat-l">Dénivelé positif</div></div>
      <div class="bigstat"><div class="bigstat-v" id="stat-amax">${amax ? Math.round(amax).toLocaleString("fr-FR") + '<small> m</small>' : "…"}</div><div class="bigstat-l">Altitude max</div></div>
      <div class="bigstat"><div class="bigstat-v">${t.duration}</div><div class="bigstat-l">Durée</div></div>
    </div>

    <div class="detail-actions">
      <button class="btn btn-primary btn-lg" id="btn-follow">▶ Suivre ce tracé</button>
      <div class="action-row">
        <button class="btn ${faved ? "faved" : ""}" id="btn-detail-fav">${faved ? "♥ Enregistré" : "♡ Sauvegarder"}</button>
        <button class="btn" id="btn-itinerary">🧭 Voir sur la carte</button>
        <button class="btn ${hasPack(id) ? "faved" : ""}" id="btn-offline">${hasPack(id) ? "✓ Hors-ligne" : "⤓ Terrain"}</button>
      </div>
      <div class="action-row action-row-minor">
        <button class="btn-ghost" id="btn-gpx">⤓ GPX</button>
        <button class="btn-ghost" id="btn-safety">🛟 Partager</button>
        ${t.imported ? `<button class="btn-ghost btn-ghost-danger" id="btn-delete-gpx">🗑 Supprimer</button>` : ""}
      </div>
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
      ${poisSectionHtml(t)}
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
  L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxNativeZoom: 17, maxZoom: 22 }).addTo(miniMap);
  const line = drawTrack(t.segments || t.track, { weight: 3.5 }).addTo(miniMap);
  addPoiMarkers(miniMap, t);
  miniMap.fitBounds(line.getBounds(), { padding: [18, 18] });
  // Sens carte → profil : longer le tracé sur la mini-carte déplace le curseur du
  // profil (l'autre sens passe par showOnMiniMap). Le profil arrive après (async) :
  // le handler lit `profile` au moment de l'événement, jamais à l'attache.
  line.on("mousemove", (e) => {
    const km = profile?.kmNear(e.latlng.lat, e.latlng.lng);
    if (km != null) profile.setCursorKm(km);
  });
  line.on("mouseout", () => profile?.setCursorKm(null));

  // Clic (ou Entrée) sur la mini-carte → carte plein écran
  const wrap = document.getElementById("mini-map-wrap");
  wrap.addEventListener("click", () => openFullMap(t));
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFullMap(t); }
  });

  // Profil réel
  ensureElevation(t)
    .then((eles) => {
      if (seq !== renderSeq) return; // une autre fiche s'est ouverte entre-temps
      profile = createProfile(document.getElementById("side-profile"), {
        eles,
        // Le même fil que celui sur lequel ensureElevation a relevé l'altitude —
        // c'est ce qui permet à profile.js de réaligner les deux (cf. sampleTrack).
        track: t.mainline || trackOf(t),
        ways: t.ways,
        totalKm: t.distance,
        height: 130,
        onHover: showOnMiniMap,
        // La météo à l'heure de passage complète la bulle du profil ; `routeWx` est
        // affecté juste après, la closure le lit au moment du survol.
        annotate: (km) => routeWx?.annotate(km) || "",
        markers: poiProfileMarkers(t),
      });
      routeWx = createRouteWeather(document.getElementById("route-wx"), t, {
        eles, track: t.mainline || trackOf(t), totalKm: t.distance,
      });
      const e = state.elev[id];
      if (e) {
        document.getElementById("stat-gain").innerHTML = `${e.gain.toLocaleString("fr-FR")}<small> m</small>`;
        document.getElementById("stat-amax").innerHTML = `${e.max.toLocaleString("fr-FR")}<small> m</small>`;
      }
    })
    .catch(() => {
      if (seq !== renderSeq) return;
      document.getElementById("side-profile").innerHTML =
        `<p class="muted">Profil indisponible hors connexion.</p>`;
      // Sans altitude on peut encore servir la météo de passage : en ligne le bandeau
      // se calcule sur la distance seule ; hors-ligne il retombe sur le snapshot du
      // pack (qui embarque ses propres heures de marche).
      routeWx = createRouteWeather(document.getElementById("route-wx"), t, {
        eles: null, track: t.mainline || trackOf(t), totalKm: t.distance,
      });
      document.getElementById("stat-gain").textContent = gain ? Math.round(gain) : "—";
      document.getElementById("stat-amax").textContent = amax ? Math.round(amax) : "—";
    });

  // Tracés officiels proches (fiches de la sélection bivouac uniquement)
  const nearbyEl = document.getElementById("nearby-official");
  if (nearbyEl) {
    const near = catalogTrails()
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
        putMeta("photos", state.photos);
        if (url && state.selectedId === id) {
          document.querySelector(".detail-hero").style.cssText = photoStyle(t);
          updateCardPhotos(t);
        }
      })
      .catch(() => {});
  }

  document.getElementById("btn-detail-fav").addEventListener("click", () => toggleFavorite(id));
  document.getElementById("btn-offline").addEventListener("click", () => downloadPack(t, id));
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
  document.getElementById("btn-rename")?.addEventListener("click", () => startRename(id, t));

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
    toast(`Vue 3D indisponible : ${err.message}`, { type: "error" });
  }
}

// Téléchargement d'un pack « pour le terrain » depuis la fiche. La fiche peut se
// re-rendre pendant l'opération (auto-save d'un OSM → renderAll) : on re-cible donc
// toujours le bouton par son id pour refléter la progression sur l'élément visible.
async function downloadPack(t, id) {
  if (hasPack(id)) { closeDetail(); switchTab("reglages"); return; }
  const depth = await askPackOptions(t);
  if (!depth) return;

  const setBtn = (text) => {
    const b = document.getElementById("btn-offline");
    if (b) { b.disabled = true; b.textContent = text; }
  };
  setBtn("⏳ Préparation…");
  try {
    await buildPack(t, depth, (p) => {
      if (p.phase === "tiles") setBtn(`⏳ Carte ${Math.round((p.done / p.total) * 100) || 0} %`);
      else if (p.phase === "poi") setBtn("⏳ Points d'intérêt…");
      else if (p.phase === "weather") setBtn("⏳ Météo…");
    });
    const b = document.getElementById("btn-offline");
    if (b) { b.disabled = false; b.textContent = "✓ Hors-ligne"; b.classList.add("faved"); }
  } catch (err) {
    const b = document.getElementById("btn-offline");
    if (b) { b.disabled = false; b.textContent = "⤓ Terrain"; }
    toast(`Téléchargement incomplet : ${err.message}`, { type: "error" });
  }
}

export function closeDetail(fromPopstate = false) {
  if (detailPanel.classList.contains("hidden")) return;
  closeFullMap(fromPopstate); // une fiche fermée ne laisse pas sa carte plein écran orpheline
  detailPanel.classList.add("hidden");
  destroyMiniMap();
  window.SR3D?.dispose();
  hidePreview();
  state.selectedId = null;
  clearActiveTrack();
  renderList();
  if (!fromPopstate && history.state?.srDetail) selfBack();
}

export function initDetail() {
  // closeDetail passé tel quel (l'event truthy évite le history.back), comme l'original
  document.getElementById("detail-close").addEventListener("click", closeDetail);
  document.getElementById("fullmap-close").addEventListener("click", () => closeFullMap());
}
