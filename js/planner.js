// Sancho Rossi — planificateur d'itinéraires (S-PLAN-A), remplace builder.js
//
// Rupture de modèle avec l'ancien traceur : `waypoints` est la SOURCE DE VÉRITÉ
// UNIQUE et toute mutation (ajout, déplacement, réordonnancement, suppression,
// inversion) recalcule l'itinéraire ENTIER en un seul appel BRouter.
//
// builder.js routait par paires : chaque clic reliait le nouveau point au précédent
// et empilait une « étape », sans jamais recalculer. C'est ce qui rendait tout le
// reste impossible — supprimer un point du milieu retirait l'étape mais laissait les
// waypoints désynchronisés, et l'annulation devait deviner quoi dépiler. Ici,
// réordonner / déplacer / supprimer sont le même geste : muter le tableau, re-router.
//
// Périmètre A : waypoints éditables, routage, métriques (dist / durée / D+ / D− /
// SAC), sauvegarde first-class. Le profil interactif (survol lié à la carte, zoom au
// glisser, coloration par revêtement) et annuler/refaire sont le périmètre B.
import { state } from "./state.js";
import { map, addMarker, drawTrack } from "./map.js";
import { renderAll, selectTrail } from "./trails.js";
import { closeDetail } from "./detail.js";
import { saveTraces } from "./storage.js";
import { brouterRoute } from "./brouter.js";
import { createGeoSuggest } from "./geosearch.js";
import { createProfile } from "./profile.js";
import { createRouteWeather } from "./hikeweather.js";
import { ANNOT_KINDS, annotKind, ANNOT_NEAR_M, trackLocator } from "./annotations.js";
import {
  computeGain, computeLoss, naismithHours, fmtDuration, sacRating, SAC_LABEL,
} from "./metrics.js";

const REROUTE_DEBOUNCE_MS = 250; // coalesce les éditions rapprochées (glisser, réordonner)
const HISTORY_MAX = 60;

export const planner = {
  active: false,
  waypoints: [],   // [{ id, lat, lon, name }] — ordre de passage, source de vérité
  routed: null,    // { track, eles, distance, ascend, ways, fallback? }
  routing: false,
  seq: 0,
  layer: L.layerGroup(),
  markers: new Map(),
  controller: null,
  timer: null,
  suggest: null,
  profile: null,   // instance de profile.js (vignette du panneau)
  wx: null,        // bandeau météo à l'heure de passage (S-METEO)
  wxTimer: null,   // débounce : pas d'appel Open-Meteo à chaque retouche de tracé
  cursor: null,    // marqueur de position, piloté par le survol du profil
  history: [[]],   // instantanés de `waypoints` — l'état vide est le fond de pile
  hIndex: 0,
  // Repères personnels (S-PLAN-C). Hors historique : défaire un point de passage ne
  // doit pas emporter le point d'eau qu'on vient de noter — vies séparées.
  annots: [],      // [{ id, kind, lat, lon, note }]
  annotLayer: L.layerGroup(),
  annotMarkers: new Map(),
  annotating: false, // le prochain clic carte pose un repère, pas un waypoint
  aSeq: 0,
  locate: null,    // (lat, lon) → { km, offM, index } sur le tracé routé courant
};

const el = (id) => document.getElementById(id);

// A, B, C… puis 27, 28… (au-delà de Z, la lettre n'aide plus personne)
const letterOf = (i) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

// ---------- Historique (annuler / refaire) ----------
// On mémorise la SUITE DE POINTS, pas le tracé routé : c'est l'entrée utilisateur, la
// seule chose que l'utilisateur a « faite » et veut défaire. Le tracé s'en redéduit par
// un reroute — annuler puis refaire relance donc BRouter, ce qui est correct (l'état
// est reconstruit, jamais rejoué depuis un cache potentiellement périmé).
const snapshot = () => planner.waypoints.map((w) => ({ ...w }));

// Appelée APRÈS chaque mutation initiée par l'utilisateur. Tronque la branche « refaire »
// (on repart d'un état intermédiaire → le futur qu'on avait n'existe plus).
function commit() {
  planner.history.length = planner.hIndex + 1;
  planner.history.push(snapshot());
  if (planner.history.length > HISTORY_MAX) planner.history.shift();
  planner.hIndex = planner.history.length - 1;
}

function restore(snap) {
  planner.waypoints = snap.map((w) => ({ ...w }));
  const maxSeq = planner.waypoints.reduce((m, w) => Math.max(m, +String(w.id).slice(1) || 0), 0);
  planner.seq = Math.max(planner.seq, maxSeq); // pas de collision d'id après un ajout post-annulation
  redraw();
  reroute();
}

function undo() {
  if (planner.hIndex === 0) return;
  restore(planner.history[--planner.hIndex]);
}

function redo() {
  if (planner.hIndex >= planner.history.length - 1) return;
  restore(planner.history[++planner.hIndex]);
}

