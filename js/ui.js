// Sancho Rossi — coquille UI : thème, navigation par onglets, réglages
import { state } from "./state.js";
import { map, layersConfig, applyLayer, addMarker } from "./map.js";
import { renderAll, renderFavCount } from "./trails.js";
import { isDetailOpen, closeDetail } from "./detail.js";
import { renderSafety, saveContacts } from "./security.js";
import { loadWikiPhotos } from "./photos.js";
import { saveTraces, putMeta, clearAll } from "./storage.js";

// ---------- Thème ----------
function applyTheme(theme) {
  const themeBtn = document.getElementById("btn-theme");
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("sr-theme", theme);
  themeBtn.textContent = theme === "dark" ? "☀️" : "🌙";
  document.getElementById("setting-theme").value = theme;
}

// ---------- Navigation par onglets ----------
export function switchTab(name) {
  // Un clic d'onglet doit toujours répondre : on referme la fiche qui recouvre tout
  if (isDetailOpen()) closeDetail();
  state.view = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.getElementById(`view-${name}`).classList.remove("hidden");
  document.querySelectorAll(".tab-nav-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name)
  );
  if (name === "carte") setTimeout(() => map.invalidateSize(), 60);
  if (name === "securite") renderSafety();
}

// ---------- Réglages : jauge de tuiles en cache ----------
export async function refreshTilesCount() {
  const el = document.getElementById("tiles-count");
  try {
    const cache = await caches.open("sr-tiles-v1");
    const keys = await cache.keys();
    el.textContent = `(${keys.length} tuiles)`;
  } catch {
    el.textContent = "";
  }
}

export function initUi() {
  const themeBtn = document.getElementById("btn-theme");
  const themeSelect = document.getElementById("setting-theme");
  applyTheme(document.documentElement.dataset.theme || "light");
  themeBtn.addEventListener("click", () =>
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")
  );
  themeSelect.addEventListener("change", () => applyTheme(themeSelect.value));

  // Échap : referme fiche puis panneau de calques
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (isDetailOpen()) closeDetail();
    else document.getElementById("layers-panel").classList.add("hidden");
  });

  // Bouton retour du navigateur : referme la fiche au lieu de quitter l'app
  window.addEventListener("popstate", () => {
    if (isDetailOpen()) closeDetail(true);
  });

  document.querySelectorAll(".tab-nav-btn").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.view))
  );
  document.getElementById("go-home").addEventListener("click", () => switchTab("accueil"));

  // ---------- Réglages ----------
  const baseSelect = document.getElementById("setting-baselayer");
  baseSelect.value = ["plan", "topo", "satellite", "sombre"].find((n) => layersConfig[n].on) || "plan";
  baseSelect.addEventListener("change", () => {
    ["plan", "topo", "satellite", "sombre"].forEach((n) => {
      layersConfig[n].on = n === baseSelect.value;
      applyLayer(n);
    });
  });

  document.getElementById("btn-clear-tiles").addEventListener("click", async () => {
    await caches.delete("sr-tiles-v1");
    refreshTilesCount();
  });

  document.getElementById("btn-clear-photos").addEventListener("click", () => {
    state.photos = {};
    putMeta("photos", {});
    loadWikiPhotos();
  });

  document.getElementById("btn-export-data").addEventListener("click", () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      favorites: [...state.favorites],
      notes: state.notes,
      gpx: state.imported,
      contacts: state.contacts,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sancho-rossi-backup.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const dataInput = document.getElementById("data-file-input");
  document.getElementById("btn-import-data").addEventListener("click", () => dataInput.click());
  dataInput.addEventListener("change", async () => {
    try {
      const payload = JSON.parse(await dataInput.files[0].text());
      (payload.favorites || []).forEach((id) => state.favorites.add(id));
      Object.assign(state.notes, payload.notes || {});
      const known = new Set(state.imported.map((t) => t.id));
      (payload.gpx || []).forEach((t) => {
        if (!known.has(t.id)) { state.imported.push(t); addMarker(t); }
      });
      const knownContacts = new Set(state.contacts.map((c) => c.id));
      (payload.contacts || []).forEach((c) => { if (!knownContacts.has(c.id)) state.contacts.push(c); });
      localStorage.setItem("sr-favorites", JSON.stringify([...state.favorites]));
      localStorage.setItem("sr-notes", JSON.stringify(state.notes));
      saveTraces(state.imported);
      saveContacts();
      renderAll();
      renderFavCount();
      alert("Données restaurées.");
    } catch (err) {
      alert(`Fichier invalide : ${err.message}`);
    }
    dataInput.value = "";
  });

  document.getElementById("btn-reset-data").addEventListener("click", async () => {
    if (!confirm("Effacer favoris, notes, GPX importés, contacts et caches ? Cette action est définitive.")) return;
    ["sr-favorites", "sr-notes", "sr-gpx", "sr-photos", "sr-baselayer", "sr-elev", "sr-contacts", "sr-lastpos", "sr-theme"]
      .forEach((k) => localStorage.removeItem(k));
    await clearAll();
    caches?.delete("sr-tiles-v1");
    location.reload();
  });
}
