// Sancho Rossi — filtres et tri des itinéraires + panneau de filtres partagé
import { state, allTrails } from "./state.js";
import { renderAll, renderList } from "./trails.js";

export function filteredTrails() {
  const q = state.search.trim().toLowerCase();
  let list = allTrails().filter((t) => {
    if (state.favoritesOnly && !state.favorites.has(t.id)) return false;
    if (state.source === "bivouac" && t.osm) return false;
    if (state.source === "osm" && !t.osm) return false;
    if (state.days && String(t.days) !== state.days) return false;
    if (state.difficulty && t.difficulty !== state.difficulty) return false;
    if (state.region && t.region !== state.region) return false;
    if (state.type && t.type !== state.type) return false;
    if (state.distMin != null && t.distance < state.distMin) return false;
    if (state.distMax != null && t.distance > state.distMax) return false;
    if (state.gainMax != null) {
      const g = t.elevationGain ?? state.elev[t.id]?.gain;
      if (g != null && g > state.gainMax) return false;
    }
    if (q) {
      const haystack = `${t.name} ${t.location} ${t.region}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const gain = (t) => t.elevationGain ?? state.elev[t.id]?.gain ?? 0;
  const sorters = {
    reco: (a, b) =>
      (b.bivouac ? 1 : 0) - (a.bivouac ? 1 : 0) ||
      (a.osm ? 1 : 0) - (b.osm ? 1 : 0) ||
      gain(b) - gain(a),
    "distance-asc": (a, b) => a.distance - b.distance,
    "distance-desc": (a, b) => b.distance - a.distance,
    elevation: (a, b) => gain(b) - gain(a),
  };
  return list.sort(sorters[state.sortBy]);
}

// ---------- Panneau de filtres partagé ----------
function activeFiltersCount() {
  return [
    state.days, state.difficulty, state.source, state.region, state.type,
    state.distMin != null ? "x" : "", state.distMax != null ? "x" : "",
    state.gainMax != null ? "x" : "",
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
  ["filters-badge", "filters-badge-2"].forEach((id) => {
    const el = document.getElementById(id);
    el.textContent = n;
    el.classList.toggle("hidden", n === 0);
  });
  document.getElementById("filters-count").textContent =
    `${resultCount ?? filteredTrails().length} itinéraire${(resultCount ?? 0) > 1 ? "s" : ""}`;
}

export function initFilters() {
  const filtersModal = document.getElementById("filters-modal");

  function openFilters() {
    filtersModal.classList.remove("hidden");
    refreshRegionOptions();
    updateFiltersBadge(filteredTrails().length);
  }

  function closeFilters() {
    filtersModal.classList.add("hidden");
  }

  document.getElementById("btn-filters-map").addEventListener("click", openFilters);
  document.getElementById("btn-filters-grid").addEventListener("click", openFilters);
  document.getElementById("filters-close").addEventListener("click", closeFilters);
  document.getElementById("filters-apply").addEventListener("click", closeFilters);
  filtersModal.addEventListener("click", (e) => { if (e.target === filtersModal) closeFilters(); });

  function bindNumberFilter(id, key) {
    document.getElementById(id).addEventListener("input", (e) => {
      state[key] = e.target.value === "" ? null : Number(e.target.value);
      renderAll();
    });
  }
  bindNumberFilter("filter-dist-min", "distMin");
  bindNumberFilter("filter-dist-max", "distMax");
  bindNumberFilter("filter-gain-max", "gainMax");

  document.getElementById("filters-reset").addEventListener("click", () => {
    Object.assign(state, {
      days: "", difficulty: "", source: "", region: "", type: "",
      distMin: null, distMax: null, gainMax: null, search: "",
    });
    document.querySelectorAll("#filters-modal .filter-group").forEach((g) => {
      g.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.value === ""));
    });
    ["filter-region", "filter-type"].forEach((id) => (document.getElementById(id).value = ""));
    ["filter-dist-min", "filter-dist-max", "filter-gain-max"].forEach(
      (id) => (document.getElementById(id).value = "")
    );
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
        renderAll();
      });
    });
  }
  bindChips("filter-days", "days");
  bindChips("filter-difficulty", "difficulty");
  bindChips("filter-source", "source");

  const regionSelect = document.getElementById("filter-region");
  refreshRegionOptions();
  regionSelect.addEventListener("change", (e) => { state.region = e.target.value; renderAll(); });
  document.getElementById("filter-type").addEventListener("change", (e) => { state.type = e.target.value; renderAll(); });
  document.getElementById("sort-by").addEventListener("change", (e) => { state.sortBy = e.target.value; renderAll(); });
}
