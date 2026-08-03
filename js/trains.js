// Sancho Rossi — panneau « Trains » (S-V3-TRAIN-A) : chercher une gare, lire ses
// prochains départs, partout en Europe et sans compte.
//
// Le module vit SUR la carte, comme le planificateur : panneau latéral sur Mac,
// bottom-sheet glissable sur téléphone (mêmes crans, même mécanique de geste). La rando
// reste le cœur — le transport la sert : on cherche une gare parce qu'on veut rejoindre un
// départ de sentier. D'où les arrêts de la ZONE AFFICHÉE proposés d'emblée : quand on
// regarde un massif, la question est « qu'est-ce qui dessert ce coin ? » plus souvent que
// « quels sont les départs de Zurich HB ».
//
// Honnêteté sur la donnée (exigence du sprint) : la couverture temps réel est très inégale
// en Europe (Allemagne et Suisse bien servies, France plus fermée). Chaque départ dit donc
// ce qu'il est — « temps réel » ou « horaire théorique » — plutôt que d'afficher un
// horaire prévisionnel comme s'il était observé.
import {
  searchStops, stopsInBounds, departures, hhmm, inMinutes,
  modeLabel, modeFamily, isRailStop, MODE_FILTERS, ATTRIBUTION, ATTRIBUTION_URL,
} from "./transit.js";
import { map, domMarker, makeIcon, flyToL, markerGroup } from "./map.js";
import { switchTab } from "./ui.js";

const el = (id) => document.getElementById(id);
const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const RECENT_KEY = "sr-train-recent";   // 5 derniers arrêts consultés (petite préférence)
const FILTER_KEY = "sr-train-filter";
const RECENT_MAX = 5;
const DEBOUNCE_MS = 350;
const MIN_CHARS = 2;

