// Sancho Rossi — rendu des cartes d'itinéraires, favoris, sélection, GPX import/export
import { state, BASE_TRAILS as TRAILS, CATALOG, getTrail, trackOf, trackDistanceKm } from "./state.js";
import { photoStyle } from "./photos.js";
import { filteredTrails, updateFiltersBadge } from "./filters.js";
import { map, markers, addMarker, drawActiveTrack } from "./map.js";
import { renderDetail, closeDetail } from "./detail.js";
import { switchTab } from "./ui.js";

// ---------- Rendu des cartes d'itinéraires ----------
export function cardHTML(t) {
  const faved = state.favorites.has(t.id);
  const gain = t.elevationGain ?? state.elev[t.id]?.gain;
  return `
  <article class="trail-card ${t.id === state.selectedId ? "selected" : ""}" data-id="${t.id}">
    <div class="card-photo" style="${photoStyle(t)}">
      <button class="card-fav ${faved ? "faved" : ""}" data-fav="${t.id}" title="${faved ? "Retirer" : "Enregistrer"}">${faved ? "♥" : "♡"}</button>
      ${t.imported
        ? `<span class="card-badge badge-gpx">${t.custom ? "Mon circuit" : "GPX importé"}</span>`
        : t.osm
        ? `<span class="card-badge badge-gpx">Balisé officiel</span>`
        : `<span class="card-badge badge-${t.difficulty}">${t.difficulty}</span>`}
      ${t.bivouac ? `<span class="card-badge badge-bivouac">⛺ 2 j</span>` : ""}
    </div>
    <div class="card-body">
      <h3 class="card-title">${t.name}</h3>
      <div class="card-location">${t.location}</div>
      <div class="card-meta">
        <span>${t.distance} km</span>
        <span class="dot">•</span>
        <span>${gain ? `${Math.round(gain)} m D+` : "D+ à calculer"}</span>
        <span class="dot">•</span>
        <span>${t.duration}</span>
      </div>
    </div>
  </article>`;
}

function bindCardEvents(container) {
  container.addEventListener("click", (e) => {
    const favBtn = e.target.closest("[data-fav]");
    if (favBtn) {
      toggleFavorite(favBtn.dataset.fav);
      return;
    }
    const card = e.target.closest(".trail-card");
    if (card) selectTrail(card.dataset.id);
  });
}

export function renderList() {
  const listEl = document.getElementById("trail-list");
  const countEl = document.getElementById("results-count");
  const trails = filteredTrails();
  countEl.textContent = `${trails.length} itinéraire${trails.length > 1 ? "s" : ""}`;
  listEl.innerHTML = trails.length
    ? trails.slice(0, 80).map(cardHTML).join("") +
      (trails.length > 80 ? `<p class="muted" style="text-align:center">… et ${trails.length - 80} autres (affinez les filtres)</p>` : "")
    : `<div class="empty-state"><div class="empty-icon">🥾</div><p>Aucun itinéraire ne correspond.</p></div>`;

  // Les itinéraires exclus par les filtres disparaissent aussi de la carte
  const visible = new Set(trails.map((t) => t.id));
  markers.forEach((marker, id) => {
    if (visible.has(id) || id === state.selectedId) {
      if (!map.hasLayer(marker)) marker.addTo(map);
    } else if (map.hasLayer(marker)) {
      marker.remove();
    }
  });
  updateFiltersBadge(trails.length);
}

function renderGrid() {
  const trails = filteredTrails();
  const total = [...state.imported, ...TRAILS, ...CATALOG].length;
  document.getElementById("grid-count").textContent = `(${trails.length}/${total})`;
  document.getElementById("grid-list").innerHTML = trails.length
    ? trails.map(cardHTML).join("")
    : `<div class="empty-state"><div class="empty-icon">🥾</div><p>Aucun itinéraire ne correspond aux filtres.</p></div>`;
}

function renderHome() {
  document.getElementById("home-tagline").textContent =
    `Italie du Nord · ${TRAILS.length + CATALOG.length} itinéraires dont ${CATALOG.length} tracés balisés officiels · hors-ligne et sans compte.`;
  document.getElementById("home-suggestions").innerHTML =
    TRAILS.filter((t) => t.bivouac).slice(0, 3).map(cardHTML).join("");
}

export function renderAll() {
  renderList();
  renderGrid();
  renderHome();
  if (state.selectedId && getTrail(state.selectedId)) renderDetail(state.selectedId);
}

// ---------- Favoris ----------
export function toggleFavorite(id) {
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  localStorage.setItem("sr-favorites", JSON.stringify([...state.favorites]));
  renderAll();
  renderFavCount();
}

export function renderFavCount() {
  document.getElementById("fav-count").textContent = state.favorites.size;
}

// ---------- Sélection d'un itinéraire ----------
export function selectTrail(id, { pan = true, openDetail = true } = {}) {
  state.selectedId = id;
  const trail = getTrail(id);

  const line = drawActiveTrack(trail);
  if (pan) map.fitBounds(line.getBounds(), { padding: [60, 60], maxZoom: 14 });

  renderList();
  if (openDetail) renderDetail(id);
}

