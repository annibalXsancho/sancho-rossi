// Sancho Rossi — point d'entrée : orchestration de l'initialisation des modules.
// L'ordre reproduit celui des sections de l'ex-app.js monolithique.
import { state, BASE_TRAILS, getTrail } from "./state.js";
import { initUi, refreshTilesCount, switchTab } from "./ui.js";
import { initMap, addMarker } from "./map.js";
import { initFilters } from "./filters.js";
import { initRecommend, renderRecommendations } from "./recommend.js";
import { initGeoSearch } from "./geosearch.js";
import { initTrails, renderAll, renderFavCount } from "./trails.js";
import { initDetail } from "./detail.js";
import { initCatalog, hydrateCatalog } from "./catalog.js";
import { initPlanner } from "./planner.js";
import { initLoops } from "./loops.js";
import { initNav, startNavigation } from "./nav.js";
import { initSecurity, checkWatch } from "./security.js";
import { loadWikiPhotos } from "./photos.js";
import { loadPersisted } from "./storage.js";
import { initOffline } from "./offline.js";
import { initExplorer } from "./explorer.js";
import { initToast, toast } from "./toast.js";

// Écran de chargement : retiré une fois l'app prête, avec une durée minimale d'affichage
// pour éviter un flash (boot rapide) — jamais de saut de layout, fondu doux.
const bootT0 = performance.now();
const SPLASH_MIN_MS = 500;
function hideSplash() {
  const el = document.getElementById("splash");
  if (!el) return;
  const wait = Math.max(0, SPLASH_MIN_MS - (performance.now() - bootT0));
  setTimeout(() => {
    el.classList.add("splash--gone");
    setTimeout(() => el.remove(), 450);
  }, wait);
}

initToast();
initUi();
initMap();
initFilters();
initGeoSearch();
initTrails();
initDetail();
initCatalog();
initPlanner();
initLoops();
initNav();
initSecurity();
initRecommend();
initExplorer();

// ---------- Version affichée (Réglages) ----------
const versionEl = document.getElementById("setting-version");
if (versionEl) versionEl.textContent = `Sancho Rossinante v${window.SR_VERSION || ""}`;

// ---------- PWA ----------
if ("serviceWorker" in navigator) {
  // Mise à jour NON silencieuse : quand une nouvelle coquille est prête (SW installé en
  // attente), on PROPOSE un toast « Recharger » au lieu de recharger d'autorité — un
  // rechargement forcé en pleine navigation serait brutal. Le tap active le SW en attente
  // (message SKIP_WAITING) ; le `controllerchange` qui suit recharge une seule fois.
  // Le garde `intentionalUpdate` évite le rechargement au tout premier install (clients.claim).
  let reloading = false;
  let intentionalUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || !intentionalUpdate) return;
    reloading = true;
    location.reload();
  });

  let updateOffered = false;
  const offerUpdate = (worker) => {
    if (updateOffered || !worker) return;
    updateOffered = true;
    toast("Mise à jour disponible.", {
      type: "info",
      duration: 0,
      action: {
        label: "Recharger",
        onClick: () => {
          intentionalUpdate = true;
          worker.postMessage({ type: "SKIP_WAITING" });
        },
      },
    });
  };

  navigator.serviceWorker
    .register("sw.js")
    .then((reg) => {
      // Une coquille déjà en attente (mise à jour arrivée pendant une session précédente).
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      // Une mise à jour qui s'installe pendant la session courante.
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        nw?.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) offerUpdate(nw);
        });
      });
      reg.update();
    })
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
  renderRecommendations(); // idées datées de l'accueil (saison/météo/favoris), après boot data
  refreshTilesCount();
  checkWatch();

  // Reprise après rechargement : une session de navigation interrompue (sr-nav)
  // redémarre d'elle-même — le tracé, le HUD et le GPS reviennent sans un geste.
  // Sinon, on restaure simplement le dernier onglet visité (sr-view).
  const NAV_MAX_AGE = 48 * 3600 * 1000; // au-delà du bivouac 2 jours : session caduque
  let savedNav = null;
  try { savedNav = JSON.parse(localStorage.getItem("sr-nav") || "null"); } catch {}
  if (savedNav?.id && Date.now() - savedNav.startedAt < NAV_MAX_AGE && getTrail(savedNav.id)) {
    startNavigation(savedNav.id, { resume: savedNav });
    toast("Navigation reprise — votre session a été restaurée.", { type: "success" });
  } else {
    if (savedNav) localStorage.removeItem("sr-nav");
    // Écran par défaut : la carte Explorer plein écran. switchTab redimensionne la carte
    // et propose la géoloc au bon moment (map.js promptGeolocation, une seule fois).
    switchTab("carte");
  }

  loadWikiPhotos();
  hideSplash();
});
