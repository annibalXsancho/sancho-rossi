// Sancho Rossi — fiche itinéraire (page plein écran, façon AllTrails) + vue 3D + profil
import { state, catalogTrails, getTrail, trackOf, sampleTrack, haversineKm, saveNote, outingsFor } from "./state.js";
import { ensureElevation } from "./api.js";
import { createProfile } from "./profile.js";
import { loadWeatherTab } from "./weather.js";
import { geoPhoto, updateCardPhotos } from "./photos.js";
import { trailPhotos } from "./mapillary.js";
import { putMeta } from "./storage.js";
import {
  hidePreview, clearActiveTrack, createFicheMap, drawTrackOn, domMarker, makeIcon,
  FICHE_BASES, FICHE_OVERLAYS, setFicheBase, setFicheOverlay, enableTerrainOn,
} from "./map.js";
import { startCompass, stopCompass, shortestRotate } from "./compass.js";
import { renderList, selectTrail, toggleFavorite, downloadGPX, deleteImported, renameImported } from "./trails.js";
import { switchTab } from "./ui.js";
import { hasPack, buildPack } from "./offline.js";
import { createRouteWeather } from "./hikeweather.js";
import { createRouteConditions } from "./conditions.js";
import { moonPhase, sunTimes } from "./astro.js";
import { annotKind } from "./annotations.js";
import { SAC_LABEL, computeLoss, naismithHours, cumulativeKm } from "./metrics.js";
import { openOutingForm, outingsSectionHtml } from "./outings.js";
import { touchPrefs } from "./sync.js";
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
let routeCond = null; // bandeau conditions & nuit (S-V2-VIGIE-A)
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

