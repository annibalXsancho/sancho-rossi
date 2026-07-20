// Sancho Rossi — recherche par lieu (S7) + fabrique d'autocomplétion réutilisable
// Le champ de recherche de la carte est un géocodeur : en tapant un lieu
// (« Chamonix », « Dolomites », « Massif des Écrins »…), une liste de suggestions
// apparaît ; la sélection recentre et cadre la carte sur le lieu. Le chargement des
// tracés de la zone est ensuite déclenché par le bouton « charger les sentiers »
// (catalog.js) — il était automatique sur `moveend` jusqu'à la refonte du chargement.
// Le filtre texte local de la liste reste actif en parallèle (géré dans filters.js).
//
// Géocodeur : Nominatim (OpenStreetMap). Open-Meteo (spec initiale) trie par
// population → il égarait les massifs (« Mont Blanc » → Maurice, « Dolomites » → un
// barrage du Montana, « Triglav » → Bulgarie). Nominatim couvre les reliefs européens
// et renvoie une bbox par résultat, qui sert à cadrer la vue (serré pour une ville,
// large pour un massif). Politique d'usage : ≤ 1 req/s → débounce confortable, requête
// annulée à chaque frappe, mono-utilisateur donc largement dans les clous.
//
// `createGeoSuggest` est la fabrique : le module était un singleton (état de module +
// ids câblés en dur), donc un second champ ne pouvait pas s'y brancher. Le
// planificateur (S-PLAN) en monte une deuxième instance pour son champ « point de
// passage » — d'où l'état déplacé en closure, une instance = un champ.
import { state } from "./state.js";
import { boundsOf, boundsZoomL, flyToL } from "./map.js";
import { switchTab } from "./ui.js";
import { renderList } from "./trails.js";
import { fetchRetry } from "./net.js";

const GEO_URL = "https://nominatim.openstreetmap.org/search";
const DEBOUNCE_MS = 500;
const MIN_CHARS = 3;
const FIT_MIN_ZOOM = 11;  // en deçà, le catalogue ne charge pas (catalog.js MIN_ZOOM 10)
const FIT_MAX_ZOOM = 13;  // au-delà, on dépasserait le détail utile d'un point de départ

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const PIN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11Z"/>' +
  '<circle cx="12" cy="10" r="2.4"/></svg>';

// Résultat Nominatim → { name court, sub région/pays, lat, lon, bounds }.
function shape(r) {
  const a = r.address || {};
  const name = r.name || String(r.display_name).split(",")[0].trim();
  const region = a.state || a.region || a.county || a.state_district;
  const sub = [region, a.country].filter(Boolean).join(", ");
  // boundingbox Nominatim : [sud, nord, ouest, est] (chaînes).
  const bb = r.boundingbox?.map(Number);
  const bounds =
    bb && bb.length === 4 ? [[bb[0], bb[2]], [bb[1], bb[3]]] : null;
  return { name, sub, lat: +r.lat, lon: +r.lon, bounds };
}

