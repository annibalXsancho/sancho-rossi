// Sancho Rossi — point d'entrée : orchestration de l'initialisation des modules.
// L'ordre reproduit celui des sections de l'ex-app.js monolithique.
import { state, BASE_TRAILS, CATALOG } from "./state.js";
import { initUi, refreshTilesCount } from "./ui.js";
import { initMap, addMarker } from "./map.js";
import { initFilters } from "./filters.js";
import { initTrails, renderAll, renderFavCount } from "./trails.js";
import { initDetail } from "./detail.js";
import { initOsmLive } from "./osm-live.js";
import { initAgent } from "./agent.js";
import { initBuilder } from "./builder.js";
import { initNav } from "./nav.js";
import { initSecurity, checkWatch } from "./security.js";
import { loadWikiPhotos, prefetchCatalogPhotos } from "./photos.js";
import { loadPersisted } from "./storage.js";

initUi();
initMap();
initFilters();
initTrails();
initDetail();
initOsmLive();
initAgent();
initBuilder();
initNav();
initSecurity();

// ---------- PWA ----------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ---------- Boot ----------
// Charge les objets volumineux depuis IndexedDB (+ migration localStorage) avant
// de poser les marqueurs et de rendre les listes.
loadPersisted().then((persisted) => {
  Object.assign(state, persisted);

  // Marqueurs des tracés (importés + catalogue bivouac + balisés) sur la carte
  [...state.imported, ...BASE_TRAILS, ...CATALOG].forEach(addMarker);

  renderAll();
  renderFavCount();
  refreshTilesCount();
  checkWatch();
  loadWikiPhotos().then(prefetchCatalogPhotos);
});
