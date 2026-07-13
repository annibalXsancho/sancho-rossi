// Sancho Rossi — créateur de parcours : dessin libre snappé (BRouter) + tracés existants
import { state, trackOf, haversineKm } from "./state.js";
import { map, addMarker } from "./map.js";
import { renderAll, selectTrail } from "./trails.js";
import { closeDetail } from "./detail.js";

export const builder = {
  active: false,
  mode: "draw",
  steps: [],          // {kind:'trail'|'leg', name, distance, track, segments?, eles?}
  waypoints: [],      // points cliqués en dessin libre
  routing: false,
  targetKm: null,
  layer: L.layerGroup(),
};

function builderRender() {
  const stepsEl = document.getElementById("builder-steps");
  stepsEl.innerHTML = builder.steps.length
    ? builder.steps
        .map(
          (s, i) => `
      <span class="builder-step">${i + 1}. ${s.name} <em>${s.distance.toFixed(1)} km</em>
        <button data-rm-step="${i}" title="Retirer">✕</button></span>`
        )
        .join("")
    : `<span class="muted">${builder.mode === "draw"
        ? "Cliquez sur la carte pour poser le premier point."
        : "Cliquez un marqueur pour ajouter son tracé."}</span>`;
  const total = builder.steps.reduce((a, s) => a + s.distance, 0);
  document.getElementById("builder-stats").textContent =
    `${total.toFixed(1)} km · ${builder.steps.length} étape${builder.steps.length > 1 ? "s" : ""}` +
    (builder.routing ? " · ⏳ routage…" : "");
  const targetEl = document.getElementById("builder-target-info");
  if (builder.targetKm) {
    const ratio = total / builder.targetKm;
    targetEl.textContent = `${total.toFixed(1)} / ${builder.targetKm} km`;
    targetEl.className = "builder-target-info " +
      (ratio > 1.1 ? "over" : ratio > 0.85 ? "near" : "");
  } else {
    targetEl.textContent = "";
  }
  stepsEl.querySelectorAll("[data-rm-step]").forEach((b) =>
    b.addEventListener("click", () => {
      builder.steps.splice(Number(b.dataset.rmStep), 1);
      builderRedraw();
    })
  );
}

function builderRedraw() {
  builder.layer.clearLayers();
  builder.steps.forEach((s) =>
    builder.layer.addLayer(
      L.polyline(s.segments || [s.track], { color: "#ffd23e", weight: 4, opacity: 0.9 })
    )
  );
  builder.waypoints.forEach((ll) =>
    builder.layer.addLayer(
      L.circleMarker(ll, { radius: 5, color: "#0b0b0c", weight: 2, fillColor: "#ffd23e", fillOpacity: 1 })
    )
  );
  builderRender();
}

export function builderAdd(trail) {
  builder.steps.push({
    kind: "trail",
    name: trail.name,
    distance: trail.distance,
    segments: trail.segments,
    track: trackOf(trail),
  });
  builderRedraw();
}

// Dessin libre : chaque point est relié au précédent en suivant les sentiers (BRouter)
export async function builderAddPoint(latlng) {
  builder.waypoints.push(latlng);
  builderRedraw();
  if (builder.waypoints.length < 2 || builder.routing) return;
  const a = builder.waypoints[builder.waypoints.length - 2];
  const b = builder.waypoints[builder.waypoints.length - 1];
  builder.routing = true;
  builderRender();
  let track;
  let eles = null;
  let dist;
  try {
    const res = await fetch(
      `https://brouter.de/brouter?lonlats=${a.lng.toFixed(6)},${a.lat.toFixed(6)}|` +
      `${b.lng.toFixed(6)},${b.lat.toFixed(6)}&profile=hiking-mountain&alternativeidx=0&format=geojson`,
      { signal: AbortSignal.timeout(20000) }
    );
    if (!res.ok) throw new Error();
    const feat = (await res.json()).features[0];
    track = feat.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    eles = feat.geometry.coordinates.map((c) => c[2]).filter((v) => v != null);
    dist = Number(feat.properties["track-length"]) / 1000;
    if (eles.length !== track.length) eles = null;
  } catch {
    // Routage indisponible : segment en ligne droite (signalé dans le nom)
    track = [[a.lat, a.lng], [b.lat, b.lng]];
    dist = haversineKm(track[0], track[1]);
  }
  builder.routing = false;
  builder.steps.push({
    kind: "leg",
    name: eles ? `Tronçon ${builder.steps.length + 1}` : `Tronçon ${builder.steps.length + 1} (direct)`,
    distance: Math.round(dist * 100) / 100,
    track,
    eles,
  });
  builderRedraw();
}

