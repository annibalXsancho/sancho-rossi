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
import { profileSVGFromValues } from "./detail.js";
import {
  computeGain, computeLoss, naismithHours, fmtDuration, sacRating, SAC_LABEL,
} from "./metrics.js";

const REROUTE_DEBOUNCE_MS = 250; // coalesce les éditions rapprochées (glisser, réordonner)

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
};

const el = (id) => document.getElementById(id);

// A, B, C… puis 27, 28… (au-delà de Z, la lettre n'aide plus personne)
const letterOf = (i) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

// ---------- Mutations (toutes passent par reroute) ----------
export function plannerAddPoint(latlng, name = null) {
  planner.waypoints.push({
    id: `w${++planner.seq}`,
    lat: latlng.lat,
    lon: latlng.lng,
    name,
  });
  redraw();
  reroute();
}

function removeWaypoint(id) {
  planner.waypoints = planner.waypoints.filter((w) => w.id !== id);
  redraw();
  reroute();
}

function reverseRoute() {
  planner.waypoints.reverse();
  redraw();
  reroute();
}

function resetRoute() {
  planner.waypoints = [];
  planner.routed = null;
  planner.controller?.abort();
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
    planner.layer.addLayer(
      L.polyline(r.track, {
        color: "#ff2d20",
        weight: 4,
        opacity: 0.95,
        dashArray: r.fallback ? "7 7" : null,
      })
    );
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
      renderList();
      reroute();
    });
    planner.layer.addLayer(marker);
    planner.markers.set(w.id, marker);
  });
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

  // Vignette de profil. NB : l'axe X de profileSVGFromValues est indexé, pas
  // kilométrique — les points BRouter n'étant pas équidistants, le profil est
  // légèrement déformé. Défaut préexistant sur TOUS les tracés de l'app ; corrigé
  // en S-PLAN-B (axe en distance cumulée), pas ici.
  el("plan-profile").innerHTML = r.eles ? profileSVGFromValues(r.eles, 320, 70) : "";

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
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.body.classList.remove("plan-dragging");
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
}
