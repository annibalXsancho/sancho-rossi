// Sancho Rossi — filtres et tri des itinéraires + panneau de filtres partagé
import { state, allTrails, gainOf, estDurationH } from "./state.js";
import { renderAll, renderList } from "./trails.js";
import { fetchRetry } from "./net.js";

// ---------- Prédicats de critères terrain ----------
// L'info eau/refuge n'est fiable que pour la graine curée : les tracés OSM chargés à la
// demande la portent en "—" (inconnue) → écartés quand le critère est actif (assumé).
export function hasWater(t) {
  const e = (t.eau || "").trim();
  return e !== "" && e !== "—";
}
const SHELTER_RE = /refuge|rifug|h[üu]tte|\bhut\b|cabane|abri|bivacco|biwak|malga|\balpe\b|chalet|baita|capanna/i;
export function hasShelter(t) {
  return SHELTER_RE.test(`${t.name} ${t.description || ""} ${t.eau || ""} ${t.bivouacSpot || ""}`);
}

// Tous les critères SAUF le temps de route (synchrones, évalués à chaque rendu).
function passesFilters(t, q) {
  if (state.favoritesOnly && !state.favorites.has(t.id)) return false;
  if (state.source === "bivouac" && t.osm) return false;
  if (state.source === "osm" && !t.osm) return false;
  if (state.days && String(t.days) !== state.days) return false;
  if (state.difficulty && t.difficulty !== state.difficulty) return false;
  if (state.region && t.region !== state.region) return false;
  if (state.type && t.type !== state.type) return false;
  if (state.distMin != null && t.distance < state.distMin) return false;
  if (state.distMax != null && t.distance > state.distMax) return false;
  if (state.gainMin != null) {
    const g = gainOf(t);
    if (g == null || g < state.gainMin) return false;
  }
  if (state.gainMax != null) {
    const g = gainOf(t);
    if (g != null && g > state.gainMax) return false;
  }
  if (state.durMax != null && estDurationH(t) > state.durMax) return false;
  if (state.needsWater && !hasWater(t)) return false;
  if (state.needsShelter && !hasShelter(t)) return false;
  if (q) {
    const haystack = `${t.name} ${t.location} ${t.region}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

export function filteredTrails() {
  const q = state.search.trim().toLowerCase();
  let list = allTrails().filter((t) => passesFilters(t, q));

  // Temps de route : ne garder que les tracés dont le trajet voiture est confirmé ≤ seuil.
  // Tant que rien n'est calculé (premier appel ou panne OSRM), on n'écrase pas la liste :
  // le filtre ne s'active qu'une fois le cache peuplé par ensureDriveTimes (OSRM Table).
  if (state.driveMax != null && state.userPos && driveCache.size) {
    list = list.filter((t) => {
      const min = driveCache.get(t.id);
      return typeof min === "number" && min <= state.driveMax * 60;
    });
  }

  const sorters = {
    reco: (a, b) =>
      (b.bivouac ? 1 : 0) - (a.bivouac ? 1 : 0) ||
      (a.osm ? 1 : 0) - (b.osm ? 1 : 0) ||
      (gainOf(b) ?? 0) - (gainOf(a) ?? 0),
    "distance-asc": (a, b) => a.distance - b.distance,
    "distance-desc": (a, b) => b.distance - a.distance,
    "duration-asc": (a, b) => estDurationH(a) - estDurationH(b),
    elevation: (a, b) => (gainOf(b) ?? 0) - (gainOf(a) ?? 0),
  };
  return list.sort(sorters[state.sortBy]);
}

// ---------- Filtre temps de route (OSRM Table, borné et différé) ----------
// Une seule requête OSRM Table couvre tous les candidats du set filtré → pas de martèlement.
const DRIVE_LIMIT = 40;
const driveCache = new Map(); // id → minutes (number) | null (injoignable)
let driveBusy = false;

function driveStatus(msg) {
  const el = document.getElementById("filter-drive-status");
  if (el) el.textContent = msg || "";
}

async function osrmTableMinutes(origin, dests) {
  const coords = [
    `${origin.lon},${origin.lat}`,
    ...dests.map((d) => `${d.center[1]},${d.center[0]}`),
  ].join(";");
  const url =
    `https://router.project-osrm.org/table/v1/driving/${coords}` +
    `?sources=0&annotations=duration`;
  const res = await fetchRetry(url, { timeout: 20000 });
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const data = await res.json();
  const secs = data.durations?.[0] ? data.durations[0].slice(1) : [];
  return secs.map((s) => (s == null ? null : s / 60));
}

// Calcule (et met en cache) les temps de route manquants du set filtré, puis re-rend.
export async function ensureDriveTimes() {
  if (driveBusy || state.driveMax == null) return;
  if (!state.userPos) {
    driveStatus("Activez 📍 ma position pour filtrer par temps de route.");
    return;
  }
  const q = state.search.trim().toLowerCase();
  const pending = allTrails().filter(
    (t) => passesFilters(t, q) && t.center && !driveCache.has(t.id)
  );
  if (!pending.length) return;
  if (pending.length > DRIVE_LIMIT) {
    driveStatus(
      `${pending.length} itinéraires : affinez d'abord les autres critères (≤ ${DRIVE_LIMIT}) pour calculer les temps de route.`
    );
    return;
  }
  driveBusy = true;
  driveStatus(`⏳ Calcul des temps de route (${pending.length})…`);
  try {
    const mins = await osrmTableMinutes(state.userPos, pending);
    pending.forEach((t, i) => driveCache.set(t.id, mins[i]));
    driveStatus("Temps de route calculés depuis votre position.");
  } catch (err) {
    driveStatus(`Temps de route indisponible (${err.message}).`);
  } finally {
    driveBusy = false;
    renderAll();
  }
}

// ---------- Panneau de filtres partagé ----------
function activeFiltersCount() {
  return [
    state.days, state.difficulty, state.source, state.region, state.type,
    state.distMin != null ? "x" : "", state.distMax != null ? "x" : "",
    state.gainMin != null ? "x" : "", state.gainMax != null ? "x" : "",
    state.durMax != null ? "x" : "", state.needsWater ? "x" : "",
    state.needsShelter ? "x" : "", state.driveMax != null ? "x" : "",
  ].filter(Boolean).length;
}

// Le catalogue étant chargé à la demande, la liste des régions est reconstruite
// à partir des tracés actuellement chargés (rafraîchie à l'ouverture des filtres).
export function refreshRegionOptions() {
  const sel = document.getElementById("filter-region");
  const current = state.region;
  [...sel.querySelectorAll("option")].forEach((o) => { if (o.value) o.remove(); });
  [...new Set(allTrails().map((t) => t.region).filter(Boolean))].sort().forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = r;
    sel.appendChild(opt);
  });
  sel.value = current;
}