// Branche une autocomplétion Nominatim sur un couple champ/liste.
//   input     : <input type="text">
//   box       : conteneur des suggestions
//   onPick    : (résultat mis en forme) => void
//   container : zone « à l'intérieur » de laquelle un clic ne referme pas la liste
// → { clear() } pour vider le champ et la liste de l'extérieur.
export function createGeoSuggest({ input, box, onPick, container = input?.parentElement }) {
  if (!input || !box) return { clear() {} };
  let controller, timer;
  let results = [];
  let activeIdx = -1;

  function loadingRow() {
    box.innerHTML = `<div class="geo-empty geo-loading">Recherche…</div>`;
    box.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
  }

  async function fetchSuggest(q) {
    controller?.abort();
    controller = new AbortController();
    const ctrl = controller;   // capturé localement : distingue un abort-frappe d'un timeout
    loadingRow();
    try {
      const url =
        `${GEO_URL}?q=${encodeURIComponent(q)}&format=jsonv2` +
        `&limit=6&addressdetails=1&accept-language=fr`;
      // Pas de retry : politique Nominatim ≤ 1 req/s + recherche live (chaque frappe annule).
      const res = await fetchRetry(url, { signal: ctrl.signal, retries: 0, timeout: 12000 });
      if (!res.ok) throw new Error();
      results = (await res.json()).map(shape);
      activeIdx = -1;
      render(q);
    } catch {
      if (ctrl.signal.aborted) return; // remplacée par une frappe plus récente (pas un timeout)
      results = [];
      box.innerHTML = `<div class="geo-empty">Recherche indisponible — réessayez.</div>`;
      box.classList.remove("hidden");
    }
  }

  function render(q) {
    if (!results.length) {
      box.innerHTML = `<div class="geo-empty">Aucun lieu « ${escapeHtml(q)} ».</div>`;
      box.classList.remove("hidden");
      input.setAttribute("aria-expanded", "true");
      return;
    }
    box.innerHTML = results
      .map(
        (r, i) => `<button type="button" class="geo-item${i === activeIdx ? " active" : ""}" data-i="${i}" role="option">
          <span class="geo-pin">${PIN_SVG}</span>
          <span class="geo-text">
            <span class="geo-name">${escapeHtml(r.name)}</span>
            ${r.sub ? `<span class="geo-sub">${escapeHtml(r.sub)}</span>` : ""}
          </span>
        </button>`
      )
      .join("");
    box.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
  }

  function hide() {
    box.classList.add("hidden");
    box.innerHTML = "";
    activeIdx = -1;
    input.setAttribute("aria-expanded", "false");
  }

  function pick(i) {
    const r = results[i];
    if (r) onPick(r);
  }

  // Entrée : si des suggestions sont affichées, on prend la surlignée (sinon la
  // première) ; sinon on géocode à la volée puis on file au premier résultat.
  async function submit() {
    const q = input.value.trim();
    if (q.length < MIN_CHARS) return;
    if (!results.length) await fetchSuggest(q);
    pick(activeIdx >= 0 ? activeIdx : 0);
  }

  function move(delta) {
    if (!results.length) return;
    activeIdx = (activeIdx + delta + results.length) % results.length;
    render(input.value.trim());
    box.querySelector(".geo-item.active")?.scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < MIN_CHARS) {
      controller?.abort();
      results = [];
      hide();
      return;
    }
    timer = setTimeout(() => fetchSuggest(q), DEBOUNCE_MS);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { hide(); }
  });

  // `mousedown` (avant le blur du champ) : garde le focus et sélectionne l'item.
  box.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".geo-item");
    if (!item) return;
    e.preventDefault();
    pick(Number(item.dataset.i));
  });

  // Clic hors du champ + suggestions → on referme.
  document.addEventListener("click", (e) => {
    if (container && !container.contains(e.target)) hide();
  });

  return {
    clear() {
      input.value = "";
      results = [];
      hide();
    },
  };
}

// Recentre la carte sur le lieu choisi. On cadre sur la bbox du lieu (bornée pour
// rester dans la plage de zoom où le catalogue accepte de charger), et on vide le
// filtre texte pour ne pas masquer la nouvelle liste.
export function initGeoSearch() {
  const input = document.getElementById("search-input");
  const box = document.getElementById("search-suggest");
  if (!input || !box) return;

  const suggest = createGeoSuggest({
    input,
    box,
    container: input.closest(".map-search"),
    onPick(r) {
      suggest.clear();
      if (state.search) {
        state.search = "";
        renderList();
      }
      if (state.view !== "carte") switchTab("carte");

      if (r.bounds) {
        const b = boundsOf(r.bounds);
        const c = b.getCenter();
        const z = Math.max(FIT_MIN_ZOOM, Math.min(FIT_MAX_ZOOM, boundsZoomL(b)));
        flyToL(c.lat, c.lng, z, { duration: 900 });
      } else {
        flyToL(r.lat, r.lon, FIT_MAX_ZOOM, { duration: 900 });
      }
      closeDock();
    },
  });

  // ---------- Dock repliable (bas à droite) ----------
  const dock = document.getElementById("map-search");
  const toggle = document.getElementById("search-toggle");
  if (!dock || !toggle) return;

  const isOpen = () => dock.classList.contains("open");

  function openDock() {
    dock.classList.add("open");
    // Sur mobile, ouvrir la recherche ramène la feuille Explorer en position basse (elle
    // couvrirait la carte et les suggestions), cf. demande utilisateur.
    if (window.matchMedia("(max-width: 700px)").matches)
      document.getElementById("results-panel")?.classList.add("sheet-collapsed");
    // Ouvert, le champ occupe presque toute la largeur sur téléphone et passerait sur
    // l'attribution : on l'efface le temps de la saisie, elle revient à la fermeture.
    document.body.classList.add("search-open");
    toggle.setAttribute("aria-expanded", "true");
    input.tabIndex = 0;
    // Le focus attend la fin du déroulé : le donner tout de suite ferait remonter le
    // clavier mobile pendant l'animation, qui saute alors visiblement.
    setTimeout(() => input.focus(), 180);
  }

  function closeDock() {
    if (!isOpen()) return;
    dock.classList.remove("open");
    document.body.classList.remove("search-open");
    toggle.setAttribute("aria-expanded", "false");
    input.tabIndex = -1;
    input.value = "";
    input.blur();
    suggest.clear();
  }

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    isOpen() ? closeDock() : openDock();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeDock(); }
  });

  // Un clic ailleurs referme — mais seulement si rien n'est saisi : replier sous les
  // doigts de quelqu'un qui a commencé à taper lui ferait perdre sa recherche.
  document.addEventListener("click", (e) => {
    if (!isOpen() || dock.contains(e.target) || input.value.trim()) return;
    closeDock();
  });
}