// Lune + coucher/lever du jour pour un tracé bivouac — calcul local instantané
// (astro.js), pas d'écran « fiche bivouac » dédié : on greffe sur l'item existant.
function bivouacNightHtml(t) {
  if (!t.bivouac || !t.center) return "";
  const now = new Date();
  const moon = moonPhase(now);
  const { sunset, sunrise } = sunTimes(t.center[0], t.center[1], now);
  if (!sunset) return "";
  return `<br><span class="muted">${moon.emoji} ${moon.name} · coucher ${sunset.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}${sunrise ? ` · lever ${sunrise.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : ""}</span>`;
}

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

// Photos de terrain (Mapillary) : délégation posée une fois sur le conteneur — la
// bande se remplit plus tard (async), pas besoin de rebrancher à ce moment-là.
function bindPhotoSection() {
  const strip = document.getElementById("detail-photos");
  if (!strip) return;
  strip.addEventListener("click", (e) => {
    const btn = e.target.closest(".photo-thumb");
    if (btn) openPhotoLightbox(btn.dataset.full);
  });
}

function openPhotoLightbox(url) {
  const box = document.createElement("div");
  box.className = "photo-lightbox";
  box.innerHTML = `<img src="${url}" alt="Photo du sentier en plein écran">
    <button class="photo-lightbox-close" aria-label="Fermer">✕</button>`;
  const close = () => box.remove();
  box.addEventListener("click", (e) => { if (e.target === box || e.target.closest(".photo-lightbox-close")) close(); });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); }
  });
  document.body.appendChild(box);
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
  routeCond?.destroy();
  routeCond = null;
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

// ---------- Carte plein écran (clic sur la carte de la fiche) ----------
// La carte de la fiche est volontairement inerte (aperçu) ; l'exploration se fait ici :
// vue de consultation complète (référence Outdooractive) — calques, relief 3D, boussole,
// modification du tracé, et bandeau bas métriques + profil dépliable, synchronisé avec la
// carte dans les deux sens. Même contrat d'historique que la fiche : Échap, ✕ et le bouton
// retour ferment.
let fullMap = null;
let fullProfile = null;
let fullCursor = null;
let fullTrail = null;
let fullBounds = null;
let fullEles = null;
let full3D = false;
let profileOpen = false;
let fmNeedleDeg = 0;
let fmHeading = null;

// Le fond et les surcouches choisis ici survivent d'une fiche à l'autre : c'est une
// préférence de lecture (« je lis mes tracés en satellite »), pas un réglage par tracé.
// Lus à l'ouverture et non au chargement du module : map.js et detail.js s'importent en
// cercle (via ui.js), et toucher une constante de map.js pendant l'évaluation de ce
// module-ci la trouverait encore non initialisée.
const BASE_KEY = "sr-fiche-base";
const OVERLAY_KEY = "sr-fiche-overlays";
let fullBase = null;
let fullOverlays = null;

function readLayerPrefs() {
  if (fullBase == null) {
    const saved = localStorage.getItem(BASE_KEY);
    fullBase = FICHE_BASES.includes(saved) ? saved : "topo";
  }
  if (fullOverlays == null) {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(OVERLAY_KEY) || "[]") || []; } catch { saved = []; }
    fullOverlays = new Set(saved.filter((n) => FICHE_OVERLAYS.includes(n)));
  }
}

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

// Recadre le tracé en tenant compte du bandeau bas, qui recouvre la carte : sans cette
// marge, le départ ou l'arrivée se retrouve caché dessous. Rejoué à chaque dépliage du
// profil, puisque la hauteur du bandeau change.
function fitFullMap({ animate = false } = {}) {
  if (!fullMap || !fullBounds) return;
  const panel = document.getElementById("fullmap-panel");
  // Déplié sur un petit écran, le bandeau peut occuper plus de la moitié de la hauteur :
  // une marge basse plus grande que la carte ferait échouer le cadrage. On la plafonne,
  // quitte à laisser le tracé passer un peu sous le bandeau relevé.
  const mapH = fullmapEl?.clientHeight || window.innerHeight;
  const bottom = Math.min((panel?.offsetHeight || 150) + 30, Math.round(mapH * 0.5));
  fullMap.fitBounds(fullBounds, {
    padding: { top: 70, left: 40, right: 40, bottom },
    duration: animate ? 350 : 0,
  });
}

// Le profil se re-crée à chaque changement de hauteur : `createProfile` fixe sa géométrie
// au montage. Peu coûteux (un SVG), et cela garde le module sans état de repli.
function paintFullProfile() {
  const box = document.getElementById("fullmap-profile");
  if (!box || !fullEles) return;
  fullProfile?.destroy();
  const mobile = window.innerWidth < 700;
  fullProfile = createProfile(box, {
    eles: fullEles,
    track: fullTrail.mainline || trackOf(fullTrail),
    ways: fullTrail.ways,
    totalKm: fullTrail.distance,
    height: profileOpen ? (mobile ? 150 : 210) : (mobile ? 70 : 88),
    onHover: showOnFullMap,
    markers: poiProfileMarkers(fullTrail),
  });
}

// Abscisses en km du profil, recalées sur la distance annoncée — même méthode que
// `createProfile`, pour que les pentes se lisent sur la courbe affichée.
function fullProfileKm() {
  if (!fullEles?.length) return null;
  const track = fullTrail.mainline || trackOf(fullTrail);
  let pts = track && track.length === fullEles.length ? track
    : track ? sampleTrack(track, fullEles.length) : null;
  if (!pts || pts.length !== fullEles.length) return null;
  const cum = cumulativeKm(pts);
  const raw = cum[cum.length - 1];
  if (!raw) return null;
  const scale = fullTrail.distance > 0 ? fullTrail.distance / raw : 1;
  return cum.map((c) => c * scale);
}

// Fenêtre minimale de mesure d'une pente. Le profil ne compte qu'une centaine de points :
// en deçà de 250 m, un seul échantillon bruité produirait une pente spectaculaire et fausse.
const SLOPE_WIN_KM = 0.25;

// Montée moyenne la plus raide sur au moins SLOPE_WIN_KM. On s'arrête à la première
// fenêtre assez longue : au-delà, la pente se moyenne et retombe.
function maxClimbPct(eles, km) {
  let best = 0;
  for (let i = 0; i < eles.length - 1; i++) {
    for (let j = i + 1; j < eles.length; j++) {
      if (km[j] - km[i] < SLOPE_WIN_KM) continue;
      best = Math.max(best, ((eles[j] - eles[i]) / ((km[j] - km[i]) * 1000)) * 100);
      break;
    }
  }
  return best;
}

// Détail chiffré qui n'apparaît qu'une fois le profil déplié : ce que la courbe montre
// sans le dire (altitude basse, D−, amplitude, pentes, cotation). Replié, le bandeau garde
// les quatre métriques qui décident d'y aller ou non — et le détail ne les répète pas :
// distance, durée, D+ et altitude max sont déjà en haut, en permanence.
function fullDetailHtml() {
  if (!fullEles?.length) return "";
  const fr = (v) => Math.round(v).toLocaleString("fr-FR");
  const pct = (v) => `${v.toFixed(1).replace(".", ",")} %`;
  const min = Math.min(...fullEles);
  const max = Math.max(...fullEles);
  const gain = fullTrail.elevationGain ?? state.elev[fullTrail.id]?.gain;
  const loss = fullTrail.elevationLoss ?? computeLoss(fullEles);
  const sac = fullTrail.sac;
  const km = fullProfileKm();
  const dist = fullTrail.distance;
  const rows = [
    ["Altitude min", `${fr(min)} m`, null],
    ["Dénivelé négatif", `${fr(loss)} m`, null],
    ["Amplitude", `${fr(max - min)} m`, null],
    gain != null && dist > 0
      ? ["Dénivelé + / km", `${fr(gain / dist)} m`, "Dénivelé positif rapporté à la distance : la raideur générale du parcours"]
      : null,
    gain != null && dist > 0
      ? ["Pente moyenne", pct(((gain + loss) / (dist * 1000)) * 100), "Dénivelé cumulé (montées et descentes) rapporté à la distance"]
      : null,
    km ? ["Pente max", pct(maxClimbPct(fullEles, km)), "Montée la plus raide en moyenne sur 250 m, mesurée sur le profil échantillonné"] : null,
    // Le libellé complet de la cote irait à la ligne dans une cellule de grille : il passe
    // en infobulle, la cellule ne montre que le niveau — qui est ce qu'on lit d'un coup d'œil.
    sac?.level ? ["Cotation", `${sac.level}${sac.estimated ? " (est.)" : ""}`, SAC_LABEL[sac.level] || ""] : null,
  ].filter(Boolean);
  return rows
    .map(([k, v, hint]) =>
      `<div class="fm-detail-row"${hint ? ` title="${escapeHtml(hint)}"` : ""}><span>${k}</span><b>${escapeHtml(v)}</b></div>`
    )
    .join("");
}

function setProfileOpen(on) {
  profileOpen = on;
  const panel = document.getElementById("fullmap-panel");
  const toggle = document.getElementById("fullmap-toggle");
  const detail = document.getElementById("fullmap-detail");
  panel?.classList.toggle("expanded", on);
  toggle?.setAttribute("aria-expanded", on ? "true" : "false");
  // Sur mobile le libellé disparaît, la flèche reste seule : l'intitulé doit vivre
  // dans l'aria-label, et dire le geste plutôt que l'état.
  toggle?.setAttribute("aria-label", on ? "Replier le bandeau" : "Déplier le bandeau (profil et détails)");
  if (detail) {
    detail.innerHTML = on ? fullDetailHtml() : "";
    detail.classList.toggle("hidden", !on || !fullEles);
  }
  paintFullProfile();
  // Le bandeau a changé de hauteur : laisser le layout se poser avant de recadrer.
  requestAnimationFrame(() => fitFullMap({ animate: true }));
}

// ---------- Boussole de la vue plein écran ----------
// Même contrat que celle de la carte principale (js/map.js) : l'aiguille suit le capteur
// physique du téléphone, l'anneau pointillé n'apparaît que si la carte est pivotée et
// montre où est son nord ; le clic remet le nord.
function paintFmCompass() {
  const btn = document.getElementById("fm-compass");
  if (!btn || !fullMap) return;
  const needle = btn.querySelector(".compass-needle");
  const ring = btn.querySelector(".compass-ring");
  const target = fmHeading != null ? -fmHeading : -fullMap.getBearing();
  fmNeedleDeg = shortestRotate(fmNeedleDeg, target);
  if (needle) needle.style.transform = `rotate(${fmNeedleDeg}deg)`;
  const bearing = fullMap.getBearing();
  const rotated = Math.abs(bearing) > 0.5;
  if (ring) {
    ring.classList.toggle("hidden", !rotated);
    if (rotated) ring.style.transform = `rotate(${-bearing}deg)`;
  }
}

const onFmHeading = (h) => { fmHeading = h; requestAnimationFrame(paintFmCompass); };

// Bascule du relief. Même moteur que la carte principale (`enableTerrainOn`) : un seul
// rendu de relief dans le projet.
function setFull3D(on) {
  full3D = on;
  const btn = document.getElementById("fm-3d");
  btn?.classList.toggle("active", on);
  btn?.setAttribute("aria-pressed", on ? "true" : "false");
  if (!fullMap) return;
  if (on) {
    enableTerrainOn(fullMap);
    if (fullMap.getPitch() < 40) fullMap.easeTo({ pitch: 62, duration: 700 });
  } else {
    fullMap.setTerrain(null);
    try { fullMap.setSky({}); } catch { /* rien à retirer */ }
    if (fullMap.getPitch() > 0) fullMap.easeTo({ pitch: 0, duration: 500 });
  }
}

function paintFmLayerPanel() {
  document.querySelectorAll("[data-fmbase]").forEach((card) =>
    card.classList.toggle("active", card.dataset.fmbase === fullBase)
  );
  document.querySelectorAll("[data-fmov]").forEach((row) => {
    const on = fullOverlays.has(row.dataset.fmov);
    row.classList.toggle("active", on);
    const cb = row.querySelector("input[type=checkbox]");
    if (cb) cb.checked = on;
  });
}

function openFullMap(t) {
  if (isFullMapOpen()) return;
  fullmapEl.classList.remove("hidden");
  history.pushState({ srDetail: true, srFullmap: true }, "");

  readLayerPrefs();
  fullTrail = t;
  fullEles = null;
  fullBounds = null;
  full3D = false;
  profileOpen = false;
  fmHeading = null;
  document.getElementById("fullmap-title").textContent = t.name;

  const gain = t.elevationGain ?? state.elev[t.id]?.gain;
  const amax = t.altMax ?? state.elev[t.id]?.max;
  const fr = (v) => Math.round(v).toLocaleString("fr-FR");
  document.getElementById("fullmap-stats").innerHTML =
    `<div class="dock-stat big"><span>${t.distance}<small> km</small></span><label>Distance</label></div>` +
    `<div class="dock-stat big"><span>${t.duration}</span><label>Durée est.</label></div>` +
    `<div class="dock-stat"><span id="fm-gain">${gain != null ? fr(gain) : "—"}<small> m</small></span><label>Dénivelé +</label></div>` +
    `<div class="dock-stat"><span id="fm-amax">${amax != null ? fr(amax) : "—"}<small> m</small></span><label>Altitude max</label></div>`;

  setProfileOpen(false);
  paintFmLayerPanel();
  document.getElementById("fm-3d")?.classList.remove("active");
  document.getElementById("fm-3d")?.setAttribute("aria-pressed", "false");
  document.getElementById("fm-layers-panel")?.classList.add("hidden");
  document.getElementById("fm-layers")?.setAttribute("aria-expanded", "false");

  // `attribution:true` affiche le crédit OSM (obligatoire). `stack:true` déclare tous les
  // fonds d'un coup : le sélecteur de calques bascule ensuite des visibilités, sans jamais
  // reconstruire le style (donc sans perdre tracé, repères ni relief).
  fullMap = createFicheMap("fullmap", { attribution: true, stack: true, layer: fullBase, maxPitch: 80 });
  fullMap.on("load", () => {
    if (!isFullMapOpen()) return; // fermé pendant le chargement du style
    fullOverlays.forEach((n) => setFicheOverlay(fullMap, n, true));
    const line = drawTrackOn(fullMap, t.segments || t.track);
    addPoiMarkers(fullMap, t, { tooltips: true });
    fullBounds = line.getBounds();
    fitFullMap();
    line.on("mousemove", (e) => {
      const km = fullProfile?.kmNear(e.lngLat.lat, e.lngLat.lng);
      if (km != null) fullProfile.setCursorKm(km);
    });
    line.on("mouseout", () => fullProfile?.setCursorKm(null));
  });
  fullMap.on("rotate", paintFmCompass);
  fullMap.on("rotateend", paintFmCompass);
  paintFmCompass();
  startCompass(onFmHeading); // marche directement sur Android, sans geste requis

  ensureElevation(t)
    .then((eles) => {
      if (!isFullMapOpen()) return; // fermé pendant la requête
      fullEles = eles;
      paintFullProfile();
      const e = state.elev[t.id];
      const gEl = document.getElementById("fm-gain");
      const aEl = document.getElementById("fm-amax");
      if (e && gEl) gEl.innerHTML = `${e.gain.toLocaleString("fr-FR")}<small> m</small>`;
      if (e && aEl) aEl.innerHTML = `${e.max.toLocaleString("fr-FR")}<small> m</small>`;
    })
    .catch(() => {
      // Hors-ligne : la carte et les métriques suffisent — le bandeau ne montre pas un
      // cadre vide, il dit pourquoi il est vide.
      const box = document.getElementById("fullmap-profile");
      if (box) box.innerHTML = `<p class="muted fm-profile-empty">Profil indisponible hors connexion.</p>`;
    });
}

export function closeFullMap(fromPopstate = false) {
  if (!isFullMapOpen()) return;
  fullmapEl.classList.add("hidden");
  stopCompass(onFmHeading);
  fullProfile?.destroy();
  fullProfile = null;
  fullCursor = null;
  fullTrail = null;
  fullEles = null;
  fullBounds = null;
  if (fullMap) { fullMap.remove(); fullMap = null; }
  document.getElementById("fullmap-profile").innerHTML = "";
  document.getElementById("fullmap-detail").innerHTML = "";
  document.getElementById("fm-layers-panel")?.classList.add("hidden");
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
  window.SR3D?.destroy();
  window.SR3D = null;

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
      ${t.sac?.level ? `<span class="pill pill-sac" title="${t.sac.estimated ? "Cotation estimée (pente)" : "Cotation OSM"} · ${SAC_LABEL[t.sac.level] || ""}">${t.sac.level}${t.sac.estimated ? " (est.)" : ""}</span>` : ""}
      <span class="detail-location">📍 ${t.location}</span>
    </div>

    <div class="detail-media">
      <div class="mini-map-wrap" id="mini-map-wrap" title="Agrandir la carte" role="button" tabindex="0" aria-label="Ouvrir la carte en plein écran">
        <div id="mini-map"></div>
        <span class="mini-map-expand" aria-hidden="true">⤢</span>
      </div>
      <div class="detail-side">
        <div class="side-profile" id="side-profile">
          <p class="muted">Profil d'altitude réel — chargement…</p>
        </div>
        <div id="route-wx"></div>
        <div id="route-cond"></div>
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
        <button class="btn ${outingsFor(id).length ? "faved" : ""}" id="btn-plan-outing">${outingsFor(id).length ? "📅 Sortie planifiée" : "📅 Réserver une sortie"}</button>
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
      <div class="detail-photos-wrap hidden" id="detail-photos-wrap">
        <h3 class="section-title">Photos du sentier</h3>
        <div class="photo-strip" id="detail-photos"></div>
      </div>
      ${t.eau !== "—" ? `
      <h3 class="section-title">Infos terrain</h3>
      <div class="terrain-list">
        <div class="terrain-item"><span class="terrain-icon">💧</span><div><strong>Eau</strong><br>${t.eau}</div></div>
        <div class="terrain-item"><span class="terrain-icon">⛺</span><div><strong>Bivouac</strong><br>${t.bivouacSpot}${bivouacNightHtml(t)}</div></div>
        <div class="terrain-item"><span class="terrain-icon">🗓</span><div><strong>Période conseillée</strong><br>${t.periode}</div></div>
      </div>` : ""}
      ${poisSectionHtml(t)}
      ${outingsSectionHtml(t)}
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
        <p class="muted">Le tracé posé sur le relief réel. Deux doigts (ou clic droit) pour incliner et
        pivoter, pincer pour zoomer — ou laissez le survol vous emmener d'un bout à l'autre.</p>
        <button class="btn btn-primary" id="btn-load-3d">▶ Afficher le relief</button>
      </div>
      <div id="viewer3d" class="viewer3d hidden"></div>
      <div id="progress-row" class="progress-row hidden">
        <button class="btn f3d-play" id="btn-flyover" type="button">▶ Survol</button>
        <input type="range" id="track-progress" min="0" max="1000" value="0"
               aria-label="Position sur le tracé" />
        <span id="progress-info" class="progress-info">départ</span>
        <div class="f3d-layers" role="group" aria-label="Fond de carte">
          <button class="btn-ghost f3d-layer active" data-layer="satellite" type="button">Satellite</button>
          <button class="btn-ghost f3d-layer" data-layer="topo" type="button">Topo</button>
        </div>
        <button class="btn f3d-sun" id="btn-sun" type="button" aria-pressed="false">☀ Soleil</button>
      </div>
      <div class="sun-row hidden" id="sun-row">
        <div class="sun-controls">
          <input type="date" id="sun-date" class="sun-date" aria-label="Date" />
          <input type="range" id="sun-time" min="0" max="1439" step="5"
                 aria-label="Heure de la journée" />
          <span class="sun-read" id="sun-read"></span>
        </div>
        <p class="sun-depart" id="sun-depart"></p>
        <p class="sun-hint muted" id="sun-hint">Touchez un point du relief pour connaître son ensoleillement.</p>
        <div class="info-block sun-panel hidden" id="sun-panel"></div>
      </div>
    </div>`;

  detailPanel.classList.remove("hidden");
  detailPanel.scrollTop = 0;
  bindPoiSection(t);
  bindPhotoSection();

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
      routeCond = createRouteConditions(document.getElementById("route-cond"), t, {
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
      routeCond = createRouteConditions(document.getElementById("route-cond"), t, {
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

  // Photo réelle du lieu pour les itinéraires du catalogue (article Wikipédia le plus
  // proche). La fiche n'a plus de bandeau photo — la carte a pris sa place — mais les
  // vignettes de la liste, elles, s'en servent : on continue donc de la relever et de la
  // mettre en cache, sans rien afficher ici.
  if (t.osm && state.photos[t.id] === undefined) {
    geoPhoto(t)
      .then((url) => {
        state.photos[t.id] = url;
        putMeta("photos", state.photos);
        if (url) updateCardPhotos(t);
      })
      .catch(() => {});
  }

  // Photos de terrain sur le corridor (Mapillary) — la section reste absente si le
  // tracé n'a pas de géométrie exploitable, si hors-ligne, ou si rien n'est trouvé.
  trailPhotos(t)
    .then((photos) => {
      if (!photos.length || seq !== renderSeq) return;
      const wrap = document.getElementById("detail-photos-wrap");
      const strip = document.getElementById("detail-photos");
      if (!wrap || !strip) return;
      strip.innerHTML = photos
        .map(
          (p) => `<button class="photo-thumb" data-full="${p.full}" aria-label="Agrandir la photo">
            <img src="${p.thumb}" alt="Photo du sentier" loading="lazy">
          </button>`
        )
        .join("");
      wrap.classList.remove("hidden");
    })
    .catch(() => {});

  document.getElementById("btn-detail-fav").addEventListener("click", () => toggleFavorite(id));
  document.getElementById("btn-offline").addEventListener("click", () => downloadPack(t, id));
  document.getElementById("btn-plan-outing").addEventListener("click", () => {
    const existing = outingsFor(id)[0] || null;
    openOutingForm(t, { existing }).then((rec) => { if (rec || existing) renderDetail(id); });
  });
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
  document.getElementById("btn-follow").addEventListener("click", async () => {
    const { initNav, startNavigation } = await import("./nav.js");
    initNav();
    startNavigation(id);
  });
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
      touchPrefs();
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
    const { open } = await import("./fiche3d.js");
    container.classList.remove("hidden");

    const row = document.getElementById("progress-row");
    const slider = document.getElementById("track-progress");
    const info = document.getElementById("progress-info");
    const playBtn = document.getElementById("btn-flyover");
    const show = (r) => {
      if (!r) return;
      info.textContent = `${r.km.toFixed(1)} km${r.alt != null ? ` · ${Math.round(r.alt)} m` : ""}`;
    };

    // Points d'accroche du survol, garnis par le mode soleil quand il est allumé (il est
    // lié APRÈS l'ouverture de la vue, d'où le relais mutable plutôt qu'un paramètre).
    const fly = { beforePlay: null, onFrame: null, onStop: null };

    // 2 000 points, et non 300 : la bille suit CE fil pendant que `drawTrackOn` dessine la
    // géométrie complète. À 300 points, un tracé de 20 km n'a plus qu'un point tous les
    // 67 m — les lacets sont coupés en travers et la bille quitte visiblement le tracé
    // dessiné. `sampleTrack` prélève par indices régulièrement espacés : la densité peut
    // changer sans rien casser, l'altitude se lisant par FRACTION de parcours.
    const view = await open(container, trail, sampleTrack(trail.mainline || trackOf(trail), 2000), eles, {
      // Pendant le survol c'est la vue qui mène : la jauge et le libellé la suivent.
      onFrame: (r) => {
        slider.value = Math.round(r.f * 1000);
        show(r);
        fly.onFrame?.(r);
        if (!r.playing) { playBtn.textContent = "▶ Survol"; fly.onStop?.(); }
      },
    });
    window.SR3D = view;
    intro.classList.add("hidden");

    row.classList.remove("hidden");
    slider.value = 0;
    slider.addEventListener("input", () => {
      const was = view.playing();
      playBtn.textContent = "▶ Survol";
      show(view.setProgress(Number(slider.value) / 1000));
      if (was) fly.onStop?.(); // une seule fois, à la coupure — pas à chaque cran du glissé
    });
    playBtn.addEventListener("click", async () => {
      if (view.playing()) { view.pause(); playBtn.textContent = "▶ Survol"; fly.onStop?.(); return; }
      // Le mode soleil pré-calcule sa course avant de lâcher le survol : la payer en vol
      // hacherait l'animation (cf. prepareCourse dans sunview.js).
      if (fly.beforePlay) {
        playBtn.disabled = true;
        playBtn.textContent = "⏳ Course du soleil…";
        try { await fly.beforePlay(); } catch { /* le survol part quand même, soleil figé */ }
        playBtn.disabled = false;
      }
      playBtn.textContent = view.toggle() ? "⏸ Pause" : "▶ Survol";
    });
    row.querySelectorAll(".f3d-layer").forEach((b) => {
      b.addEventListener("click", () => {
        row.querySelectorAll(".f3d-layer").forEach((o) => o.classList.toggle("active", o === b));
        view.setLayer(b.dataset.layer);
      });
    });
    bindSunMode(view, trail, fly);
    show(view.setProgress(0));
  } catch (err) {
    intro.querySelector("#btn-load-3d").textContent = "▶ Réessayer";
    toast(`Vue 3D indisponible : ${err.message}`, { type: "error" });
  }
}

// ---------- Mode soleil de la vue 3D (S-SOLEIL) ----------
// « Coucher 21 h 05 » ne veut rien dire dans une combe : le relief mange le soleil bien
// avant. Le mode confronte la course du jour aux crêtes réelles — ombres portées sur le
// terrain, disque solaire dans le ciel, et plage d'ensoleillement du point qu'on touche.

const dayMinutes = (d) => d.getHours() * 60 + d.getMinutes();
const atMin = (day, min) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, Math.round(min));

// Date de départ : celle de la sortie prévue sur ce tracé si elle existe (on prépare une
// sortie, on ne consulte pas la météo d'aujourd'hui), sinon aujourd'hui.
function defaultSunDate(trail) {
  const today = new Date().toISOString().slice(0, 10);
  const next = outingsFor(trail.id).find((o) => o.date && o.date >= today);
  if (!next) return new Date();
  const [y, m, d] = next.date.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function sunPanelHtml(r) {
  const { hhmm, duration, towards } = sunFmt;
  const theo = `sans le relief : ${hhmm(r.theoretical.sunrise)} → ${hhmm(r.theoretical.sunset)}`;
  // Cadran + légende : le même bloc dans les deux cas, la mise en page les met côte à côte
  // du texte sur large écran (`.sun-body`) et l'un sous l'autre sur téléphone.
  const dial = `<figure class="sun-dial-wrap">${sunDial(r)}
      <figcaption class="sun-dial-cap muted">la course du jour vue d'ici · le relief en sombre</figcaption>
    </figure>`;
  const head = `<div class="info-block-head"><span class="eyebrow">Soleil ici</span>
      <span class="sun-ele">${Math.round(r.ground).toLocaleString("fr-FR")} m</span></div>`;

  if (!r.intervals.length) {
    return `${head}<div class="sun-body"><div class="sun-text">
        <p class="sun-window sun-none">Aucun soleil ce jour-là</p>
        <p class="sun-sub">Le relief le masque de bout en bout</p>
        <p class="info-block-foot muted">${theo}</p>
      </div>${dial}</div>`;
  }
  const spans = r.intervals.map((i) => `${hhmm(i.from)} → ${hhmm(i.to)}`).join("  +  ");
  // Coupures : une arête isolée peut trancher la journée en deux. C'est exactement ce
  // qu'aucune application ne dit, donc ça se dit ici.
  const gaps = r.intervals
    .slice(1)
    .map((i, k) => `coupure ${hhmm(r.intervals[k].to)} → ${hhmm(i.from)}`)
    .join(" · ");
  const last = r.intervals[r.intervals.length - 1];
  return `${head}<div class="sun-body"><div class="sun-text">
      <p class="sun-window">${spans}</p>
      <p class="sun-sub">${duration(r.totalMin)} de soleil · disparaît derrière le relief
        ${towards(last.toAz)}</p>
      ${gaps ? `<p class="sun-sub sun-gap">${gaps}</p>` : ""}
      <p class="info-block-foot muted">${theo}</p>
    </div>${dial}</div>`;
}

// Les fonctions de mise en forme et le cadran viennent de sunview.js, chargé à la demande :
// affectés à l'activation du mode, lus par sunPanelHtml.
let sunFmt = null;
let sunDial = null;

// Horloge d'un nombre de minutes depuis minuit. Le modulo n'est pas cosmétique : une
// arrivée calculée à 25 h 10 doit se lire « 01 h 10 », le survol pouvant déborder sur le
// lendemain sur une longue course partie tard.
const clockLabel = (min) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")} h ${String(m % 60).padStart(2, "0")}`;
};

function bindSunMode(view, trail, fly) {
  const btn = document.getElementById("btn-sun");
  const rowEl = document.getElementById("sun-row");
  const dateEl = document.getElementById("sun-date");
  const timeEl = document.getElementById("sun-time");
  const readEl = document.getElementById("sun-read");
  const hintEl = document.getElementById("sun-hint");
  const panelEl = document.getElementById("sun-panel");
  const departEl = document.getElementById("sun-depart");
  const playBtn = document.getElementById("btn-flyover");
  if (!btn) return;

  let sun = null;
  let day = defaultSunDate(trail);
  let timer = null;
  let course = null, departMin = 0;
  let hooked = false; // le démontage n'est greffé qu'une fois, quel que soit le nombre de bascules

  const setRead = (s, min) => {
    readEl.textContent = clockLabel(min) +
      (s.altitude > 0
        ? ` · soleil ${Math.round(s.altitude)}° ${sunFmt.towards(s.azimuth)}`
        : " · soleil couché");
  };

  // Durée de marche estimée : c'est elle, et non la durée du survol (25–70 s), qui règle
  // la course du soleil — on veut voir le vrai soleil d'une vraie journée de marche.
  const hikeHours = () => {
    const gain = trail.elevationGain ?? state.elev[trail.id]?.gain ?? 0;
    return Math.max(0.5, naismithHours(trail.distance || 0, gain) || 1);
  };

  // Le curseur horaire EST l'heure de départ : pas de contrôle supplémentaire à
  // comprendre, juste la conséquence affichée en clair sous lui.
  function showDepart() {
    const h = hikeHours();
    const dep = Number(timeEl.value);
    // Durée écrite en heures ici, et non via `fmtDuration` : au-delà de 9 h celle-ci bascule
    // en jours (« 1 j (est.) »), ce qui contredirait le « 05 h 00 → 14 h 43 » de la même
    // ligne — le survol, lui, déroule une seule journée de marche.
    const walk = `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
    departEl.textContent =
      `Départ ${clockLabel(dep)} → arrivée ≈ ${clockLabel(dep + h * 60)} · ${walk} de marche`;
  }

  // Bornes du curseur = la journée utile. Laisser glisser en pleine nuit ne montrerait
  // qu'un écran noir sur les trois quarts de la course.
  function frameDay() {
    const { civilDawn, civilDusk } = sunTimes(trail.center[0], trail.center[1], day);
    timeEl.min = civilDawn ? Math.max(0, dayMinutes(civilDawn) - 20) : 0;
    timeEl.max = civilDusk ? Math.min(1439, dayMinutes(civilDusk) + 20) : 1439;
    dateEl.value = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const now = new Date();
    const sameDay = now.toDateString() === day.toDateString();
    timeEl.value = String(
      Math.min(Number(timeEl.max), Math.max(Number(timeEl.min), sameDay ? dayMinutes(now) : 13 * 60))
    );
  }

  function apply() {
    const min = Number(timeEl.value);
    const s = sun.setTime(atMin(day, min));
    if (s) setRead(s, min);
  }

  async function refreshProbe() {
    if (!sun?.hasProbe()) return;
    const r = await sun.reprobe(atMin(day, Number(timeEl.value)));
    if (r) panelEl.innerHTML = sunPanelHtml(r);
  }

  // ----- Le survol déroule la journée -----
  // Lancer le survol, c'est marcher : le soleil parcourt la durée réelle de la course
  // entre l'heure de départ et l'arrivée estimée.
  function hookFlyover() {
    fly.beforePlay = async () => {
      if (!sun) return;
      departMin = Number(timeEl.value);
      const h = hikeHours();
      // Un pas toutes les 10 minutes simulées, borné : en deçà la course saccade, au-delà
      // on paie un pré-calcul plus long que le survol lui-même.
      const steps = Math.round(Math.min(40, Math.max(6, (h * 60) / 10)));
      course?.dispose();
      course = await sun.prepareCourse(atMin(day, departMin), atMin(day, departMin + h * 60), steps);
    };
    fly.onFrame = (r) => {
      if (!sun || !course) return;
      const min = departMin + r.f * hikeHours() * 60;
      const s = course.applyAt(atMin(day, min));
      if (s) setRead(s, min); // l'heure VIVANTE ; le curseur, lui, reste sur le départ
    };
    // À l'arrêt, l'affichage doit redire la vérité du curseur, sinon le libellé annonce
    // une heure que plus aucun réglage ne porte.
    fly.onStop = () => { if (sun) apply(); };
  }

  function unhookFlyover() {
    fly.beforePlay = fly.onFrame = fly.onStop = null;
    course?.dispose();
    course = null;
  }

  async function enable() {
    btn.disabled = true;
    btn.textContent = "⏳ Relief…";
    try {
      const mod = await import("./sunview.js");
      sunFmt = { hhmm: mod.hhmm, duration: mod.duration, towards: mod.towards };
      sunDial = (r) => mod.dialSvg(r.profile, r.path, dayMinutes(atMin(day, Number(timeEl.value))));
      sun = await mod.attachSun(view, sampleTrack(trail.mainline || trackOf(trail), 300), {
        onProbe: (r) => {
          if (r?.pending) { panelEl.classList.remove("hidden"); panelEl.innerHTML = `<p class="muted">Lecture du relief…</p>`; return; }
          if (!r) { panelEl.classList.add("hidden"); hintEl.classList.remove("hidden"); return; }
          hintEl.classList.add("hidden");
          panelEl.classList.remove("hidden");
          panelEl.innerHTML = sunPanelHtml(r);
        },
      });
      // La vue 3D est détruite par renderDetail comme par closeDetail, toutes deux via
      // `window.SR3D.destroy()` : on s'y greffe plutôt que d'ajouter un point de sortie
      // à tenir à jour dans deux endroits. Les couches partent AVANT `map.remove()`.
      // Une seule fois : réemballer à chaque bascule empilerait les fermetures.
      if (!hooked) {
        hooked = true;
        const teardown = view.destroy.bind(view);
        view.destroy = () => { try { sun?.destroy(); } catch {} sun = null; teardown(); };
      }

      frameDay();
      apply();
      showDepart();
      hookFlyover();
      rowEl.classList.remove("hidden");
      btn.setAttribute("aria-pressed", "true");
      btn.classList.add("active");
    } catch (err) {
      toast(`Soleil indisponible : ${err.message}`, { type: "error" });
    } finally {
      btn.disabled = false;
      btn.textContent = "☀ Soleil";
    }
  }

  btn.addEventListener("click", () => {
    if (!sun) return enable();
    // Extinction : on rend la vue 3D telle qu'elle était, sans ombres ni sonde.
    unhookFlyover();
    sun.destroy();
    sun = null;
    rowEl.classList.add("hidden");
    panelEl.classList.add("hidden");
    hintEl.classList.remove("hidden");
    btn.setAttribute("aria-pressed", "false");
    btn.classList.remove("active");
  });

  // Glissé du curseur : le recalcul d'ombres (~40 ms) est débounçé pour que le geste
  // reste au fil du doigt, jamais saccadé par un calcul par image.
  timeEl.addEventListener("input", () => {
    if (!sun) return;
    // Régler l'heure de départ pendant un survol, ce serait deux pilotes sur la même
    // horloge : le survol s'arrête, comme il le fait déjà quand on glisse la jauge.
    if (view.playing()) { view.pause(); if (playBtn) playBtn.textContent = "▶ Survol"; }
    showDepart();
    clearTimeout(timer);
    timer = setTimeout(apply, 60);
  });
  timeEl.addEventListener("change", () => sun && refreshProbe());

  dateEl.addEventListener("change", () => {
    if (!sun || !dateEl.value) return;
    const [y, m, d] = dateEl.value.split("-").map(Number);
    day = new Date(y, m - 1, d);
    frameDay();
    apply();
    showDepart();
    refreshProbe();
  });
}

// Téléchargement d'un pack « pour le terrain » depuis la fiche. La fiche peut se
// re-rendre pendant l'opération (auto-save d'un OSM → renderAll) : on re-cible donc
// toujours le bouton par son id pour refléter la progression sur l'élément visible.
async function downloadPack(t, id) {
  if (hasPack(id)) { closeDetail(); switchTab("reglages"); return; }
  const { askPackOptions } = await import("./packdialog.js");
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
  window.SR3D?.destroy();
  window.SR3D = null;
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

  // ---------- Contrôles de la vue plein écran ----------
  // Câblés une fois pour toutes sur des éléments statiques : ouvrir une autre fiche ne
  // rebranche rien, les poignées lisent `fullMap`/`fullTrail` au moment du clic.
  const layersBtn = document.getElementById("fm-layers");
  const layersPanel = document.getElementById("fm-layers-panel");
  layersBtn?.addEventListener("click", () => {
    const open = layersPanel.classList.toggle("hidden") === false;
    layersBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });
  // Un clic sur la carte referme le sélecteur : pas de panneau qui traîne au-dessus du
  // tracé qu'on cherche justement à regarder.
  document.getElementById("fullmap")?.addEventListener("pointerdown", () => {
    layersPanel?.classList.add("hidden");
    layersBtn?.setAttribute("aria-expanded", "false");
  });

  const pickBase = (name) => {
    readLayerPrefs();
    fullBase = name;
    localStorage.setItem(BASE_KEY, name);
    if (fullMap) setFicheBase(fullMap, name);
    paintFmLayerPanel();
  };
  document.querySelectorAll("[data-fmbase]").forEach((card) => {
    const thumb = card.querySelector(".layer-thumb");
    thumb?.addEventListener("click", () => pickBase(card.dataset.fmbase));
    thumb?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickBase(card.dataset.fmbase); }
    });
  });
  document.querySelectorAll("[data-fmov]").forEach((row) => {
    row.querySelector("input[type=checkbox]")?.addEventListener("change", (e) => {
      readLayerPrefs();
      const name = row.dataset.fmov;
      if (e.target.checked) fullOverlays.add(name); else fullOverlays.delete(name);
      localStorage.setItem(OVERLAY_KEY, JSON.stringify([...fullOverlays]));
      if (fullMap) setFicheOverlay(fullMap, name, e.target.checked);
      paintFmLayerPanel();
    });
  });

  document.getElementById("fm-3d")?.addEventListener("click", () => setFull3D(!full3D));

  document.getElementById("fm-compass")?.addEventListener("click", () => {
    if (!fullMap) return;
    startCompass(onFmHeading); // geste utilisateur : couvre la demande de permission iOS
    if (Math.abs(fullMap.getBearing()) > 0.5 || fullMap.getPitch() > 0.5) {
      fullMap.easeTo({ bearing: 0, pitch: full3D ? 62 : 0, duration: 300 });
    }
  });

  document.getElementById("fm-edit")?.addEventListener("click", async () => {
    if (!fullTrail) return;
    const t = fullTrail;
    const { openPlannerForEdit } = await import("./planner.js");
    openPlannerForEdit(t); // referme fiche et carte, puis ouvre le planificateur
  });

  // Profil : le bouton du bandeau et le profil lui-même déplient. Replié il reste
  // survolable (curseur lié à la carte) ; c'est le clic qui l'agrandit.
  document.getElementById("fullmap-toggle")?.addEventListener("click", () => setProfileOpen(!profileOpen));
  document.getElementById("fullmap-profile")?.addEventListener("click", () => {
    if (!profileOpen) setProfileOpen(true);
  });
}
