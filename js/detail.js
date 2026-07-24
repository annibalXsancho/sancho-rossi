// Sancho Rossi — fiche itinéraire (page plein écran, façon AllTrails) + vue 3D + profil
import { state, catalogTrails, getTrail, trackOf, sampleTrack, haversineKm, saveNote } from "./state.js";
import { ensureElevation } from "./api.js";
import { createProfile } from "./profile.js";
import { loadWeatherTab } from "./weather.js";
import { photoStyle, geoPhoto, updateCardPhotos } from "./photos.js";
import { putMeta } from "./storage.js";
import { hidePreview, clearActiveTrack, createFicheMap, drawTrackOn, domMarker, makeIcon } from "./map.js";
import { renderList, selectTrail, toggleFavorite, downloadGPX, deleteImported, renameImported } from "./trails.js";
import { switchTab } from "./ui.js";
import { startNavigation } from "./nav.js";
import { hasPack, buildPack } from "./offline.js";
import { askPackOptions } from "./packdialog.js";
import { createRouteWeather } from "./hikeweather.js";
import { annotKind } from "./annotations.js";
import { shareTrail } from "./share.js";
import { trailMarks, removeFieldMark } from "./fieldmarks.js";

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

// ---------- Repères personnels (S-PLAN-C préparés + S-V2-ANNOT-TERRAIN posés en marchant) ----------
// La fiche ne distingue pas deux listes : `trailMarks` fond les repères préparés au
// planificateur (champ `pois` du tracé) et ceux posés sur le terrain (store IndexedDB
// dédié). Seuls les seconds sont datés et supprimables ici.
// Les notes sont de la saisie utilisateur : échappées (escapeHtml ci-dessus) avant
// toute injection HTML.

// Marqueurs de repères posés sur les cartes de la fiche (mini-carte + plein écran) :
// gardés par id pour qu'une suppression les retire sans re-rendre toute la fiche.
let markHandles = [];

// Repères → marques du profil (uniquement ceux qui sont SUR l'itinéraire : un point
// hors tracé n'a pas de km honnête à afficher sur une courbe).
const poiProfileMarkers = (t) =>
  trailMarks(t)
    .filter((p) => p.km != null)
    .map((p) => ({ km: p.km, icon: annotKind(p.kind).icon, label: p.note || annotKind(p.kind).label }));

// Pose les repères sur une carte de fiche (mini-carte inerte ou plein écran). Même pastille
// que le planificateur, en plus petit. Sur la carte plein écran (tooltips), le repère
// ouvre au tap une bulle avec sa note ; inerte, il ne capte aucun événement (le survol du
// tracé pour le profil doit passer au travers).
function addPoiMarkers(mapInstance, t, { tooltips = false } = {}) {
  trailMarks(t).forEach((p) => {
    const element = makeIcon("plan-annot plan-annot-sm", `<span class="plan-annot-i">${annotKind(p.kind).icon}</span>`);
    const marker = domMarker(p.lat, p.lon, { element }).addTo(mapInstance);
    if (p.id) markHandles.push({ id: p.id, marker });
    if (tooltips) {
      marker.setPopup(
        new maplibregl.Popup({ className: "map-popup", offset: 14, closeButton: false })
          .setHTML(`<div class="popup-title">${annotKind(p.kind).icon} ${escapeHtml(p.note || annotKind(p.kind).label)}</div>`)
      );
    } else {
      element.style.pointerEvents = "none";
    }
  });
}

const markDate = (ts) =>
  new Date(ts).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function poisSectionHtml(t) {
  const marks = trailMarks(t);
  if (!marks.length) return "";
  const rows = [...marks]
    .sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity))
    .map((p) => {
      const d = annotKind(p.kind);
      const meta = [
        p.note ? d.label : null,
        p.km != null ? `km ${p.km.toLocaleString("fr-FR")}` : "hors itinéraire",
        p.ele != null ? `${p.ele} m` : null,
        // Un repère de terrain porte l'heure de sa pose : c'est ce qui le rattache au
        // souvenir de la sortie (« la source, juste avant le col »).
        p.field ? `posé le ${markDate(p.ts)}` : null,
      ].filter(Boolean).join(" · ");
      return `<div class="annot-row static"${p.field ? ` data-mark="${p.id}"` : ""}>
        <span class="annot-ic">${d.icon}</span>
        <div class="annot-body">
          <span class="annot-name">${escapeHtml(p.note || d.label)}</span>
          <span class="annot-meta">${escapeHtml(meta)}</span>
        </div>
        ${p.field ? `<button class="annot-rm" data-mark-rm="${p.id}" title="Supprimer ce repère" aria-label="Supprimer">✕</button>` : ""}
      </div>`;
    })
    .join("");
  return `<h3 class="section-title">Mes repères</h3><div class="plan-annots annot-list-detail" id="detail-pois">${rows}</div>`;
}

