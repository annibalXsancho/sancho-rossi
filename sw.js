// Sancho Rossi — service worker : coquille hors-ligne + cache des tuiles carto
const SHELL_CACHE = "sr-shell-v4";
const TILES_CACHE = "sr-tiles-v1";
const MAX_TILES = 1500;

const SHELL_FILES = [
  "./",
  "index.html",
  "css/style.css",
  "js/data.js",
  "js/data-osm.js",
  "js/main.js",
  "js/state.js",
  "js/storage.js",
  "js/api.js",
  "js/photos.js",
  "js/weather.js",
  "js/map.js",
  "js/filters.js",
  "js/trails.js",
  "js/detail.js",
  "js/osm-live.js",
  "js/agent.js",
  "js/builder.js",
  "js/nav.js",
  "js/security.js",
  "js/ui.js",
  "js/viewer3d.js",
  "manifest.json",
  "assets/icon.svg",
];

const TILE_HOSTS = [
  "tile.openstreetmap.fr",
  "tile.opentopomap.org",
  "server.arcgisonline.com",
  "tile.waymarkedtrails.org",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
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

  // Tuiles cartographiques : cache d'abord (fonctionnement hors-ligne)
  if (TILE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    e.respondWith(
      caches.open(TILES_CACHE).then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok || res.type === "opaque") {
          cache.put(e.request, res.clone());
          if (Math.random() < 0.02) trimTiles();
        }
        return res;
      })
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
