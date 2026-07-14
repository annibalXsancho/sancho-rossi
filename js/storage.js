// Sancho Rossi — couche de stockage IndexedDB (S2)
// localStorage reste pour les petites préférences (sr-*) ; IndexedDB porte les
// objets volumineux : tracés importés/sauvegardés, caches altitude et photos,
// et à terme les tuiles offline. Feuille sans dépendance interne.

const DB_NAME = "sancho-rossi";
const DB_VERSION = 1;

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Un enregistrement par tracé (dédup par id de relation OSM en S3).
      if (!db.objectStoreNames.contains("traces")) db.createObjectStore("traces", { keyPath: "id" });
      // Clé-valeur libre : caches "elev", "photos"…
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      // Réservé au pack offline (S5) : tuiles carto par clé.
      if (!db.objectStoreNames.contains("tiles")) db.createObjectStore("tiles");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Transaction générique : `fn(store)` lance la requête, la valeur lue est
// résolue à la fin de la transaction (le résultat est prêt à `oncomplete`).
function run(storeName, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const req = fn(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

// ---------- Primitives par store ----------
export const idbGet = (store, key) => run(store, "readonly", (os) => os.get(key));
export const idbGetAll = (store) => run(store, "readonly", (os) => os.getAll());
export const idbPut = (store, value, key) => run(store, "readwrite", (os) => os.put(value, key));
export const idbDelete = (store, key) => run(store, "readwrite", (os) => os.delete(key));
export const idbClear = (store) => run(store, "readwrite", (os) => os.clear());

// ---------- Aides métier ----------
// Clé-valeur du store meta (caches elev / photos).
export const putMeta = (key, value) => idbPut("meta", value, key);

// Réécriture complète des tracés importés (liste courte : quelques éléments).
export function saveTraces(list) {
  return idbClear("traces").then(() =>
    Promise.all(list.map((t) => idbPut("traces", t)))
  );
}

// Efface toutes les données volumineuses (bouton « réinitialiser »).
export function clearAll() {
  return Promise.all([idbClear("traces"), idbClear("meta"), idbClear("tiles")]);
}

// Migration unique depuis localStorage : recopie les gros objets dans IndexedDB
// puis purge les clés d'origine. Idempotent (ne fait rien si déjà migré).
async function migrateFromLocalStorage() {
  const gpx = localStorage.getItem("sr-gpx");
  if (gpx !== null) {
    try { await saveTraces(JSON.parse(gpx) || []); } catch {}
    localStorage.removeItem("sr-gpx");
  }
  const elev = localStorage.getItem("sr-elev");
  if (elev !== null) {
    try { await putMeta("elev", JSON.parse(elev) || {}); } catch {}
    localStorage.removeItem("sr-elev");
  }
  const photos = localStorage.getItem("sr-photos");
  if (photos !== null) {
    try { await putMeta("photos", JSON.parse(photos) || {}); } catch {}
    localStorage.removeItem("sr-photos");
  }
}

// Chargement au boot : migre si besoin puis renvoie les objets volumineux.
// En cas d'échec IndexedDB (mode privé…), on retombe sur localStorage pour ne
// pas perdre les données de la session, sans les supprimer.
export async function loadPersisted() {
  try {
    await migrateFromLocalStorage();
    const [imported, elev, photos] = await Promise.all([
      idbGetAll("traces"),
      idbGet("meta", "elev"),
      idbGet("meta", "photos"),
    ]);
    return {
      imported: imported || [],
      elev: elev || {},
      photos: photos || {},
    };
  } catch (err) {
    console.warn("IndexedDB indisponible, lecture localStorage :", err);
    return {
      imported: JSON.parse(localStorage.getItem("sr-gpx") || "[]"),
      elev: JSON.parse(localStorage.getItem("sr-elev") || "{}"),
      photos: JSON.parse(localStorage.getItem("sr-photos") || "{}"),
    };
  }
}
