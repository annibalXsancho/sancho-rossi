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
import { map, addMarker } from "./map.js";
import { renderAll, selectTrail } from "./trails.js";
import { closeDetail } from "./detail.js";
import { saveTraces } from "./storage.js";
import { brouterRoute } from "./brouter.js";
import { createGeoSuggest } from "./geosearch.js";
import { createProfile } from "./profile.js";
import { createRouteWeather } from "./hikeweather.js";
import { createConditions } from "./conditions.js";
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
  cond: null,      // bandeau conditions du sentier + orages (S-CONDITIONS)
  wxTimer: null,   // débounce : pas d'appel Open-Meteo à chaque retouche de tracé
  cursor: null,    // marqueur de position, piloté par le survol du profil
  history: [[]],   // instantanés de `waypoints` — l'état vide est le fond de pile
  hIndex: 0,
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

function resetRoute() {
  planner.waypoints = [];
  planner.routed = null;
  planner.controller?.abort();
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
    planner.routing = false;
    redraw();
    render();
  } catch (err) {
    if (controller.signal.aborted || err.name === "AbortError" || err.name === "TimeoutError") return;
    // Routage indisponible : on montre quand même la ligne droite, explicitement
    // signalée — un itinéraire faux qui se croit vrai serait pire que pas d'itinéraire.
    planner.routed = { track: pts, eles: null, distance: null, ascend: null, ways: [], fallback: true };
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
    const line = L.polyline(r.track, {
      color: "#ff2d20",
      weight: 4,
      opacity: 0.95,
      dashArray: r.fallback ? "7 7" : null,
    });
    // Cliquer SUR le tracé insère un point de passage à cet endroit (détour). Le clic
    // « dans le vide » ajoute en bout de course (map.js) — stopPropagation évite que
    // les deux se déclenchent pour un même clic.
    if (!r.fallback) {
      line.on("click", (e) => { L.DomEvent.stop(e); insertPointAt(e.latlng); });
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
      icon: L.divIcon({ className: "plan-wp", html: letterOf(i), iconSize: [26, 26] }),
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
  map.fitBounds(L.latLngBounds(r.track), mobile
    ? { paddingTopLeft: [30, 90], paddingBottomRight: [30, (bar?.offsetHeight || 0) + 30], maxZoom: 15 }
    : { paddingTopLeft: [(bar?.offsetWidth || 360) + 40, 40], paddingBottomRight: [50, 50], maxZoom: 15 });
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
    planner.cond?.destroy();
    planner.cond = null;
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
    `<div class="loops-metric big"><span>${fr(dist)}</span><label>km</label></div>` +
    `<div class="loops-metric big"><span>${fmtDuration(hours)}</span><label>durée est.</label></div>` +
    `<div class="loops-metric"><span>${gain != null ? fr(gain) : "—"}</span><label>m D+</label></div>` +
    `<div class="loops-metric"><span>${loss != null ? fr(loss) : "—"}</span><label>m D−</label></div>`;

  // Vignette de profil interactive : axe en km, survol lié à la carte, glisser pour
  // zoomer, bande de revêtement. Les points BRouter étant déjà à la géométrie réelle,
  // `track`/`eles` coïncident et l'axe kilométrique est exact.
  planner.profile?.destroy();
  planner.profile = null;
  if (r.eles) {
    planner.profile = createProfile(el("plan-profile"), {
      eles: r.eles, track: r.track, ways: r.ways, totalKm: r.distance,
      height: 84, compact: true, onHover: showCursorOnMap,
      annotate: (km) => planner.wx?.annotate(km) || "",
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
  planner.cond?.destroy();
  planner.cond = null;
  if (r.eles) {
    planner.wxTimer = setTimeout(() => {
      planner.wx = createRouteWeather(el("plan-wx"), { id: "plan-en-cours" }, {
        eles: r.eles, track: r.track, totalKm: r.distance, cells: 5,
      });
      planner.cond = createConditions(el("plan-conditions"), { id: "plan-en-cours" }, {
        eles: r.eles, track: r.track, totalKm: r.distance,
      });
    }, 800);
  } else {
    el("plan-wx").innerHTML = "";
    el("plan-conditions").innerHTML = "";
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
  const status = el("plan-status");
  let msg = "";
  if (planner.routing) msg = "⏳ routage…";
  else if (planner.routed?.fallback) msg = `⚠ Routage indisponible — tracé en ligne droite. ${errMsg || ""}`.trim();
  status.textContent = msg;
  status.classList.toggle("hidden", !msg);
  el("plan-save").disabled = !planner.routed || planner.routed.fallback || planner.routing;
  el("plan-reverse").disabled = planner.waypoints.length < 2;
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
    center: track[Math.floor(track.length / 2)],
    gradient: "linear-gradient(135deg, #3a3a40, #6a6a72)",
    description:
      `Itinéraire planifié le ${new Date().toLocaleDateString("fr-FR")} par ` +
      `${planner.waypoints.length} points de passage, ${dist} km` +
      (gain != null ? ` · ${gain} m D+ · ${loss} m D−` : "") +
      (sac.level ? ` · cotation ${sac.level}${sac.estimated ? " (estimée)" : ""}` : "") +
      `, suivant les sentiers (BRouter, profil rando-montagne).`,
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
  planner.routing = false;
  planner.controller?.abort();
  clearTimeout(planner.timer);
  planner.markers.clear();
  planner.layer.clearLayers();
  planner.layer.remove();
  planner.suggest?.clear();
  planner.profile?.destroy();
  planner.profile = null;
  clearTimeout(planner.wxTimer);
  planner.wx?.destroy();
  planner.wx = null;
  planner.cond?.destroy();
  planner.cond = null;
  planner.cursor?.remove();
  planner.cursor = null;
  planner.history = [[]];
  planner.hIndex = 0;
  document.body.classList.remove("loops-active");
  el("plan-bar").classList.add("hidden");
  el("btn-planner").classList.remove("active");
}

export function initPlanner() {
  initReorder();

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
    el("plan-bar").classList.remove("hidden");
    el("btn-planner").classList.add("active");
    render();
  });

  el("plan-reverse").addEventListener("click", reverseRoute);
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
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    }
  });
}