// Suppression depuis la fiche : la ligne, les marqueurs des deux cartes et la marque du
// profil partent ensemble — sans re-rendre la fiche (qui rechargerait cartes et profil).
function bindPoiSection(t) {
  const box = document.getElementById("detail-pois");
  if (!box) return;
  box.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mark-rm]");
    if (!btn) return;
    const id = btn.dataset.markRm;
    removeFieldMark(id);
    box.querySelector(`[data-mark="${id}"]`)?.remove();
    markHandles = markHandles.filter((h) => {
      if (h.id !== id) return true;
      h.marker.remove();
      return false;
    });
    profile?.setMarkers(poiProfileMarkers(t));
    fullProfile?.setMarkers(poiProfileMarkers(t));
    if (!box.children.length) box.previousElementSibling?.remove(); // titre « Mes repères »
    if (!box.children.length) box.remove();
    toast("Repère supprimé.", { type: "info" });
  });
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
    miniCursor = domMarker(p.lat, p.lon, { element: makeIcon("map-cursor") }).addTo(miniMap);
  } else {
    miniCursor.setLngLat([p.lon, p.lat]);
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
    fullCursor = domMarker(p.lat, p.lon, { element: makeIcon("map-cursor map-cursor-lg") }).addTo(fullMap);
  } else {
    fullCursor.setLngLat([p.lon, p.lat]);
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
  // `attribution:true` affiche le crédit OSM (obligatoire) sans le badge « Leaflet » que
  // l'ancienne carte s'attribuait à tort. MapLibre lit l'attribution de la source topo.
  fullMap = createFicheMap("fullmap", { attribution: true });
  fullMap.on("load", () => {
    if (!isFullMapOpen()) return; // fermé pendant le chargement du style
    const line = drawTrackOn(fullMap, t.segments || t.track);
    addPoiMarkers(fullMap, t, { tooltips: true });
    // Le bandeau bas recouvre la carte : le cadrage doit en tenir compte, sinon le
    // départ ou l'arrivée se retrouve caché dessous.
    fullMap.fitBounds(line.getBounds(), {
      padding: { top: 60, left: 40, right: 40, bottom: (panel?.offsetHeight || 150) + 30 },
    });
    line.on("mousemove", (e) => {
      const km = fullProfile?.kmNear(e.lngLat.lat, e.lngLat.lng);
      if (km != null) fullProfile.setCursorKm(km);
    });
    line.on("mouseout", () => fullProfile?.setCursorKm(null));
  });

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
  markHandles = []; // les marqueurs de l'ancienne fiche meurent avec sa carte
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
        <button class="btn-ghost" id="btn-share-link">↗ Partager le lien</button>
        <button class="btn-ghost" id="btn-safety">🛟 Plan de marche</button>
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
  bindPoiSection(t);

  // Mini-carte : aperçu figé (gestes coupés), mais événements gardés pour le survol.
  miniMap = createFicheMap("mini-map", { inert: true });
  miniMap.on("load", () => {
    if (seq !== renderSeq) return; // une autre fiche s'est ouverte pendant le chargement
    const line = drawTrackOn(miniMap, t.segments || t.track, { weight: 3.5 });
    addPoiMarkers(miniMap, t);
    miniMap.fitBounds(line.getBounds(), { padding: 18 });
    // Sens carte → profil : longer le tracé sur la mini-carte déplace le curseur du
    // profil (l'autre sens passe par showOnMiniMap). Le profil arrive après (async) :
    // le handler lit `profile` au moment de l'événement, jamais à l'attache.
    line.on("mousemove", (e) => {
      const km = profile?.kmNear(e.lngLat.lat, e.lngLat.lng);
      if (km != null) profile.setCursorKm(km);
    });
    line.on("mouseout", () => profile?.setCursorKm(null));
  });

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
  document.getElementById("btn-share-link").addEventListener("click", () => shareTrail(t));
  document.getElementById("btn-itinerary").addEventListener("click", () => {
    switchTab("carte");
    // Sur mobile, réduire la feuille Explorer pour ne pas couvrir le tracé qu'on vient d'ouvrir.
    if (window.matchMedia("(max-width: 700px)").matches)
      document.getElementById("results-panel")?.classList.add("sheet-collapsed");
    // Sur la carte uniquement : la fiche ne doit pas se rouvrir par-dessus
    setTimeout(() => selectTrail(id, { openDetail: false }), 100);
  });
  document.getElementById("btn-follow").addEventListener("click", () => startNavigation(id));
  document.getElementById("btn-safety").addEventListener("click", () => {
    closeDetail();
    switchTab("reglages"); // la Sécurité (plan de marche) est fusionnée dans les Réglages
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
