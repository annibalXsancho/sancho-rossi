// Sancho Rossi — fiche itinéraire (page plein écran, façon AllTrails) + vue 3D + profil
import { state, catalogTrails, getTrail, trackOf, sampleTrack, haversineKm, saveNote } from "./state.js";
import { ensureElevation } from "./api.js";
import { createProfile } from "./profile.js";
import { loadWeatherTab } from "./weather.js";
import { photoStyle, geoPhoto, updateCardPhotos } from "./photos.js";
import { putMeta } from "./storage.js";
import { hidePreview, clearActiveTrack } from "./map.js";
import { renderList, selectTrail, toggleFavorite, downloadGPX, deleteImported } from "./trails.js";
import { switchTab } from "./ui.js";
import { startNavigation } from "./nav.js";
import { hasPack, estimatePack, buildPack } from "./offline.js";

const detailPanel = document.getElementById("detail-panel");
const detailContent = document.getElementById("detail-content");
const breadcrumbEl = document.getElementById("detail-breadcrumb");
let miniMap = null;
let miniCursor = null;
let profile = null;
let viewer3dActive = false;
// Jeton de rendu : `ensureElevation` peut répondre après qu'on a ouvert une AUTRE
// fiche, et le profil de la précédente s'installerait alors dans la nouvelle.
let renderSeq = 0;

export function isDetailOpen() {
  return !detailPanel.classList.contains("hidden");
}

function destroyMiniMap() {
  if (miniMap) { miniMap.remove(); miniMap = null; }
  miniCursor = null;
  profile?.destroy();
  profile = null;
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
      <button class="btn ${hasPack(id) ? "faved" : ""}" id="btn-offline">${hasPack(id) ? "✓ Hors-ligne" : "⤓ Terrain"}</button>
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
  // Sens carte → profil : longer le tracé sur la mini-carte déplace le curseur du
  // profil (l'autre sens passe par showOnMiniMap). Le profil arrive après (async) :
  // le handler lit `profile` au moment de l'événement, jamais à l'attache.
  line.on("mousemove", (e) => {
    const km = profile?.kmNear(e.latlng.lat, e.latlng.lng);
    if (km != null) profile.setCursorKm(km);
  });
  line.on("mouseout", () => profile?.setCursorKm(null));

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
    alert(`Vue 3D indisponible : ${err.message}`);
  }
}

// Téléchargement d'un pack « pour le terrain » depuis la fiche. La fiche peut se
// re-rendre pendant l'opération (auto-save d'un OSM → renderAll) : on re-cible donc
// toujours le bouton par son id pour refléter la progression sur l'élément visible.
async function downloadPack(t, id) {
  if (hasPack(id)) { closeDetail(); switchTab("reglages"); return; }
  const est = estimatePack(t);
  if (est.tiles > 8000) {
    alert(`« ${t.name} » est trop long pour un pack unique (~${est.tiles} tuiles).`);
    return;
  }
  if (!confirm(
    `Télécharger « ${t.name} » pour le terrain ?\n\n` +
    `~${est.tiles} tuiles (~${est.mb} Mo) + points d'eau/refuges + météo.\n` +
    `À faire de préférence en Wi-Fi.`
  )) return;

  const setBtn = (text) => {
    const b = document.getElementById("btn-offline");
    if (b) { b.disabled = true; b.textContent = text; }
  };
  setBtn("⏳ Préparation…");
  try {
    await buildPack(t, (p) => {
      if (p.phase === "tiles") setBtn(`⏳ Carte ${Math.round((p.done / p.total) * 100) || 0} %`);
      else if (p.phase === "poi") setBtn("⏳ Points d'intérêt…");
      else if (p.phase === "weather") setBtn("⏳ Météo…");
    });
    const b = document.getElementById("btn-offline");
    if (b) { b.disabled = false; b.textContent = "✓ Hors-ligne"; b.classList.add("faved"); }
  } catch (err) {
    const b = document.getElementById("btn-offline");
    if (b) { b.disabled = false; b.textContent = "⤓ Terrain"; }
    alert(`Téléchargement incomplet : ${err.message}`);
  }
}

export function closeDetail(fromPopstate = false) {
  if (detailPanel.classList.contains("hidden")) return;
  detailPanel.classList.add("hidden");
  destroyMiniMap();
  window.SR3D?.dispose();
  hidePreview();
  state.selectedId = null;
  clearActiveTrack();
  renderList();
  if (!fromPopstate && history.state?.srDetail) history.back();
}

export function initDetail() {
  // closeDetail passé tel quel (l'event truthy évite le history.back), comme l'original
  document.getElementById("detail-close").addEventListener("click", closeDetail);
}
