// Sancho Rossi — rendu des cartes d'itinéraires, favoris, sélection, GPX import/export
import { state, allTrails, getTrail, trackOf, trackDistanceKm } from "./state.js";
import { ensureElevation } from "./api.js";
import { photoStyle } from "./photos.js";
import { filteredTrails, updateFiltersBadge } from "./filters.js";
import { map, markers, addMarker, drawActiveTrack } from "./map.js";
import { renderDetail, closeDetail } from "./detail.js";
import { switchTab } from "./ui.js";
import { saveTraces } from "./storage.js";
import { toast } from "./toast.js";

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
  const total = allTrails().length;
  document.getElementById("grid-count").textContent = `(${trails.length}/${total})`;
  document.getElementById("grid-list").innerHTML = trails.length
    ? trails.map(cardHTML).join("")
    : `<div class="empty-state"><div class="empty-icon">🥾</div><p>Aucun itinéraire ne correspond aux filtres.</p></div>`;
}

// Le bloc d'idées de l'accueil (#home-suggestions) est rendu par recommend.js (S9,
// météo/saison/favoris, re-mélangeable) : renderHome ne touche qu'au sous-titre pour
// ne pas l'écraser à chaque re-rendu de liste.
function renderHome() {
  document.getElementById("home-tagline").textContent =
    `Toute l'Europe · ${allTrails().length} itinéraires chargés · sentiers balisés à la demande · sans compte, hors-ligne.`;
}

// Rafraîchit listes / grille / accueil SANS re-rendre la fiche ouverte. À utiliser pour
// les rafraîchissements en tâche de fond (chargement de zone catalog) : re-rendre la fiche
// détruirait l'onglet actif (on retombait sur l'Aperçu au moment de charger la vue 3D).
export function renderLists() {
  renderList();
  renderGrid();
  renderHome();
}

export function renderAll() {
  renderLists();
  // Re-render de la fiche réservé aux actions volontaires (ex. cœur favori) : jamais
  // déclenché par un chargement de zone en arrière-plan (voir renderLists / catalog.js).
  if (state.selectedId && getTrail(state.selectedId)) renderDetail(state.selectedId);
}

// ---------- Favoris / « Mes randos » ----------
function persistFavorites() {
  localStorage.setItem("sr-favorites", JSON.stringify([...state.favorites]));
}

// Retire la copie locale d'un tracé enregistré (OSM). Ne touche pas aux GPX/circuits
// de l'utilisateur (supprimés via le bouton dédié, pas par le cœur).
function removeSavedCopy(id) {
  state.imported = state.imported.filter((t) => t.id !== id);
  saveTraces(state.imported);
  const cat = state.catalog.get(id);
  if (cat) addMarker(cat); // le tracé existe encore au catalogue : rebranche son marqueur
  else { markers.get(id)?.remove(); markers.delete(id); }
}

// Enregistrer = copier localement géométrie complète + méta + profil altimétrique,
// pour un affichage intégral hors-ligne même si le cache catalogue est vidé.
// Renvoie le tracé local exploitable hors-ligne (la copie pour un OSM, le tracé lui-même
// pour une graine/GPX/circuit déjà local). Réutilisé par le pack offline (S5).
export async function ensureSavedCopy(t) {
  // Déjà une copie locale (ré-enregistrement, ou tracé importé) : rien à copier.
  const existing = state.imported.find((x) => x.id === t.id);
  if (existing) { await ensureElevation(existing).catch(() => null); return existing; }
  // Profil relevé une fois (renseigne state.elev, persisté dans le store meta) : suffit
  // à afficher hors-ligne le profil des tracés déjà locaux (graine, GPX, circuits).
  const eles = await ensureElevation(t).catch(() => null);
  // Seuls les tracés OSM (catalogue volatile, vidable) doivent être copiés localement.
  if (!t.osm) return t;
  const copy = structuredClone(t);
  copy.saved = true;
  if (eles && eles.length > 1) {
    copy.eles = eles;
    const e = state.elev[t.id];
    if (e) { copy.elevationGain = e.gain; copy.altMax = e.max; }
  }
  state.imported = state.imported.filter((x) => x.id !== t.id);
  state.imported.unshift(copy);
  await saveTraces(state.imported);
  // Enregistrer = « Mes randos » : le cœur suit (ex. téléchargement d'un pack sur un OSM
  // non encore favori). Idempotent si l'appel vient déjà de toggleFavorite.
  if (!state.favorites.has(copy.id)) {
    state.favorites.add(copy.id);
    persistFavorites();
    renderFavCount();
  }
  addMarker(copy); // tooltip avec le D+ relevé, masque le marqueur catalogue (même id)
  renderAll();
  return copy;
}

// Met à jour le cœur d'un id sur TOUTES les cartes affichées, y compris celles que les
// rendus de liste ne réécrivent pas (idées de l'accueil #home-suggestions, sortie agent).
function syncFavButtons(id) {
  const faved = state.favorites.has(id);
  document.querySelectorAll(`[data-fav="${CSS.escape(id)}"]`).forEach((btn) => {
    btn.classList.toggle("faved", faved);
    btn.textContent = faved ? "♥" : "♡";
    btn.title = faved ? "Retirer" : "Enregistrer";
  });
}

export function toggleFavorite(id) {
  if (state.favorites.has(id)) {
    state.favorites.delete(id);
    persistFavorites();
    const local = state.imported.find((t) => t.id === id);
    if (local?.saved) removeSavedCopy(id);
    renderAll();
    syncFavButtons(id);
    renderFavCount();
    return;
  }
  state.favorites.add(id);
  persistFavorites();
  renderAll(); // retour immédiat : le cœur s'allume
  syncFavButtons(id);
  renderFavCount();
  const t = getTrail(id);
  if (t) ensureSavedCopy(t).catch(() => {}); // copie + profil en tâche de fond
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
  saveTraces(state.imported);
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
    saveTraces(state.imported);
    renderAll();
    if (lastId) {
      switchTab("carte");
      selectTrail(lastId);
    }
    if (errors.length) toast("Import impossible — " + errors.join(" · "), { type: "error" });
  });

  // Liste repliable. Le bouton « Liste » de la barre reste le point de ré-ouverture
  // (la flèche de repli disparaît avec le panneau qui glisse hors écran).
  const resultsPanel = document.getElementById("results-panel");
  const listBtn = document.getElementById("btn-list");
  const syncListBtn = () =>
    listBtn.classList.toggle("active", !resultsPanel.classList.contains("collapsed"));
  const toggleList = () => {
    resultsPanel.classList.toggle("collapsed");
    syncListBtn();
  };
  listBtn.addEventListener("click", toggleList);
  document.getElementById("panel-collapse").addEventListener("click", toggleList);
  if (window.innerWidth < 700) resultsPanel.classList.add("collapsed"); // mobile : repliée
  syncListBtn();
}
