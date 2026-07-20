// Sancho Rossi — service worker : coquille hors-ligne + cache des tuiles carto
const SHELL_CACHE = "sr-shell-v42";
const TILES_CACHE = "sr-tiles-v1";
const MAX_TILES = 1500;

// Bibliothèques CDN — épinglées par version, donc immuables : cache-first sans revalidation.
// Sans ça l'appli ne démarrait hors-ligne que si le cache HTTP du navigateur avait gardé
// Leaflet ; avec MapLibre (1 Mo) le pari devenait intenable. Le cache accepte les réponses
// opaques (cross-origin sans CORS) : elles se rejouent telles quelles.
const CDN_ASSETS = [
  "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js",
  "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
];
const CDN_HOSTS = ["unpkg.com", "cdn.jsdelivr.net"];

const SHELL_FILES = [
  "./",
  "index.html",
  "css/style.css",
  "js/data.js",
  "js/main.js",
  "js/state.js",
  "js/storage.js",
  "js/net.js",
  "js/toast.js",
  "js/api.js",
  "js/photos.js",
  "js/weather.js",
  "js/hikeweather.js",
  "js/map.js",
  "js/filters.js",
  "js/trails.js",
  "js/detail.js",
  "js/catalog.js",
  "js/agent.js",
  "js/brouter.js",
  "js/metrics.js",
  "js/surface.js",
  "js/profile.js",
  "js/planner.js",
  "js/annotations.js",
  "js/loops.js",
  "js/geosearch.js",
  "js/nav.js",
  "js/navview.js",
  "js/security.js",
  "js/ui.js",
  "js/offline.js",
  "js/packdialog.js",
  "js/recommend.js",
  "js/viewer3d.js",
  "manifest.json",
  "assets/icon.svg",
  "assets/icon-512.png",
  "assets/icon-maskable.png",
];

const TILE_HOSTS = [
  "tile.openstreetmap.fr",
  "tile.opentopomap.org",
  "server.arcgisonline.com",
  "tile.waymarkedtrails.org",
  "basemaps.cartocdn.com",
];

// Clé de cache normalisée des tuiles de pack — DOIT rester identique à celle de
// js/offline.js : le sous-domaine rotatif {s} (a/b/c/d) doit taper la même entrée.
function normTileKey(urlStr) {
  const u = new URL(urlStr);
  u.hostname = u.hostname.replace(/^[a-d]\./, "");
  return `${u.protocol}//${u.hostname}${u.pathname}`;
}

// Cherche une tuile dans les buckets de packs offline (sr-pack-*), servie hors-ligne
// et jamais évincée (contrairement au cache de navigation opportuniste).
async function matchPackTile(urlStr) {
  const key = normTileKey(urlStr);
  const names = (await caches.keys()).filter((n) => n.startsWith("sr-pack-"));
  for (const n of names) {
    const hit = await (await caches.open(n)).match(key);
    if (hit) return hit;
  }
  return null;
}

self.addEventListener("install", (e) => {
  // Pas de skipWaiting() ici : une nouvelle coquille ATTEND que la page propose la mise à
  // jour (toast « Recharger »). L'activation immédiate se fait sur message SKIP_WAITING.
  e.waitUntil(
    caches.open(SHELL_CACHE).then(async (c) => {
      await c.addAll(SHELL_FILES);
      // Les CDN sont pré-chargés en best-effort : un unpkg lent ou injoignable ne doit pas
      // faire échouer l'installation de toute la coquille (addAll est tout-ou-rien).
      await Promise.all(
        CDN_ASSETS.map((u) => c.add(new Request(u, { mode: "no-cors" })).catch(() => {}))
      );
    })
  );
});

// La page (main.js) demande l'activation de la coquille en attente au clic « Recharger ».
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((names) =>
        Promise.all(
          names
            .filter((n) => n.startsWith("sr-shell-") && n !== SHELL_CACHE)
            .map((n) => caches.delete(n))
        )
      )
      .then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const cache = await caches.open(TILES_CACHE);
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) {
    // Supprime les plus anciennes entrées (ordre d'insertion)
    await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => cache.delete(k)));
  }
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Tuiles cartographiques : pack offline d'abord, puis cache de navigation, puis réseau.
  if (TILE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    e.respondWith(
      (async () => {
        const packed = await matchPackTile(e.request.url);
        if (packed) return packed;
        const cache = await caches.open(TILES_CACHE);
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok || res.type === "opaque") {
          cache.put(e.request, res.clone());
          if (Math.random() < 0.02) trimTiles();
        }
        return res;
      })()
    );
    return;
  }

  // Bibliothèques CDN épinglées par version : cache d'abord (l'URL porte la version, le
  // contenu ne change jamais), réseau au premier passage puis mise en cache pour l'offline.
  if (CDN_HOSTS.some((h) => url.hostname.endsWith(h))) {
    e.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok || res.type === "opaque") cache.put(e.request, res.clone());
        return res;
      })()
    );
    return;
  }

  // Fichiers de l'application : réseau d'abord, cache en secours
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
  }
});