// ---------- Repères personnels (S-PLAN-C) ----------
// Le clic carte est AMBIGU quand le planificateur est ouvert : point de passage ou
// repère ? Le mode « annoter » (bouton du panneau) lève l'ambiguïté — armé, le
// prochain clic pose un repère, puis le mode retombe : pas d'état modal qui colle.
export function plannerMapClick(latlng, name = null) {
  if (planner.annotating) { openAnnotCreate(latlng, name); return; }
  plannerAddPoint(latlng, name);
}

function setAnnotating(on) {
  planner.annotating = on;
  document.body.classList.toggle("plan-annotating", on);
  el("plan-annot").classList.toggle("active", on);
  el("plan-annot-hint").classList.toggle("hidden", !on);
}

// Étape 1 — choisir le type : le clic sur une icône CRÉE le repère (un geste), la
// note se saisit dans la foulée via la bulle d'édition qui s'ouvre aussitôt.
function openAnnotCreate(latlng, presetNote = null) {
  setAnnotating(false);
  const div = document.createElement("div");
  div.className = "annot-pop";
  div.innerHTML =
    `<div class="eyebrow annot-pop-title">Nouveau repère</div>` +
    `<div class="annot-kinds">` +
    Object.entries(ANNOT_KINDS)
      .map(([k, d]) => `<button type="button" class="annot-kind" data-kind="${k}"><span>${d.icon}</span>${d.label}</button>`)
      .join("") +
    `</div>`;
  div.addEventListener("click", (e) => {
    const b = e.target.closest("[data-kind]");
    if (!b) return;
    map.closePopup();
    addAnnot(latlng, b.dataset.kind, presetNote);
  });
  L.popup({ className: "annot-popup", offset: [0, -6] }).setLatLng(latlng).setContent(div).openOn(map);
}

function addAnnot(latlng, kind, note) {
  const a = { id: `a${++planner.aSeq}`, kind, lat: latlng.lat, lon: latlng.lng, note: note || "" };
  planner.annots.push(a);
  drawAnnots();
  renderAnnots();
  openAnnotEdit(a);
}