// ---------- GPX : export ----------
// Pleine résolution, un <trkseg> par tronçon : pas de lignes droites entre
// segments disjoints, pas de sous-échantillonnage.
function trailToGPX(trail) {
  const segs = trail.segments || [trail.track];
  // Altitudes incluses seulement si relevées point par point (GPX importés)
  const eles = trail.eles && trail.eles.length === trackOf(trail).length ? trail.eles : null;
  let k = 0;
  const segXml = segs
    .map(
      (seg) =>
        "    <trkseg>\n" +
        seg
          .map(([lat, lon]) => {
            const e = eles ? `<ele>${Math.round(eles[k++])}</ele>` : "";
            return `      <trkpt lat="${lat}" lon="${lon}">${e}</trkpt>`;
          })
          .join("\n") +
        "\n    </trkseg>"
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Sancho Rossi" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${trail.name}</name></metadata>
  <trk>
    <name>${trail.name}</name>
${segXml}
  </trk>
</gpx>`;
}

export function downloadGPX(trail) {
  const blob = new Blob([trailToGPX(trail)], { type: "application/gpx+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${trail.id}.gpx`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- GPX : import ----------
function parseGPX(xmlText, fileName) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("XML invalide");
  let pts = [...doc.querySelectorAll("trkpt")];
  if (!pts.length) pts = [...doc.querySelectorAll("rtept")];
  if (pts.length < 2) throw new Error("aucun point de trace (trkpt/rtept)");

  const track = pts.map((p) => [parseFloat(p.getAttribute("lat")), parseFloat(p.getAttribute("lon"))]);
  const eles = pts.map((p) => parseFloat(p.querySelector("ele")?.textContent)).filter((v) => !isNaN(v));

  let dPlus = 0;
  for (let i = 1; i < eles.length; i++) {
    const diff = eles[i] - eles[i - 1];
    if (diff > 0) dPlus += diff;
  }

  const name =
    doc.querySelector("trk > name")?.textContent.trim() ||
    doc.querySelector("metadata > name")?.textContent.trim() ||
    fileName.replace(/\.gpx$/i, "");

  return {
    id: `gpx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    imported: true,
    name,
    location: "Tracé GPX personnel",
    region: "Mes GPX",
    difficulty: "importé",
    type: "importé",
    days: null,
    bivouac: false,
    distance: Math.round(trackDistanceKm(track) * 10) / 10,
    elevationGain: Math.round(dPlus),
    altMax: eles.length ? Math.round(Math.max(...eles)) : null,
    duration: "—",
    center: track[Math.floor(track.length / 2)],
    gradient: "linear-gradient(135deg, #2d6a2f, #71b280)",
    description: `Fichier « ${fileName} » importé le ${new Date().toLocaleDateString("fr-FR")} — ${track.length} points de trace.`,
    eau: "—",
    bivouacSpot: "—",
    periode: "—",
    track,
    eles,
  };
}

export function deleteImported(id) {
  state.imported = state.imported.filter((t) => t.id !== id);
  localStorage.setItem("sr-gpx", JSON.stringify(state.imported));
  markers.get(id)?.remove();
  markers.delete(id);
  state.favorites.delete(id);
  localStorage.setItem("sr-favorites", JSON.stringify([...state.favorites]));
  closeDetail();
  renderAll();
  renderFavCount();
}

export function initTrails() {
  bindCardEvents(document.getElementById("trail-list"));
  bindCardEvents(document.getElementById("grid-list"));
  bindCardEvents(document.getElementById("home-suggestions"));
  bindCardEvents(document.getElementById("agent-output"));

  const favBtnEl = document.getElementById("btn-favorites");
  favBtnEl.addEventListener("click", () => {
    state.favoritesOnly = !state.favoritesOnly;
    favBtnEl.classList.toggle("active", state.favoritesOnly);
    switchTab("carte");
    renderList();
  });

  const gpxInput = document.getElementById("gpx-file-input");
  document.getElementById("btn-import-gpx").addEventListener("click", () => gpxInput.click());

  gpxInput.addEventListener("change", async () => {
    const errors = [];
    let lastId = null;
    for (const file of gpxInput.files) {
      try {
        const trail = parseGPX(await file.text(), file.name);
        state.imported.unshift(trail);
        addMarker(trail);
        lastId = trail.id;
      } catch (err) {
        errors.push(`${file.name} : ${err.message}`);
      }
    }
    gpxInput.value = "";
    localStorage.setItem("sr-gpx", JSON.stringify(state.imported));
    renderAll();
    if (lastId) {
      switchTab("carte");
      selectTrail(lastId);
    }
    if (errors.length) alert("Import impossible —\n" + errors.join("\n"));
  });

  // Liste repliable (mobile : repliée par défaut pour laisser la carte respirer)
  const resultsPanel = document.getElementById("results-panel");
  document.getElementById("btn-list").addEventListener("click", () =>
    resultsPanel.classList.toggle("collapsed")
  );
  if (window.innerWidth < 700) resultsPanel.classList.add("collapsed");

  document.getElementById("panel-collapse").addEventListener("click", () => {
    resultsPanel.classList.toggle("collapsed");
  });
}