// Icônes par famille de mode — traits simples, cohérents avec la chrome de carte.
const ICONS = {
  rail: '<path d="M7 4h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M5 9h14"/><path d="m8 19-1.5 2M16 19l1.5 2"/><circle cx="8.6" cy="12.3" r="1" fill="currentColor" stroke="none"/><circle cx="15.4" cy="12.3" r="1" fill="currentColor" stroke="none"/>',
  bus: '<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"/><path d="M4 10h16"/><path d="m7 16v2M17 16v2"/><circle cx="7.5" cy="13.2" r="1" fill="currentColor" stroke="none"/><circle cx="16.5" cy="13.2" r="1" fill="currentColor" stroke="none"/>',
  urban: '<path d="M8 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M6 9h12"/><path d="m9 16-2 5M15 16l2 5"/>',
  lift: '<path d="M3 6 21 4"/><path d="M12 5v3"/><path d="M8 8h8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/>',
  boat: '<path d="M4 17h16l-2 4H6l-2-4Z"/><path d="M6 17V9l6-4 6 4v8"/>',
  other: '<circle cx="12" cy="12" r="7"/>',
};
const icon = (family, cls = "") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[family] || ICONS.other}</svg>`;

const state = {
  open: false,
  stop: null,          // arrêt sélectionné
  filter: localStorage.getItem(FILTER_KEY) || "tout",
  rows: [],
  cursor: null,
  loading: false,
  controller: null,
  timer: null,
  suggestions: [],
  nearby: [],
  nearbyMsg: "",       // pourquoi la liste de zone est vide (trop large / hors couverture)
  stopMarkers: markerGroup(),
  pinMarker: null,
  refresher: null,
};

// ---------- Arrêts récents ----------
const readRecent = () => {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; }
};
function pushRecent(stop) {
  const list = readRecent().filter((s) => s.id !== stop.id);
  list.unshift({ id: stop.id, name: stop.name, area: stop.area, lat: stop.lat, lon: stop.lon, modes: stop.modes });
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
}

// ---------- Marqueurs d'arrêts sur la carte ----------
function showStopMarkers(stops) {
  state.stopMarkers.clear();
  stops.forEach((s) => {
    const node = makeIcon("stop-marker", icon(isRailStop(s) ? "rail" : "bus"), 26);
    node.title = s.name;
    node.addEventListener("click", (e) => { e.stopPropagation(); selectStop(s); });
    state.stopMarkers.add(domMarker(s.lat, s.lon, { element: node }));
  });
  state.stopMarkers.addTo();
}

function pinStop(stop) {
  state.pinMarker?.remove();
  state.pinMarker = domMarker(stop.lat, stop.lon, {
    element: makeIcon("stop-marker stop-marker-active", icon(isRailStop(stop) ? "rail" : "bus"), 34),
  }).addTo(map);
}

// ---------- Rendus ----------
const stopRow = (s, extra = "") => `
  <button type="button" class="stop-row" data-stop="${escapeHtml(s.id)}" aria-label="${escapeHtml(s.name)}">
    <span class="stop-row-ic">${icon(isRailStop(s) ? "rail" : "bus")}</span>
    <span class="stop-row-text">
      <span class="stop-row-name">${escapeHtml(s.name)}</span>
      ${s.area || extra ? `<span class="stop-row-sub">${escapeHtml([extra, s.area].filter(Boolean).join(" · "))}</span>` : ""}
    </span>
  </button>`;

function renderSuggest() {
  const box = el("train-suggest");
  if (!state.suggestions.length) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.innerHTML = state.suggestions.map((s) => stopRow(s)).join("");
  box.classList.remove("hidden");
}

// Écran d'accueil du panneau : ce qu'on a consulté récemment, puis ce qui dessert la zone
// regardée. Aucun état vide muet — s'il n'y a rien, on le dit et on propose d'élargir.
function renderHome() {
  const host = el("train-scroll");
  const recent = readRecent();
  const near = state.nearby;
  host.innerHTML = `
    ${recent.length ? `<div class="train-sec"><span class="eyebrow">Consultés récemment</span>
      <div class="stop-list">${recent.map((s) => stopRow(s)).join("")}</div></div>` : ""}
    <div class="train-sec">
      <div class="train-sec-head">
        <span class="eyebrow">Arrêts de la zone affichée</span>
        <button class="btn btn-ghost train-refresh" id="train-rescan" title="Rechercher dans la zone actuelle">↻ Actualiser</button>
      </div>
      ${state.loading ? `<div class="sk train-sk"></div><div class="sk train-sk"></div><div class="sk train-sk"></div>`
        : near.length ? `<div class="stop-list">${near.map((s) => stopRow(s, modeLabel(s.modes[0]))).join("")}</div>`
        : `<p class="muted train-empty">${escapeHtml(state.nearbyMsg)}</p>`}
    </div>
    ${attributionHTML()}`;
  el("train-rescan")?.addEventListener("click", () => loadNearby(true));
}

const attributionHTML = () =>
  `<p class="train-attrib muted">Horaires <a href="${ATTRIBUTION_URL}" target="_blank" rel="noopener">${escapeHtml(ATTRIBUTION)}</a></p>`;

function departureRow(d) {
  const late = d.delay > 0;
  const early = d.delay < 0;
  return `
    <div class="dep-row${d.cancelled ? " dep-cancelled" : ""}">
      <div class="dep-time">
        <span class="dep-hh">
          ${hhmm(d.cancelled ? d.scheduled : d.time, d.tz)}
          ${late ? `<span class="dep-delay">+${d.delay}</span>` : ""}
          ${early ? `<span class="dep-delay dep-early">${d.delay}</span>` : ""}
        </span>
        ${late || early ? `<span class="dep-sched">${hhmm(d.scheduled, d.tz)}</span>` : ""}
        ${d.cancelled ? "" : `<span class="dep-when">${escapeHtml(inMinutes(d.time))}</span>`}
      </div>
      <div class="dep-body">
        <div class="dep-head">
          ${d.line ? `<span class="dep-line">${escapeHtml(d.line)}</span>` : ""}
          <span class="dep-to">${escapeHtml(d.to || "Destination inconnue")}</span>
        </div>
        <div class="dep-meta">
          <span class="dep-mode">${icon(modeFamily(d.mode), "dep-mode-ic")}${escapeHtml(modeLabel(d.mode))}</span>
          ${d.number ? `<span>n° ${escapeHtml(d.number)}</span>` : ""}
          ${d.track ? `<span>voie ${escapeHtml(d.track)}</span>` : ""}
          ${d.cancelled ? `<span class="dep-flag dep-flag-off">supprimé</span>`
            : d.realTime ? `<span class="dep-flag dep-flag-live">temps réel</span>`
            : `<span class="dep-flag">horaire théorique</span>`}
        </div>
      </div>
    </div>`;
}

function renderStop() {
  const host = el("train-scroll");
  const s = state.stop;
  const chips = Object.entries(MODE_FILTERS)
    .map(([k, f]) => `<button type="button" class="chip${state.filter === k ? " active" : ""}" data-filter="${k}">${f.label}</button>`)
    .join("");
  host.innerHTML = `
    <div class="info-block train-stop-head">
      <div class="info-block-head">
        <span class="eyebrow">Prochains départs</span>
        <button class="btn btn-ghost train-back" id="train-back">← Autre arrêt</button>
      </div>
      <div class="train-stop-name">${escapeHtml(s.name)}</div>
      ${s.area || s.country ? `<div class="train-stop-sub muted">${escapeHtml([s.area, s.country].filter(Boolean).join(" · "))}</div>` : ""}
    </div>
    <div class="chip-row train-filters">${chips}</div>
    <div class="dep-list" id="train-deps">
      ${state.loading ? `<div class="sk train-sk"></div><div class="sk train-sk"></div><div class="sk train-sk"></div>`
        : state.rows.length ? state.rows.map(departureRow).join("")
        : `<p class="muted train-empty">Aucun départ dans les prochaines heures pour ce filtre.</p>`}
    </div>
    ${!state.loading && state.cursor ? `<button class="btn train-more" id="train-more">Départs suivants</button>` : ""}
    ${attributionHTML()}`;

  el("train-back")?.addEventListener("click", backToHome);
  el("train-more")?.addEventListener("click", loadMore);
  host.querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => setFilter(b.dataset.filter)));
}

const render = () => (state.stop ? renderStop() : renderHome());

// ---------- Données ----------
function findStop(id) {
  return state.suggestions.find((s) => s.id === id)
    || state.nearby.find((s) => s.id === id)
    || readRecent().find((s) => s.id === id);
}

async function loadNearby(force = false) {
  if (state.stop) return;
  if (!force && state.nearby.length) return;
  state.loading = true;
  renderHome();
  try {
    const b = map.getBounds();
    state.nearby = await stopsInBounds([[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]]);
    showStopMarkers(state.nearby);
    state.nearbyMsg = state.nearby.length
      ? ""
      : "Aucun arrêt desservi dans cette zone — cherchez la gare par son nom.";
  } catch (err) {
    state.nearby = [];
    // 422 « too many stops » : la fenêtre est trop large pour être énumérée. On le dit
    // pour ce qu'il est — une invitation à zoomer, pas une panne.
    state.nearbyMsg = err.status === 422
      ? "Zone trop large pour lister les arrêts — zoomez sur une vallée, ou cherchez la gare par son nom."
      : "Arrêts de la zone indisponibles pour l'instant — cherchez la gare par son nom.";
  } finally {
    state.loading = false;
    if (!state.stop) renderHome();
  }
}

async function loadDepartures({ append = false } = {}) {
  const stop = state.stop;
  if (!stop) return;
  state.controller?.abort();
  state.controller = new AbortController();
  const ctrl = state.controller;
  state.loading = !append;
  if (!append) { state.rows = []; state.cursor = null; }
  render();
  try {
    const res = await departures(stop.id, {
      filter: state.filter,
      cursor: append ? state.cursor : null,
      signal: ctrl.signal,
    });
    if (ctrl.signal.aborted) return;
    state.rows = append ? [...state.rows, ...res.rows] : res.rows;
    state.cursor = res.cursor;
    // Le fuseau de l'arrêt n'est connu qu'ici pour les arrêts venus d'une recherche.
    if (res.stop?.tz) state.stop.tz = res.stop.tz;
    state.loading = false;
    render();
  } catch (err) {
    if (ctrl.signal.aborted) return;
    state.loading = false;
    render();
    el("train-deps")?.insertAdjacentHTML(
      "beforeend",
      `<p class="muted train-empty">Horaires indisponibles pour l'instant (${escapeHtml(err.message)}) — réessayez dans quelques secondes.</p>`
    );
  }
}

