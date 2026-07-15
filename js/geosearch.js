// Sancho Rossi — recherche par lieu (S7)
// Le champ de recherche de la carte devient un géocodeur : en tapant un lieu
// (« Chamonix », « Dolomites », « Massif des Écrins »…), une liste de suggestions
// apparaît ; la sélection recentre la carte, ce qui déclenche le chargement à la
// demande des tracés de la zone (catalog.js sur `moveend`). Le filtre texte local de
// la liste reste actif en parallèle (géré dans filters.js).
//
// Géocodeur : Nominatim (OpenStreetMap). Open-Meteo (spec initiale) trie par
// population → il égarait les massifs (« Mont Blanc » → Maurice, « Dolomites » → un
// barrage du Montana, « Triglav » → Bulgarie). Nominatim couvre les reliefs européens
// et renvoie une bbox par résultat, qui sert à cadrer la vue (serré pour une ville,
// large pour un massif). Politique d'usage : ≤ 1 req/s → débounce confortable, requête
// annulée à chaque frappe, mono-utilisateur donc largement dans les clous.
import { state } from "./state.js";
import { map } from "./map.js";
import { switchTab } from "./ui.js";
import { renderList } from "./trails.js";

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

let box, input, controller, timer;
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
  loadingRow();
  try {
    const url =
      `${GEO_URL}?q=${encodeURIComponent(q)}&format=jsonv2` +
      `&limit=6&addressdetails=1&accept-language=fr`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error();
    results = (await res.json()).map(shape);
    activeIdx = -1;
    render(q);
  } catch (err) {
    if (err.name === "AbortError") return; // remplacée par une frappe plus récente
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

// Recentre la carte sur le lieu choisi : le `moveend` déclenche le chargement des
// tracés de la zone. On cadre sur la bbox du lieu (bornée pour rester dans la plage
// de zoom qui charge le catalogue), et on vide le filtre texte pour ne pas masquer
// la nouvelle liste.
function fly(r) {
  input.value = "";
  if (state.search) {
    state.search = "";
    renderList();
  }
  hide();
  results = [];
  if (state.view !== "carte") switchTab("carte");

  if (r.bounds) {
    const b = L.latLngBounds(r.bounds);
    let z = map.getBoundsZoom(b);
    z = Math.max(FIT_MIN_ZOOM, Math.min(FIT_MAX_ZOOM, z));
    map.flyTo(b.getCenter(), z, { duration: 0.9 });
  } else {
    map.flyTo([r.lat, r.lon], FIT_MAX_ZOOM, { duration: 0.9 });
  }
}

function pick(i) {
  const r = results[i];
  if (r) fly(r);
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

export function initGeoSearch() {
  input = document.getElementById("search-input");
  box = document.getElementById("search-suggest");
  if (!input || !box) return;

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
    if (!e.target.closest(".map-search")) hide();
  });
}