// Étape 2 / réouverture — bulle d'édition ancrée au marqueur : changer le type,
// écrire la note (enregistrée à la frappe : rien à valider), ou supprimer.
function openAnnotEdit(a) {
  const marker = planner.annotMarkers.get(a.id);
  if (!marker) return;
  const div = document.createElement("div");
  div.className = "annot-pop";
  div.innerHTML =
    `<div class="annot-kinds annot-kinds-row">` +
    Object.entries(ANNOT_KINDS)
      .map(([k, d]) => `<button type="button" class="annot-kind annot-kind-sm${k === a.kind ? " sel" : ""}" data-kind="${k}" title="${d.label}">${d.icon}</button>`)
      .join("") +
    `</div>` +
    `<input class="annot-note" type="text" maxlength="120" placeholder="${annotKind(a.kind).label} — ajouter une note…" value="${escapeHtml(a.note)}" />` +
    `<div class="annot-pop-foot">` +
    `<button type="button" class="btn-ghost btn-ghost-danger annot-del">Supprimer</button>` +
    `<button type="button" class="btn annot-ok">OK</button>` +
    `</div>`;
  const input = div.querySelector(".annot-note");
  input.addEventListener("input", () => { a.note = input.value.trim(); renderAnnots(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") map.closePopup(); });
  div.addEventListener("click", (e) => {
    const kindBtn = e.target.closest("[data-kind]");
    if (kindBtn) {
      a.kind = kindBtn.dataset.kind;
      div.querySelectorAll("[data-kind]").forEach((b) => b.classList.toggle("sel", b.dataset.kind === a.kind));
      input.placeholder = `${annotKind(a.kind).label} — ajouter une note…`;
      marker.setIcon(annotIconOf(a));
      renderAnnots();
      return;
    }
    if (e.target.closest(".annot-del")) { map.closePopup(); removeAnnot(a.id); return; }
    if (e.target.closest(".annot-ok")) map.closePopup();
  });
  const pop = L.popup({ className: "annot-popup", offset: [0, -16] })
    .setLatLng(marker.getLatLng()).setContent(div).openOn(map);
  setTimeout(() => input.focus(), 60);
  return pop;
}

function removeAnnot(id) {
  planner.annots = planner.annots.filter((x) => x.id !== id);
  drawAnnots();
  renderAnnots();
}

const annotIconOf = (a) =>
  L.divIcon({
    className: "plan-annot",
    html: `<span class="plan-annot-i">${annotKind(a.kind).icon}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });

function drawAnnots() {
  planner.annotLayer.clearLayers();
  planner.annotMarkers.clear();
  for (const a of planner.annots) {
    const m = L.marker([a.lat, a.lon], { draggable: true, icon: annotIconOf(a) });
    m.on("click", (e) => { L.DomEvent.stop(e); openAnnotEdit(a); });
    m.on("dragend", () => {
      const ll = m.getLatLng();
      a.lat = ll.lat;
      a.lon = ll.lng;
      renderAnnots(); // le km le long du tracé a changé, la liste et le profil suivent
    });
    planner.annotLayer.addLayer(m);
    planner.annotMarkers.set(a.id, m);
  }
}

// Repères projetés sur le tracé courant : km + écart. Au-delà d'ANNOT_NEAR_M le
// repère reste listé mais « hors itinéraire » — sans km inventé ni marque de profil.
function locatedAnnots() {
  return planner.annots.map((a) => {
    const p = planner.locate?.(a.lat, a.lon) || null;
    return { a, km: p && p.offM <= ANNOT_NEAR_M ? p.km : null, index: p?.index ?? null };
  });
}

// Heures de marche jusqu'au repère (Naismith partiel) : c'est la question que pose
// un « objectif dodo » — à quelle heure de marche j'y suis, pas juste à quel km.
function hoursToKm(km, index) {
  const r = planner.routed;
  if (km == null || !r?.eles || index == null) return null;
  return naismithHours(km, computeGain(r.eles.slice(0, index + 1)) || 0);
}

function profileMarkers() {
  return locatedAnnots()
    .filter((x) => x.km != null)
    .map((x) => ({ km: x.km, icon: annotKind(x.a.kind).icon, label: x.a.note || annotKind(x.a.kind).label }));
}

function renderAnnots() {
  const box = el("plan-annots");
  const items = locatedAnnots()
    .sort((p, q) => (p.km ?? Infinity) - (q.km ?? Infinity));
  if (!items.length) {
    box.innerHTML = "";
  } else {
    box.innerHTML = items
      .map(({ a, km, index }) => {
        const d = annotKind(a.kind);
        const h = hoursToKm(km, index);
        const meta = [
          a.note ? d.label : null,
          km != null ? `km ${km.toFixed(1).replace(".", ",")}` : (planner.routed && !planner.routed.fallback ? "hors itinéraire" : null),
          h != null ? `≈ ${fmtDuration(h)} de marche` : null,
        ].filter(Boolean).join(" · ");
        return `<div class="annot-row" data-a="${a.id}">
          <span class="annot-ic">${d.icon}</span>
          <div class="annot-body">
            <span class="annot-name">${escapeHtml(a.note || d.label)}</span>
            ${meta ? `<span class="annot-meta">${escapeHtml(meta)}</span>` : ""}
          </div>
          <button class="annot-rm" data-arm="${a.id}" title="Supprimer ce repère" aria-label="Supprimer">✕</button>
        </div>`;
      })
      .join("");
  }
  planner.profile?.setMarkers(profileMarkers());
}

// ---------- Mutations (toutes passent par reroute) ----------
export function plannerAddPoint(latlng, name = null) {
  planner.waypoints.push({
    id: `w${++planner.seq}`,
    lat: latlng.lat,
    lon: latlng.lng,
    name,
  });
  commit();
  redraw();
  reroute();
}

// Insertion d'un point SUR le tracé : on le glisse entre les deux waypoints dont le
// segment routé passe au plus près du clic. Sans ça, ajouter un détour au milieu d'un
// long itinéraire obligeait à tout réordonner à la main.
function insertPointAt(latlng) {
  const wp = { id: `w${++planner.seq}`, lat: latlng.lat, lon: latlng.lng, name: null };
  const at = nearestLegIndex(latlng);
  if (at == null) planner.waypoints.push(wp);
  else planner.waypoints.splice(at, 0, wp);
  commit();
  redraw();
  reroute();
}

// Index d'insertion (1…n-1) : le point du tracé routé le plus proche du clic, ramené
// au segment de waypoints qui le contient. null si moins de deux waypoints.
function nearestLegIndex(latlng) {
  const wps = planner.waypoints;
  const track = planner.routed?.track;
  if (wps.length < 2 || !track?.length) return null;
  let bi = 0, bd = Infinity;
  for (let i = 0; i < track.length; i++) {
    const d = (track[i][0] - latlng.lat) ** 2 + (track[i][1] - latlng.lng) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  const frac = bi / (track.length - 1);
  // Réparti uniformément entre les waypoints : approximation suffisante pour choisir
  // un segment (le reroute corrige la géométrie exacte de toute façon).
  return Math.min(wps.length - 1, Math.max(1, Math.round(frac * (wps.length - 1))));
}

function removeWaypoint(id) {
  planner.waypoints = planner.waypoints.filter((w) => w.id !== id);
  commit();
  redraw();
  reroute();
}

function reverseRoute() {
  planner.waypoints.reverse();
  commit();
  redraw();
  reroute();
}

// ---------- Boucler l'itinéraire ----------
// Referme le parcours en revenant au point A par les sentiers : on AJOUTE une copie
// du premier waypoint en fin de liste et on re-route — le retour emprunte donc son
// propre routage BRouter (souvent un autre chemin que l'aller), pas un simple trait.
const LOOP_EPS = 1e-4; // ~11 m : en deçà, départ et arrivée sont le même endroit

function isLooped() {
  const w = planner.waypoints;
  if (w.length < 3) return false;
  const a = w[0], z = w[w.length - 1];
  return Math.abs(a.lat - z.lat) < LOOP_EPS && Math.abs(a.lon - z.lon) < LOOP_EPS;
}

function closeLoop() {
  const first = planner.waypoints[0];
  if (!first || planner.waypoints.length < 2 || isLooped()) return;
  planner.waypoints.push({ id: `w${++planner.seq}`, lat: first.lat, lon: first.lon, name: first.name });
  commit();
  redraw();
  reroute();
}

function resetRoute() {
  planner.waypoints = [];
  planner.routed = null;
  planner.locate = null;
  planner.controller?.abort();
  // Réinitialiser efface TOUT le plan en cours, repères compris : c'est le geste
  // « page blanche », pas un simple retrait de points.
  planner.annots = [];
  drawAnnots();
  setAnnotating(false);
  commit();
  redraw();
  render();
}

// ---------- Routage ----------
// Un seul appel BRouter sur la liste entière, débouncé, l'appel en vol étant annulé :
// pendant un glisser de marqueur les mutations s'enchaînent, on ne veut ni saturer le
// serveur partagé ni laisser une réponse périmée écraser la dernière.
function reroute() {
  clearTimeout(planner.timer);
  planner.timer = setTimeout(runRoute, REROUTE_DEBOUNCE_MS);
}

async function runRoute() {
  planner.controller?.abort();
  if (planner.waypoints.length < 2) {
    planner.routed = null;
    planner.locate = null;
    planner.routing = false;
    redraw();
    render();
    return;
  }
  const controller = new AbortController();
  planner.controller = controller;
  planner.routing = true;
  render();
  const pts = planner.waypoints.map((w) => [w.lat, w.lon]);
  try {
    const r = await brouterRoute(pts, { signal: controller.signal });
    if (controller.signal.aborted) return; // une édition plus récente a pris la main
    planner.routed = r;
    planner.locate = trackLocator(r.track, r.distance);
    planner.routing = false;
    redraw();
    render();
  } catch (err) {
    if (controller.signal.aborted || err.name === "AbortError" || err.name === "TimeoutError") return;
    // Routage indisponible : on montre quand même la ligne droite, explicitement
    // signalée — un itinéraire faux qui se croit vrai serait pire que pas d'itinéraire.
    planner.routed = { track: pts, eles: null, distance: null, ascend: null, ways: [], fallback: true };
    planner.locate = null; // des km mesurés sur une ligne droite seraient des mensonges
    planner.routing = false;
    redraw();
    render(err.message);
  }
}

// ---------- Rendu carte ----------
function redraw() {
  planner.layer.clearLayers();
  planner.markers.clear();
  const r = planner.routed;
  if (r?.track?.length > 1) {
    const line = drawTrack(r.track, { dashArray: r.fallback ? "7 9" : null });
    // Cliquer SUR le tracé insère un point de passage à cet endroit (détour). Le clic
    // « dans le vide » ajoute en bout de course (map.js) — stopPropagation évite que
    // les deux se déclenchent pour un même clic.
    if (!r.fallback) {
      line.on("click", (e) => {
        L.DomEvent.stop(e);
        // En mode annotation, cliquer le tracé pose le repère dessus (cas nominal :
        // « à ce point du parcours ») au lieu d'insérer un waypoint.
        planner.annotating ? openAnnotCreate(e.latlng) : insertPointAt(e.latlng);
      });
      // Sens carte → profil : longer le tracé du doigt/curseur déplace le curseur du
      // profil. Complète le contrat « carte ↔ profil » (l'autre sens est showCursorOnMap).
      line.on("mousemove", (e) => {
        const km = planner.profile?.kmNear(e.latlng.lat, e.latlng.lng);
        if (km != null) planner.profile.setCursorKm(km);
      });
      line.on("mouseout", () => planner.profile?.setCursorKm(null));
    }
    planner.layer.addLayer(line);
  }
  planner.waypoints.forEach((w, i) => {
    const marker = L.marker([w.lat, w.lon], {
      draggable: true,
      icon: L.divIcon({
        className: "plan-wp",
        html: `<span title="Glisser pour déplacer — cliquer pour retirer">${letterOf(i)}</span>`,
        iconSize: [26, 26],
      }),
    });
    // Déplacer un point = le geste le plus direct pour corriger un itinéraire.
    marker.on("dragend", () => {
      const ll = marker.getLatLng();
      w.lat = ll.lat;
      w.lon = ll.lng;
      w.name = null; // le point n'est plus le lieu nommé qu'on avait choisi
      commit();
      renderList();
      reroute();
    });
    // Cliquer un point de passage le RETIRE (choix utilisateur : le geste le plus
    // court pour corriger un mauvais ping — annuler ⌘Z le ramène). Leaflet ne
    // déclenche pas de click après un glisser : les deux gestes ne se marchent pas
    // dessus. En mode annotation, le clic pose un repère à cet endroit à la place.
    marker.on("click", (e) => {
      L.DomEvent.stop(e);
      if (planner.annotating) { openAnnotCreate(marker.getLatLng()); return; }
      removeWaypoint(w.id);
    });
    planner.layer.addLayer(marker);
    planner.markers.set(w.id, marker);
  });
}

// Survol du profil → point sur la carte principale. Même contrat que la fiche.
function showCursorOnMap(p) {
  if (!p) { planner.cursor?.remove(); planner.cursor = null; return; }
  if (!planner.cursor) {
    planner.cursor = L.circleMarker([p.lat, p.lon], {
      radius: 5, color: "#fff", weight: 2, fillColor: "#ff2d20", fillOpacity: 1,
      interactive: false,
    }).addTo(map);
  } else {
    planner.cursor.setLatLng([p.lat, p.lon]);
  }
}

function fitRoute() {
  const r = planner.routed;
  if (!r?.track?.length) return;
  const bar = el("plan-bar");
  const mobile = window.innerWidth < 700;
  // Vue plein écran : le panneau borde à gauche, le dock (profil + stats) recouvre le
  // bas — le cadrage doit éviter les deux, sinon départ ou arrivée finissent dessous.
  const dockH = mobile ? 0 : el("plan-result")?.offsetHeight || 0;
  map.fitBounds(L.latLngBounds(r.track), mobile
    ? { paddingTopLeft: [30, 90], paddingBottomRight: [30, (bar?.offsetHeight || 0) + 30], maxZoom: 15 }
    : { paddingTopLeft: [(bar?.offsetWidth || 380) + 40, 40], paddingBottomRight: [50, dockH + 40], maxZoom: 15 });
}

// ---------- Rendu panneau ----------
function renderList() {
  const box = el("plan-steps");
  if (!planner.waypoints.length) {
    box.innerHTML = `<p class="muted plan-hint">Cliquez sur la carte pour poser vos points de passage, ou cherchez un lieu ci-dessus.</p>`;
    return;
  }
  box.innerHTML = planner.waypoints
    .map(
      (w, i) => `<div class="plan-row" data-wp="${w.id}">
        <button class="plan-grip" data-drag title="Glisser pour réordonner" aria-label="Réordonner">⠿</button>
        <span class="plan-letter">${letterOf(i)}</span>
        <span class="plan-name">${escapeHtml(w.name || `${w.lat.toFixed(4)}, ${w.lon.toFixed(4)}`)}</span>
        <button class="plan-rm" data-rm="${w.id}" title="Retirer ce point" aria-label="Retirer">✕</button>
      </div>`
    )
    .join("");
}

function renderMetrics() {
  const box = el("plan-result");
  const r = planner.routed;
  if (!r || r.fallback || r.distance == null) {
    box.classList.add("hidden");
    el("plan-sac").classList.add("hidden");
    planner.profile?.destroy();
    planner.profile = null;
    clearTimeout(planner.wxTimer);
    planner.wx?.destroy();
    planner.wx = null;
    planner.cursor?.remove();
    planner.cursor = null;
    return;
  }
  const gain = r.eles ? computeGain(r.eles) : null;
  const loss = r.eles ? computeLoss(r.eles) : null;
  const dist = Math.round(r.distance * 10) / 10;
  const hours = naismithHours(dist, gain || 0);
  const fr = (v) => v.toLocaleString("fr-FR");
  el("plan-metrics").innerHTML =
    `<div class="dock-stat big"><span>${fr(dist)}<small> km</small></span><label>Distance</label></div>` +
    `<div class="dock-stat big"><span>${fmtDuration(hours)}</span><label>Durée est.</label></div>` +
    `<div class="dock-stat"><span>${gain != null ? fr(gain) : "—"}<small> m</small></span><label>Dénivelé +</label></div>` +
    `<div class="dock-stat"><span>${loss != null ? fr(loss) : "—"}<small> m</small></span><label>Dénivelé −</label></div>`;

  // Profil du dock bas : large, non compact — c'est la pièce maîtresse de la vue
  // plein écran (survol lié à la carte, glisser pour zoomer, bande de revêtement,
  // repères personnels). Les points BRouter étant déjà à la géométrie réelle,
  // `track`/`eles` coïncident et l'axe kilométrique est exact.
  planner.profile?.destroy();
  planner.profile = null;
  const mobile = window.innerWidth < 700;
  if (r.eles) {
    planner.profile = createProfile(el("plan-profile"), {
      eles: r.eles, track: r.track, ways: r.ways, totalKm: r.distance,
      height: mobile ? 84 : 128, compact: mobile, onHover: showCursorOnMap,
      annotate: (km) => planner.wx?.annotate(km) || "",
      markers: profileMarkers(),
    });
  } else {
    el("plan-profile").innerHTML = "";
  }

  // Météo à l'heure de passage, débouncée : pendant l'édition (glisser d'un marqueur,
  // enchaînement de points) chaque route aboutie ne déclenche pas son appel météo —
  // seul l'itinéraire resté stable 800 ms est interrogé. hikeweather cache par
  // (points, horizon) : rouvrir le même tracé ne refait pas de réseau.
  clearTimeout(planner.wxTimer);
  planner.wx?.destroy();
  planner.wx = null;
  if (r.eles) {
    planner.wxTimer = setTimeout(() => {
      planner.wx = createRouteWeather(el("plan-wx"), { id: "plan-en-cours" }, {
        eles: r.eles, track: r.track, totalKm: r.distance, cells: 5,
      });
    }, 800);
  } else {
    el("plan-wx").innerHTML = "";
  }

  const sac = sacRating({ ways: r.ways, eles: r.eles, track: r.track });
  const pill = el("plan-sac");
  if (sac.level) {
    // La provenance est affichée avec la cote, jamais tue : `sac_scale` est très
    // inégal dans OSM et une cote estimée qui se présente comme sûre est un piège.
    pill.innerHTML =
      `<span class="plan-sac-level">${sac.level}</span>` +
      `<span class="plan-sac-src">${sac.estimated
        ? (sac.source === "pente" ? "estimé — sentiers non cotés" : `estimé — ${Math.round(sac.coverage * 100)} % coté`)
        : `d'après OSM · ${Math.round(sac.coverage * 100)} %`}</span>`;
    pill.title = `${SAC_LABEL[sac.level]} — ${sac.source === "osm"
      ? `cotation OSM sur ${Math.round(sac.coverage * 100)} % du parcours`
      : "aucun tronçon coté ici : estimation d'après la pente, plafonnée à T4"}`;
    pill.classList.toggle("estimated", sac.estimated);
    pill.classList.remove("hidden");
  } else {
    pill.classList.add("hidden");
  }
  box.classList.remove("hidden");
}

function render(errMsg) {
  renderList();
  renderMetrics();
  renderAnnots(); // le tracé a pu changer : km / temps de marche des repères à jour
  const status = el("plan-status");
  let msg = "";
  if (planner.routing) msg = "⏳ routage…";
  else if (planner.routed?.fallback) msg = `⚠ Routage indisponible — tracé en ligne droite. ${errMsg || ""}`.trim();
  status.textContent = msg;
  status.classList.toggle("hidden", !msg);
  el("plan-save").disabled = !planner.routed || planner.routed.fallback || planner.routing;
  el("plan-reverse").disabled = planner.waypoints.length < 2;
  el("plan-loop").disabled = planner.waypoints.length < 2 || isLooped();
  el("plan-reset").disabled = !planner.waypoints.length;
  el("plan-undo").disabled = planner.hIndex === 0;
  el("plan-redo").disabled = planner.hIndex >= planner.history.length - 1;
}

// ---------- Réordonnancement par glisser ----------
// Pointer events et non HTML5 drag-and-drop : ce dernier est inutilisable au doigt,
// or la contrainte mobile ≤ 700 px vaut ici comme partout.
function initReorder() {
  const listEl = el("plan-steps");
  listEl.addEventListener("pointerdown", (e) => {
    const grip = e.target.closest("[data-drag]");
    if (!grip) return;
    e.preventDefault();
    const id = grip.closest("[data-wp]")?.dataset.wp;
    if (!id) return;
    document.body.classList.add("plan-dragging");

    const move = (ev) => {
      const rows = [...listEl.querySelectorAll("[data-wp]")];
      const over = rows.find((row) => {
        const b = row.getBoundingClientRect();
        return ev.clientY >= b.top && ev.clientY <= b.bottom;
      });
      if (!over || over.dataset.wp === id) return;
      const from = planner.waypoints.findIndex((w) => w.id === id);
      const to = planner.waypoints.findIndex((w) => w.id === over.dataset.wp);
      if (from < 0 || to < 0) return;
      planner.waypoints.splice(to, 0, planner.waypoints.splice(from, 1)[0]);
      renderList();
      redraw(); // les lettres des marqueurs suivent l'ordre en direct
    };
    const startOrder = planner.waypoints.map((w) => w.id).join();
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.body.classList.remove("plan-dragging");
      if (planner.waypoints.map((w) => w.id).join() !== startOrder) commit(); // seulement si l'ordre a bougé
      reroute();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });

  listEl.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]");
    if (rm) removeWaypoint(rm.dataset.rm);
  });
}

// ---------- Sauvegarde ----------
// Nom par défaut tiré des extrémités quand elles viennent du géocodeur
// (« Chamonix → Montenvers » vaut mieux que « Itinéraire 6,5 km »).
function defaultName(dist) {
  const first = planner.waypoints[0]?.name;
  const last = planner.waypoints[planner.waypoints.length - 1]?.name;
  if (first && last && first !== last) return `${first} → ${last}`;
  if (first) return `${first} — boucle`;
  return `Itinéraire ${dist.toLocaleString("fr-FR")} km — ${new Date().toLocaleDateString("fr-FR")}`;
}

function savePlan() {
  const r = planner.routed;
  if (!r || r.fallback || r.distance == null) return;
  const gain = r.eles ? computeGain(r.eles) : null;
  const loss = r.eles ? computeLoss(r.eles) : null;
  const altMax = r.eles ? Math.round(Math.max(...r.eles)) : null;
  const dist = Math.round(r.distance * 10) / 10;
  const hours = naismithHours(dist, gain || 0);
  const sac = sacRating({ ways: r.ways, eles: r.eles, track: r.track });
  const track = r.track;
  // Repères embarqués avec leur km figé au moment de la sauvegarde : la fiche n'a
  // pas besoin de re-projeter (et un tracé sauvegardé ne bouge plus).
  const pois = planner.annots.map((a) => {
    const p = planner.locate?.(a.lat, a.lon);
    return {
      kind: a.kind,
      note: a.note || "",
      lat: a.lat,
      lon: a.lon,
      km: p && p.offM <= ANNOT_NEAR_M ? Math.round(p.km * 10) / 10 : null,
    };
  });
  const trail = {
    id: `plan-${Date.now()}`,
    imported: true,
    custom: true,
    // Invariant tenu dans toute l'app : eles.length === track.length, sinon absent.
    // Le respecter débloque gratuitement le profil de la fiche (ensureElevation
    // court-circuite), la 3D et le profil hors-ligne.
    eles: r.eles && r.eles.length === track.length ? r.eles.map((e) => Math.round(e)) : undefined,
    name: defaultName(dist),
    location: "Itinéraire planifié",
    region: "Mes itinéraires",
    difficulty: "personnalisé",
    type: "itinéraire",
    days: null,
    bivouac: false,
    distance: dist,
    elevationGain: gain,
    elevationLoss: loss,
    altMax,
    duration: fmtDuration(hours),
    // `sac` et `ways` sont des champs neufs : ils transitent en IndexedDB sans
    // changement de schéma (structured-clone) et évitent à S-PLAN-B de re-router un
    // tracé déjà enregistré pour colorer son revêtement.
    sac,
    ways: r.ways,
    // `pois` suit le même chemin que `sac`/`ways` : champ neuf, structured-clone,
    // aucune migration IndexedDB. La fiche le rejoue (carte, profil, liste).
    pois,
    center: track[Math.floor(track.length / 2)],
    gradient: "linear-gradient(135deg, #3a3a40, #6a6a72)",
    description:
      `Itinéraire planifié le ${new Date().toLocaleDateString("fr-FR")} par ` +
      `${planner.waypoints.length} points de passage, ${dist} km` +
      (gain != null ? ` · ${gain} m D+ · ${loss} m D−` : "") +
      (sac.level ? ` · cotation ${sac.level}${sac.estimated ? " (estimée)" : ""}` : "") +
      `, suivant les sentiers (BRouter, profil rando-montagne)` +
      (pois.length ? ` · ${pois.length} repère${pois.length > 1 ? "s" : ""} personnel${pois.length > 1 ? "s" : ""}` : "") +
      `.`,
    eau: "—",
    bivouacSpot: "—",
    periode: "—",
    track,
    segments: [track],
  };
  state.imported.unshift(trail);
  saveTraces(state.imported);
  addMarker(trail);
  exitPlanner();
  renderAll();
  selectTrail(trail.id);
}

function exitPlanner() {
  planner.active = false;
  planner.waypoints = [];
  planner.routed = null;
  planner.locate = null;
  planner.routing = false;
  planner.controller?.abort();
  clearTimeout(planner.timer);
  planner.markers.clear();
  planner.layer.clearLayers();
  planner.layer.remove();
  setAnnotating(false);
  planner.annots = [];
  planner.annotMarkers.clear();
  planner.annotLayer.clearLayers();
  planner.annotLayer.remove();
  el("plan-annots").innerHTML = "";
  planner.suggest?.clear();
  planner.profile?.destroy();
  planner.profile = null;
  clearTimeout(planner.wxTimer);
  planner.wx?.destroy();
  planner.wx = null;
  planner.cursor?.remove();
  planner.cursor = null;
  planner.history = [[]];
  planner.hIndex = 0;
  document.body.classList.remove("loops-active");
  planner.sheetReset?.();
  el("plan-bar").classList.add("hidden");
  el("btn-planner").classList.remove("active");
}

// ---------- Bottom-sheet glissable (mobile) ----------
// Sur téléphone le panneau occupe l'écran : on doit pouvoir le tirer vers le bas pour
// dégager la carte en grand, puis le remonter. Deux crans (ouvert / réduit), le doigt
// colle au panneau pendant le geste, snap au relâchement selon la position et l'élan.
// Desktop (panneau latéral, carte déjà visible à côté) : le geste ne s'arme jamais.
function initSheet() {
  const panel = el("plan-bar");
  const grip = el("plan-sheet-grip");
  const head = panel.querySelector(".plan-panel-head");
  const isMobile = () => window.matchMedia("(max-width: 700px)").matches;

  let dragging = false, moved = false, startY = 0, baseY = 0, curY = 0, maxY = 0;
  let lastY = 0, lastT = 0, vel = 0;

  // Portion laissée visible en position réduite : poignée + en-tête (le titre reste
  // lisible, tout le reste passe sous le pli).
  const peek = () => grip.offsetHeight + (head?.offsetHeight || 0) + 12;
  const setY = (y) => { curY = y; panel.style.setProperty("--sheet-y", `${y}px`); };
  const collapse = () => { panel.classList.add("sheet-collapsed"); setY(maxY); };
  const expand = () => { panel.classList.remove("sheet-collapsed"); setY(0); };

  // Réarme à « ouvert » à chaque ouverture du planificateur (et purge l'inline style
  // hérité si on repasse desktop).
  planner.sheetReset = () => { panel.classList.remove("sheet-collapsed", "sheet-dragging"); panel.style.removeProperty("--sheet-y"); curY = 0; };

  const onDown = (e) => {
    if (!isMobile() || dragging) return;
    // Un appui sur ✕ (ou tout autre bouton de l'en-tête) ne doit pas armer le glissement.
    if (e.target.closest("button") && !e.target.closest("#plan-sheet-grip")) return;
    dragging = true; moved = false;
    startY = lastY = e.clientY; lastT = performance.now();
    baseY = curY;
    maxY = Math.max(0, panel.offsetHeight - peek());
    panel.classList.add("sheet-dragging");
    grip.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    setY(Math.min(maxY, Math.max(0, baseY + dy)));
    const now = performance.now();
    if (now > lastT) { vel = (e.clientY - lastY) / (now - lastT); lastY = e.clientY; lastT = now; }
    if (moved) e.preventDefault(); // pas de scroll de page pendant qu'on tire la feuille
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove("sheet-dragging");
    if (!moved) { // simple tap sur la poignée = bascule ouvert/réduit
      if (e.target.closest("#plan-sheet-grip")) panel.classList.contains("sheet-collapsed") ? expand() : collapse();
      return;
    }
    // L'élan tranche ; sinon la moitié parcourue décide.
    (vel > 0.35 || (vel >= -0.35 && curY > maxY * 0.4)) ? collapse() : expand();
  };

  grip.addEventListener("pointerdown", onDown);
  head?.addEventListener("pointerdown", onDown);
  document.addEventListener("pointermove", onMove, { passive: false });
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", () => { if (dragging) { dragging = false; panel.classList.remove("sheet-dragging"); } });
  // Clavier : la poignée est un contrôle, Entrée/Espace la basculent.
  grip.addEventListener("keydown", (e) => {
    if (!isMobile() || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    maxY = Math.max(0, panel.offsetHeight - peek());
    panel.classList.contains("sheet-collapsed") ? expand() : collapse();
  });
  window.addEventListener("resize", () => { if (!isMobile()) planner.sheetReset(); });
}

export function initPlanner() {
  initReorder();
  initSheet();

  // Deuxième instance du géocodeur Nominatim (la première sert la recherche carte).
  // Les deux ne sont jamais actives ensemble : le planificateur masque la barre de
  // recherche via `loops-active` → la politique ≤ 1 req/s reste tenue.
  planner.suggest = createGeoSuggest({
    input: el("plan-search"),
    box: el("plan-suggest"),
    container: el("plan-search-wrap"),
    onPick(r) {
      planner.suggest.clear();
      plannerAddPoint(L.latLng(r.lat, r.lon), r.name);
      map.panTo([r.lat, r.lon]);
    },
  });

  el("btn-planner").addEventListener("click", () => {
    if (planner.active) { exitPlanner(); return; }
    closeDetail();
    planner.active = true;
    planner.history = [[]];
    planner.hIndex = 0;
    // Même leçon qu'en S-BOUCLES : on masque la liste de résultats et la barre de
    // recherche, sinon le panneau surgit par-dessus la carte (« la page saute »).
    document.body.classList.add("loops-active");
    planner.layer.addTo(map);
    planner.annotLayer.addTo(map);
    el("plan-bar").classList.remove("hidden");
    planner.sheetReset?.(); // toujours ouverte à l'ouverture, jamais en position réduite héritée
    el("btn-planner").classList.add("active");
    render();
  });

  el("plan-annot").addEventListener("click", () => setAnnotating(!planner.annotating));

  el("plan-reverse").addEventListener("click", reverseRoute);
  el("plan-loop").addEventListener("click", closeLoop);
  el("plan-reset").addEventListener("click", resetRoute);
  el("plan-cancel").addEventListener("click", exitPlanner);
  el("plan-save").addEventListener("click", savePlan);
  el("plan-fit").addEventListener("click", fitRoute);
  el("plan-undo").addEventListener("click", undo);
  el("plan-redo").addEventListener("click", redo);

  // Raccourcis clavier (usage Mac depuis le bureau) — inactifs dès qu'on saisit du
  // texte, pour ne pas voler ⌘Z à la zone de recherche ou aux notes.
  document.addEventListener("keydown", (e) => {
    if (!planner.active) return;
    // Échap désarme le mode annotation (avant le filtre de saisie : il doit marcher
    // même depuis le champ de note de la bulle).
    if (e.key === "Escape" && planner.annotating) { setAnnotating(false); return; }
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    }
  });

  // Liste des repères : la ligne recentre la carte et rouvre la bulle, ✕ supprime.
  el("plan-annots").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-arm]");
    if (rm) { removeAnnot(rm.dataset.arm); return; }
    const row = e.target.closest("[data-a]");
    if (!row) return;
    const a = planner.annots.find((x) => x.id === row.dataset.a);
    if (!a) return;
    map.panTo([a.lat, a.lon]);
    openAnnotEdit(a);
  });
}