function loadMore() {
  if (!state.cursor) return;
  const btn = el("train-more");
  if (btn) { btn.disabled = true; btn.textContent = "Chargement…"; }
  loadDepartures({ append: true });
}

function setFilter(key) {
  if (state.filter === key) return;
  state.filter = key;
  localStorage.setItem(FILTER_KEY, key);
  loadDepartures();
}

function selectStop(stop) {
  state.stop = { ...stop };
  state.suggestions = [];
  renderSuggest();
  const input = el("train-search");
  if (input) { input.value = ""; input.blur(); }
  pushRecent(stop);
  state.stopMarkers.clear();
  pinStop(stop);
  // On s'approche sans écraser le cadrage : la gare doit entrer dans le champ, pas
  // remplacer la vue du massif qu'on était en train de regarder.
  flyToL(stop.lat, stop.lon, Math.max(map.getZoom(), 12), { duration: 800 });
  loadDepartures();
  // Un tableau des départs vieillit vite : on le rafraîchit tant que le panneau est ouvert
  // sur un arrêt (et jamais en tâche de fond une fois refermé).
  clearInterval(state.refresher);
  state.refresher = setInterval(() => { if (state.open && state.stop && !state.loading) loadDepartures(); }, 60000);
}

function backToHome() {
  state.stop = null;
  state.rows = [];
  state.cursor = null;
  state.controller?.abort();
  clearInterval(state.refresher);
  state.pinMarker?.remove();
  state.pinMarker = null;
  showStopMarkers(state.nearby);
  render();
  loadNearby();
}

