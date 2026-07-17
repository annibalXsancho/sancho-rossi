// Sancho Rossi — service worker : coquille hors-ligne + cache des tuiles carto
const SHELL_CACHE = "sr-shell-v32";
const TILES_CACHE = "sr-tiles-v1";
const MAX_TILES = 1500;

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
  "js/loops.js",
  "js/geosearch.js",
  "js/nav.js",
  "js/security.js",
  "js/ui.js",
  "js/offline.js",
  "js/recommend.js",
  "js/viewer3d.js",
  "manifest.json",
  "assets/icon.svg",
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
