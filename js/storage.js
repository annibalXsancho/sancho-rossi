// Sancho Rossi — couche de stockage IndexedDB (S2)
// localStorage reste pour les petites préférences (sr-*) ; IndexedDB porte les
// objets volumineux : tracés importés/sauvegardés, caches altitude et photos,
// et à terme les tuiles offline. Feuille sans dépendance interne.

const DB_NAME = "sancho-rossi";
const DB_VERSION = 4;

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      // v1 — objets utilisateur volumineux
      // Un enregistrement par tracé importé/sauvegardé.
      if (!db.objectStoreNames.contains("traces")) db.createObjectStore("traces", { keyPath: "id" });
      // Clé-valeur libre : caches "elev", "photos"…
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      // Pack offline (S5) : métadonnées légères par clé — manifeste des packs,
      // POI "poi:<id>", snapshot météo "wx:<id>". Les tuiles elles-mêmes sont des
      // réponses opaques cross-origin : illisibles par le script → stockées dans le
      // Cache Storage (buckets "sr-pack-<id>"), jamais ici.
      if (!db.objectStoreNames.contains("tiles")) db.createObjectStore("tiles");
      // v2 — catalogue OSM chargé à la demande (S3)
      // Un enregistrement par tracé balisé (dédup par id de relation OSM).
      if (!db.objectStoreNames.contains("catalog")) db.createObjectStore("catalog", { keyPath: "id" });
      // Clé = cellule de zone déjà interrogée (valeur { fetchedAt }), même vide.
      if (!db.objectStoreNames.contains("zones")) db.createObjectStore("zones");
      // v3 — refonte du chargement à la demande : le catalogue OSM historique était
      // chargé automatiquement et non filtré (fragments/tronçons). On le purge pour
      // repartir sur des randos filtrées uniquement (nommées, balisées, continues).
      if (e.oldVersion >= 2 && e.oldVersion < 3) {
        req.transaction.objectStore("catalog").clear();
        req.transaction.objectStore("zones").clear();
      }
      // v4 — repères posés sur le terrain (S-V2-ANNOT-TERRAIN). Store à part et non
      // champ du tracé : une rando OSM du catalogue n'est jamais réécrite (seuls les
      // tracés importés/planifiés vont dans `traces`), un `pois` ajouté sur elle ne
      // survivrait donc pas au rechargement. Ajout purement additif.
      if (!db.objectStoreNames.contains("marks")) db.createObjectStore("marks", { keyPath: "id" });
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
export const idbGetAllKeys = (store) => run(store, "readonly", (os) => os.getAllKeys());
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

// ---------- Catalogue OSM à la demande (S3) ----------
// Tracés balisés chargés selon la zone visible, dédupliqués par id de relation.
export const loadCatalog = () => idbGetAll("catalog");
export const putCatalogTrails = (list) =>
  Promise.all(list.map((t) => idbPut("catalog", t)));

// Cellules de zone déjà interrogées (pour ne pas refaire d'appel réseau).
export const loadZoneKeys = () => idbGetAllKeys("zones");
export const markZone = (key) => idbPut("zones", { fetchedAt: Date.now() }, key);

// ---------- Packs offline (S5) ----------
// Métadonnées légères du pack (manifeste, POI, snapshot météo) dans le store tiles.
export const putPackMeta = (key, value) => idbPut("tiles", value, key);
export const getPackMeta = (key) => idbGet("tiles", key);
export const delPackMeta = (key) => idbDelete("tiles", key);

// ---------- Repères de terrain (S-V2-ANNOT-TERRAIN) ----------
// Un enregistrement par repère posé en marchant (quelques dizaines d'objets minuscules) :
// fieldmarks.js les charge tous au boot pour pouvoir les lire de façon synchrone.
export const loadMarks = () => idbGetAll("marks");
export const putMark = (m) => idbPut("marks", m);
export const delMark = (id) => idbDelete("marks", id);

// Efface toutes les données volumineuses (bouton « réinitialiser »).
export function clearAll() {
  return Promise.all([
    idbClear("traces"),
    idbClear("meta"),
    idbClear("tiles"),
    idbClear("catalog"),
    idbClear("zones"),
    idbClear("marks"),
  ]);
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