// ---------- Recherche ----------
function initSearch() {
  const input = el("train-search");
  const box = el("train-suggest");
  if (!input || !box) return;

  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(state.timer);
    if (q.length < MIN_CHARS) {
      state.suggestions = [];
      renderSuggest();
      return;
    }
    state.timer = setTimeout(async () => {
      const c = new AbortController();
      state.searchCtrl?.abort();
      state.searchCtrl = c;
      box.innerHTML = `<div class="geo-empty geo-loading">Recherche…</div>`;
      box.classList.remove("hidden");
      try {
        const center = map.getCenter();
        state.suggestions = await searchStops(q, { signal: c.signal, near: [center.lat, center.lng] });
        renderSuggest();
        if (!state.suggestions.length) {
          box.innerHTML = `<div class="geo-empty">Aucun arrêt « ${escapeHtml(q)} ».</div>`;
          box.classList.remove("hidden");
        }
      } catch {
        if (c.signal.aborted) return;
        box.innerHTML = `<div class="geo-empty">Recherche indisponible — réessayez.</div>`;
        box.classList.remove("hidden");
      }
    }, DEBOUNCE_MS);
  });

  // Entrée : si la liste est déjà là, on prend le premier ; sinon on attend la recherche
  // en cours plutôt que de ne rien faire (frappe rapide puis Entrée = cas courant).
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") { state.suggestions = []; renderSuggest(); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = input.value.trim();
    if (state.suggestions[0]) { selectStop(state.suggestions[0]); return; }
    if (q.length < MIN_CHARS) return;
    try {
      const center = map.getCenter();
      state.suggestions = await searchStops(q, { near: [center.lat, center.lng] });
      renderSuggest();
      if (state.suggestions[0]) selectStop(state.suggestions[0]);
    } catch { /* la liste affiche déjà l'échec */ }
  });

  // `mousedown` avant le blur, comme geosearch.js : le champ garde le focus.
  box.addEventListener("mousedown", (e) => {
    const row = e.target.closest("[data-stop]");
    if (!row) return;
    e.preventDefault();
    const s = state.suggestions.find((x) => x.id === row.dataset.stop);
    if (s) selectStop(s);
  });

  // Listes du corps du panneau (récents, zone) : simple clic.
  el("train-scroll").addEventListener("click", (e) => {
    const row = e.target.closest("[data-stop]");
    if (!row) return;
    const s = findStop(row.dataset.stop);
    if (s) selectStop(s);
  });
}

