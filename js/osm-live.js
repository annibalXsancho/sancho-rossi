// Sancho Rossi — sentiers OSM à la volée (API Overpass)
// Module isolé exprès : S3 (chargement à la demande) le remplacera d'un bloc.
import { state, CATALOG, normalizeOsmTrail, trackDistanceKm } from "./state.js";
import { overpassFetch } from "./api.js";
import { map } from "./map.js";
import { selectTrail } from "./trails.js";

let osmLayer = null;

function showOsmResults(relations) {
  const osmResultsEl = document.getElementById("osm-results");
  if (osmLayer) osmLayer.remove();
  const known = new Set(CATALOG.map((t) => t.id));
  state.osmLive = relations
    .map((rel) => {
      if (known.has(`osmc-${rel.id}`)) return null;
      const segments = (rel.members || [])
        .filter((m) => m.type === "way" && m.geometry)
        .map((m) => m.geometry.map((g) => [g.lat, g.lon]));
      const track = segments.flat();
      if (track.length < 2) return null;
      const tags = rel.tags || {};
      const parts = [tags.from && `de ${tags.from}`, tags.to && `à ${tags.to}`].filter(Boolean).join(" ");
      return normalizeOsmTrail({
        id: `osm-${rel.id}`,
        osm: true,
        name: tags.name || tags.ref || `Sentier OSM ${rel.id}`,
        location: parts || "Itinéraire balisé OpenStreetMap",
        region: "Sentiers OSM",
        difficulty: tags.sac_scale ? tags.sac_scale.replace(/_/g, " ") : "non renseignée",
        type: "balisé",
        days: null,
        bivouac: false,
        distance: Math.round(trackDistanceKm(track) * 10) / 10,
        elevationGain: null,
        altMax: null,
        duration: "—",
        center: track[Math.floor(track.length / 2)],
        gradient: "linear-gradient(135deg, #4a5d8a, #8fa3cc)",
        description:
          `Itinéraire balisé issu d'OpenStreetMap${tags.ref ? ` (réf. ${tags.ref})` : ""}` +
          `${tags.network ? `, réseau ${tags.network}` : ""}. Tracé réel relevé par la communauté — exportable en GPX.`,
        eau: "—",
        bivouacSpot: "—",
        periode: "—",
        track,
        segments,
      });
    })
    .filter(Boolean)
    .sort((a, b) => b.distance - a.distance);

  osmLayer = L.layerGroup(
    state.osmLive.map((t) =>
      L.polyline(t.segments, { color: "#7b4bb7", weight: 3, opacity: 0.7 })
        .on("click", () => selectTrail(t.id, { pan: false }))
    )
  ).addTo(map);

  osmResultsEl.innerHTML = state.osmLive.length
    ? `<div class="osm-head">🟣 ${state.osmLive.length} sentier${state.osmLive.length > 1 ? "s" : ""} supplémentaire${state.osmLive.length > 1 ? "s" : ""} dans la zone
         <button id="osm-clear" title="Effacer">✕</button></div>` +
      state.osmLive
        .map(
          (t) => `
        <button class="osm-item" data-id="${t.id}">
          <strong>${t.name}</strong>
          <span>${t.distance} km</span>
        </button>`
        )
        .join("")
    : `<div class="osm-head">Aucun sentier supplémentaire trouvé (les balisés officiels sont déjà dans le catalogue).</div>`;

  osmResultsEl.querySelectorAll(".osm-item").forEach((el) =>
    el.addEventListener("click", () => selectTrail(el.dataset.id))
  );
  osmResultsEl.querySelector("#osm-clear")?.addEventListener("click", () => {
    state.osmLive = [];
    osmLayer?.remove();
    osmResultsEl.innerHTML = "";
  });
}

export function initOsmLive() {
  const osmBtn = document.getElementById("btn-osm-search");
  osmBtn.addEventListener("click", async () => {
    if (map.getZoom() < 10) {
      alert("Zoomez davantage (une vallée ou un massif) avant de chercher les sentiers.");
      return;
    }
    const b = map.getBounds();
    const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
    const query = `[out:json][timeout:25];relation["route"="hiking"](${bbox});out geom 40;`;

    osmBtn.disabled = true;
    osmBtn.textContent = "⏳";
    try {
      const data = await overpassFetch(query);
      showOsmResults(data.elements || []);
    } catch (err) {
      alert(`Recherche impossible (${err.message}). Réessayez dans quelques secondes.`);
    } finally {
      osmBtn.disabled = false;
      osmBtn.textContent = "🔎";
    }
  });
}
