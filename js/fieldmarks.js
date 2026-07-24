// Sancho Rossi — repères posés SUR LE TERRAIN (S-V2-ANNOT-TERRAIN)
//
// Même vocabulaire que les repères du planificateur (annotations.js : 🌙💧⚠️🛒📷📝), mais
// posés en marchant, depuis la vue de navigation, et donc :
//   - 100 % hors-ligne : IndexedDB seul, aucun appel réseau sur ce chemin (le km le long
//     du tracé se calcule localement avec `trackLocator`) ;
//   - stockés À PART du tracé. Les repères du planificateur vivent dans le champ `pois`
//     de l'itinéraire, ce qui ne marche que pour un tracé réécrit en base (importé ou
//     planifié) : une rando OSM du catalogue n'est jamais réenregistrée, un `pois` posé
//     dessus disparaîtrait au rechargement. Ici, un store dédié indexé par id de tracé.
//
// Le jeu est minuscule (quelques dizaines de points) : il est chargé en entier au boot,
// ce qui permet aux rendus (fiche, profil, nav) de le lire de façon SYNCHRONE — pas
// d'asynchrone à propager dans du code de rendu qui n'en avait pas besoin.
import { loadMarks, putMark, delMark } from "./storage.js";
import { trackLocator, ANNOT_NEAR_M } from "./annotations.js";
import { trackOf } from "./state.js";
import { toast } from "./toast.js";

const byTrail = new Map(); // trailId → [repères, ordre de pose]
const byId = new Map();

// Localisateurs « où suis-je le long de ce tracé ? » construits à la demande (le calcul
// balaie tout le tracé) et gardés par tracé : en nav on en pose plusieurs d'affilée.
const locators = new Map();

export async function loadFieldMarks() {
  byTrail.clear();
  byId.clear();
  let all = [];
  try {
    all = (await loadMarks()) || [];
  } catch (err) {
    console.warn("Repères de terrain illisibles :", err);
    return;
  }
  all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const m of all) index(m);
}

function index(m) {
  m.field = true; // drapeau lu par les rendus partagés avec les repères du planificateur
  byId.set(m.id, m);
  const list = byTrail.get(m.trailId);
  if (list) list.push(m);
  else byTrail.set(m.trailId, [m]);
}

export function fieldMarks(trailId) {
  return byTrail.get(trailId) || [];
}

// Vue unifiée d'un itinéraire : repères préparés à la maison (champ `pois`) puis repères
// posés sur le terrain. C'est cette liste que la fiche, le profil et la nav affichent.
export function trailMarks(t) {
  if (!t) return [];
  return [...(t.pois || []), ...fieldMarks(t.id)];
}

function locatorFor(t) {
  if (locators.has(t.id)) return locators.get(t.id);
  let loc = null;
  try {
    loc = trackLocator(t.mainline || trackOf(t), t.distance);
  } catch { /* tracé inexploitable : le repère sera simplement « hors itinéraire » */ }
  locators.set(t.id, loc);
  return loc;
}

// Pose un repère. Renvoie l'objet TOUT DE SUITE (l'affichage n'attend pas l'écriture) ;
// l'échec d'écriture, lui, se dit — un repère perdu en silence serait pire que pas de
// repère du tout.
export function addFieldMark(trail, { kind, lat, lon, note = "", ele = null }) {
  const p = locatorFor(trail)?.(lat, lon);
  const m = {
    id: `fm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    trailId: trail.id,
    kind,
    note,
    lat,
    lon,
    // Même règle que savePlan : au-delà de ANNOT_NEAR_M le repère est gardé (un point
    // d'eau à 400 m du sentier reste une information) mais sans km honnête.
    km: p && p.offM <= ANNOT_NEAR_M ? Math.round(p.km * 10) / 10 : null,
    ele,
    ts: Date.now(),
  };
  index(m);
  persist(m);
  return m;
}

export function updateFieldMark(id, patch) {
  const m = byId.get(id);
  if (!m) return null;
  Object.assign(m, patch);
  persist(m);
  return m;
}

export function removeFieldMark(id) {
  const m = byId.get(id);
  if (!m) return;
  byId.delete(id);
  const list = byTrail.get(m.trailId);
  if (list) {
    const i = list.indexOf(m);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) byTrail.delete(m.trailId);
  }
  delMark(id).catch((err) => console.warn("Suppression du repère non persistée :", err));
}

let warned = false;
function persist(m) {
  // `field` est un drapeau d'affichage, pas une donnée : il est reposé au chargement.
  const { field, ...rec } = m;
  putMark(rec).catch((err) => {
    console.warn("Repère non enregistré :", err);
    if (warned) return;
    warned = true; // une seule alerte : sur le terrain, un flot de toasts n'aide personne
    toast("Repère non enregistré — stockage indisponible.", { type: "error" });
  });
}