// ---------- Bottom-sheet mobile ----------
// Même mécanique que le planificateur (deux crans, le doigt colle, snap à l'élan) : c'est
// le geste déjà appris dans le reste de l'app, il n'y a rien à réapprendre ici.
function initSheet() {
  const panel = el("train-panel");
  const grip = el("train-sheet-grip");
  const head = panel.querySelector(".plan-panel-head");
  const isMobile = () => window.matchMedia("(max-width: 700px)").matches;

  let dragging = false, moved = false, startY = 0, baseY = 0, curY = 0, maxY = 0;
  let lastY = 0, lastT = 0, vel = 0;

  const peek = () => grip.offsetHeight + (head?.offsetHeight || 0) + 12;
  const setY = (y) => { curY = y; panel.style.setProperty("--sheet-y", `${y}px`); };
  const collapse = () => { panel.classList.add("sheet-collapsed"); setY(maxY); };
  const expand = () => { panel.classList.remove("sheet-collapsed"); setY(0); };

  state.sheetReset = () => {
    panel.classList.remove("sheet-collapsed", "sheet-dragging");
    panel.style.removeProperty("--sheet-y");
    curY = 0;
  };

  const onDown = (e) => {
    if (!isMobile() || dragging) return;
    if (e.target.closest("button") && !e.target.closest("#train-sheet-grip")) return;
    if (e.target.closest("input")) return; // la saisie ne doit pas armer le glissement
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
    if (moved) e.preventDefault();
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove("sheet-dragging");
    if (!moved) {
      if (e.target.closest("#train-sheet-grip")) panel.classList.contains("sheet-collapsed") ? expand() : collapse();
      return;
    }
    (vel > 0.35 || (vel >= -0.35 && curY > maxY * 0.4)) ? collapse() : expand();
  };

  grip.addEventListener("pointerdown", onDown);
  head?.addEventListener("pointerdown", onDown);
  document.addEventListener("pointermove", onMove, { passive: false });
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", () => {
    if (dragging) { dragging = false; panel.classList.remove("sheet-dragging"); }
  });
  grip.addEventListener("keydown", (e) => {
    if (!isMobile() || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    maxY = Math.max(0, panel.offsetHeight - peek());
    panel.classList.contains("sheet-collapsed") ? expand() : collapse();
  });
}

// ---------- Ouverture / fermeture ----------
export function openTrains() {
  if (state.open) { closeTrains(); return; }
  switchTab("carte");                       // le panneau vit sur la carte
  state.open = true;
  // `loops-active` est la classe qui écarte la chrome de carte concurrente (feuille
  // Explorer, dock de recherche) — même contrat que le planificateur et le générateur
  // de boucle : un seul grand panneau à la fois.
  document.body.classList.add("loops-active");
  el("train-panel").classList.remove("hidden");
  el("sheet-trains")?.classList.add("active");
  state.sheetReset?.();
  render();
  loadNearby();
}

export function closeTrains() {
  state.open = false;
  state.controller?.abort();
  state.searchCtrl?.abort();
  clearTimeout(state.timer);
  clearInterval(state.refresher);
  state.stop = null;
  state.rows = [];
  state.cursor = null;
  state.suggestions = [];
  state.stopMarkers.clear();
  state.pinMarker?.remove();
  state.pinMarker = null;
  renderSuggest();
  el("train-search").value = "";
  el("train-panel").classList.add("hidden");
  el("sheet-trains")?.classList.remove("active");
  document.body.classList.remove("loops-active");
  state.sheetReset?.();
}

// Le module est chargé à la demande (explorer.js, patron S11) : `initTrains` est appelé à
// chaque ouverture et doit donc être idempotent — sans ce garde, chaque tap sur « Trains »
// empilerait un jeu d'écouteurs de plus.
let wired = false;
export function initTrains() {
  if (wired || !el("train-panel")) return;
  wired = true;
  initSearch();
  initSheet();
  el("train-close")?.addEventListener("click", closeTrains);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.open && !state.suggestions.length) closeTrains();
  });
}
