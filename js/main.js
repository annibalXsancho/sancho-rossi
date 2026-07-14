// Sancho Rossi — point d'entrée : orchestration de l'initialisation des modules.
// L'ordre reproduit celui des sections de l'ex-app.js monolithique.
import { state, BASE_TRAILS } from "./state.js";
import { initUi, refreshTilesCount } from "./ui.js";
import { initMap, addMarker } from "./map.js";
import { initFilters } from "./filters.js";
import { initTrails, renderAll, renderFavCount } from "./trails.js";
import { initDetail } from "./detail.js";
import { initCatalog, hydrateCatalog } from "./catalog.js";
import { initAgent } from "./agent.js";
import { initBuilder } from "./builder.js";
import { initNav } from "./nav.js";
import { initSecurity, checkWatch } from "./security.js";
import { loadWikiPhotos } from "./photos.js";
import { loadPersisted } from "./storage.js";
import { initOffline } from "./offline.js";

initUi();
initMap();
initFilters();
initTrails();
initDetail();
initCatalog();
initAgent();
initBuilder();
initNav();
initSecurity();

// ---------- PWA ----------
if ("serviceWorker" in navigator) {
  // Mise à jour transparente : quand un nouveau service worker prend le contrôle
  // (déploiement), on recharge une fois pour ne jamais rester coincé sur une version
  // en cache. Le garde `controller` évite un rechargement au tout premier lancement.
  if (navigator.serviceWorker.controller) {
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }
  navigator.serviceWorker
    .register("sw.js")
    .then((reg) => reg.update())
    .catch(() => {});
}

// ---------- Boot ----------
// Charge les objets volumineux depuis IndexedDB (+ migration localStorage) avant
// de poser les marqueurs et de rendre les listes. Le catalogue balisé est ré-hydraté
// depuis IndexedDB (zones déjà visitées) ; le reste se charge à la demande à la carte.
loadPersisted().then(async (persisted) => {
  Object.assign(state, persisted);

  // Manifeste des packs offline chargé avant tout rendu (le bouton « Terrain » de la
  // fiche et la liste des Réglages lisent hasPack/listPacks de façon synchrone).
  await initOffline();

  // Le catalogue OSM d'abord, puis la graine curatée et les tracés locaux : une copie
  // enregistrée (dans imported) reprend ainsi le marqueur de son homologue catalogue.
  await hydrateCatalog();
  [...state.imported, ...BASE_TRAILS].forEach(addMarker);

  renderAll();
  renderFavCount();
  refreshTilesCount();
  checkWatch();
  loadWikiPhotos();
});