function builderUndo() {
  if (builder.mode === "draw") {
    if (builder.waypoints.length > builder.steps.filter((s) => s.kind === "leg").length) {
      builder.waypoints.pop(); // point isolé sans tronçon
    } else if (builder.steps.length) {
      builder.steps.pop();
      builder.waypoints.pop();
    }
  } else {
    builder.steps.pop();
  }
  builderRedraw();
}

function builderExit() {
  builder.active = false;
  builder.steps = [];
  builder.waypoints = [];
  builder.routing = false;
  builder.layer.clearLayers();
  builder.layer.remove();
  document.getElementById("builder-bar").classList.add("hidden");
  document.getElementById("btn-builder").classList.remove("active");
}

export function initBuilder() {
  const builderBar = document.getElementById("builder-bar");
  const builderBtn = document.getElementById("btn-builder");

  document.getElementById("builder-undo").addEventListener("click", builderUndo);

  document.getElementById("builder-target").addEventListener("input", (e) => {
    builder.targetKm = e.target.value ? Number(e.target.value) : null;
    builderRender();
  });

  document.querySelectorAll("#builder-mode .chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      document.querySelectorAll("#builder-mode .chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      builder.mode = chip.dataset.bmode;
      document.getElementById("builder-hint").textContent =
        builder.mode === "draw"
          ? "Cliquez sur la carte : chaque point est relié au précédent en suivant les sentiers connus. Activez les couches 💧🏠 pour passer par des points d'intérêt (cliquez-les pour les ajouter)."
          : "Cliquez les marqueurs des tracés existants à enchaîner, dans l'ordre.";
      builderRender();
    })
  );

  builderBtn.addEventListener("click", () => {
    if (builder.active) { builderExit(); return; }
    closeDetail();
    builder.active = true;
    builder.layer.addTo(map);
    builderBar.classList.remove("hidden");
    builderBtn.classList.add("active");
    builderRender();
  });

  document.getElementById("builder-cancel").addEventListener("click", builderExit);

  document.getElementById("builder-save").addEventListener("click", () => {
    if (!builder.steps.length) { alert("Ajoutez au moins un tracé au circuit."); return; }
    const name = prompt(
      "Nom du circuit :",
      `Circuit ${new Date().toLocaleDateString("fr-FR")}`
    );
    if (!name) return;
    const segments = builder.steps.flatMap((s) => s.segments || [s.track]);
    const track = segments.flat();
    const distance = Math.round(builder.steps.reduce((a, s) => a + s.distance, 0) * 10) / 10;
    // Altitudes réelles si le parcours est entièrement dessiné (BRouter les fournit)
    const legEles = builder.steps.every((s) => s.kind === "leg" && s.eles)
      ? builder.steps.flatMap((s) => s.eles)
      : null;
    const eles = legEles && legEles.length === track.length ? legEles : undefined;
    const hours = distance / 3.5;
    const trail = {
      id: `custom-${Date.now()}`,
      imported: true,
      custom: true,
      eles,
      name,
      location: "Circuit personnel",
      region: "Mes circuits",
      difficulty: "personnalisé",
      type: "circuit",
      days: null,
      bivouac: false,
      distance,
      elevationGain: null,
      altMax: null,
      duration: hours < 9 ? `${Math.floor(hours)} h ${String(Math.round((hours % 1) * 60)).padStart(2, "0")}` : `${Math.round(hours / 7)} j (est.)`,
      center: track[Math.floor(track.length / 2)],
      gradient: "linear-gradient(135deg, #3a3a40, #6a6a72)",
      description:
        `Circuit composé le ${new Date().toLocaleDateString("fr-FR")} à partir de : ` +
        builder.steps.map((s) => s.name).join(" → ") + ".",
      eau: "—",
      bivouacSpot: "—",
      periode: "—",
      track,
      segments,
    };
    state.imported.unshift(trail);
    localStorage.setItem("sr-gpx", JSON.stringify(state.imported));
    addMarker(trail);
    builderExit();
    renderAll();
    selectTrail(trail.id);
  });
}