export function updateFiltersBadge(resultCount) {
  const n = activeFiltersCount();
  ["filters-badge", "sheet-filters-badge"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = n;
    el.classList.toggle("hidden", n === 0);
  });
  document.getElementById("filters-count").textContent =
    `${resultCount ?? filteredTrails().length} itinéraire${(resultCount ?? 0) > 1 ? "s" : ""}`;
}

// Ouvre la modale de filtres (aussi appelée depuis le pont « Affiner par critères » de l'accueil).
export function openFilters() {
  document.getElementById("filters-modal").classList.remove("hidden");
  refreshRegionOptions();
  updateFiltersBadge(filteredTrails().length);
}

// Un changement de filtre re-rend puis, si le filtre temps de route est actif, complète
// le cache OSRM pour les nouveaux candidats (no-op sinon).
function refresh() {
  renderAll();
  ensureDriveTimes();
}

export function initFilters() {
  const filtersModal = document.getElementById("filters-modal");

  function closeFilters() {
    filtersModal.classList.add("hidden");
  }

  document.getElementById("filters-close").addEventListener("click", closeFilters);
  document.getElementById("filters-apply").addEventListener("click", closeFilters);
  filtersModal.addEventListener("click", (e) => { if (e.target === filtersModal) closeFilters(); });

  function bindNumberFilter(id, key) {
    document.getElementById(id).addEventListener("input", (e) => {
      state[key] = e.target.value === "" ? null : Number(e.target.value);
      refresh();
    });
  }
  bindNumberFilter("filter-dist-min", "distMin");
  bindNumberFilter("filter-dist-max", "distMax");
  bindNumberFilter("filter-gain-min", "gainMin");
  bindNumberFilter("filter-gain-max", "gainMax");
  bindNumberFilter("filter-dur-max", "durMax");

  // Critères terrain : chips à bascule indépendantes (eau, refuge).
  document.querySelectorAll("#filter-terrain .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const key = chip.dataset.terrain === "water" ? "needsWater" : "needsShelter";
      state[key] = !state[key];
      chip.classList.toggle("active", state[key]);
      refresh();
    });
  });

  // Temps de route depuis ma position (borné, OSRM Table à la demande).
  document.getElementById("filter-drive-pos").addEventListener("click", (e) => {
    driveStatus("⏳ Localisation…");
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        state.userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        driveCache.clear();
        e.currentTarget.classList.add("faved");
        driveStatus("Position acquise.");
        refresh();
      },
      (err) => driveStatus(`Position indisponible : ${err.message}`)
    );
  });
  document.getElementById("filter-drive-max").addEventListener("input", (e) => {
    state.driveMax = e.target.value === "" ? null : Number(e.target.value);
    refresh();
  });

  document.getElementById("filters-reset").addEventListener("click", () => {
    Object.assign(state, {
      days: "", difficulty: "", source: "", region: "", type: "",
      distMin: null, distMax: null, gainMin: null, gainMax: null, durMax: null,
      needsWater: false, needsShelter: false, driveMax: null, userPos: null, search: "",
    });
    driveCache.clear();
    document.querySelectorAll("#filters-modal .filter-group").forEach((g) => {
      g.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.value === ""));
    });
    ["filter-region", "filter-type"].forEach((id) => (document.getElementById(id).value = ""));
    ["filter-dist-min", "filter-dist-max", "filter-gain-min", "filter-gain-max",
      "filter-dur-max", "filter-drive-max"].forEach(
      (id) => (document.getElementById(id).value = "")
    );
    document.getElementById("filter-drive-pos").classList.remove("faved");
    driveStatus("");
    document.getElementById("search-input").value = "";
    renderAll();
  });

  // ---------- Contrôles carte ----------
  document.getElementById("search-input").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderList();
  });

  function bindChips(groupId, key) {
    document.querySelectorAll(`#${groupId} .chip`).forEach((chip) => {
      chip.addEventListener("click", () => {
        document.querySelectorAll(`#${groupId} .chip`).forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        state[key] = chip.dataset.value;
        refresh();
      });
    });
  }
  bindChips("filter-days", "days");
  bindChips("filter-difficulty", "difficulty");
  bindChips("filter-source", "source");

  const regionSelect = document.getElementById("filter-region");
  refreshRegionOptions();
  regionSelect.addEventListener("change", (e) => { state.region = e.target.value; refresh(); });
  document.getElementById("filter-type").addEventListener("change", (e) => { state.type = e.target.value; refresh(); });
  document.getElementById("sort-by").addEventListener("change", (e) => { state.sortBy = e.target.value; renderAll(); });
}
