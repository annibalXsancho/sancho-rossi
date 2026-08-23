// Sancho Rossi — lieux épinglés sur la carte (S-V3-LIEUX)
//
// Le geste « appui long / clic droit » posait depuis S7 une bulle de coordonnées : on
// pouvait LIRE un point, pas le GARDER. Ici il épingle vraiment — une punaise tombe sur la
// carte, le lieu se nomme tout seul (géocodage inverse) et un bouton l'enregistre.
//
// Ce que ces lieux ne sont pas :
//   - des repères de terrain (`fieldmarks.js`) : ceux-là sont indexés PAR TRACÉ et posés en
//     marchant ; un lieu épinglé existe pour lui-même (un parking, un départ de sentier, un
//     bivouac repéré depuis le Mac) et survit à la suppression de toutes les randos ;
//   - des POI Overpass (couches « Lieux » de la carte) : donnée publique, pas la mienne.
// D'où un store IndexedDB dédié (`places`, v6 du schéma), même patron que `marks`.
//
// Le jeu est minuscule (quelques dizaines de points) : il est chargé en entier au boot, ce
// qui permet aux rendus de le lire de façon SYNCHRONE.
import { map, domMarker, flyToL, mapZoom, setPinHandler } from "./map.js";
import { state } from "./state.js";
import { loadPlaces, putPlace, delPlace } from "./storage.js";
import { fetchRetry } from "./net.js";
import { toast } from "./toast.js";
import { switchTab } from "./ui.js";
import { touchPlaces } from "./sync.js";

const byId = new Map();       // id → lieu
const markers = new Map();    // id → marqueur MapLibre des lieux ENREGISTRÉS
let pinMarker = null;         // punaise du point en cours d'épinglage (pas encore gardé)
let pinSeed = null;           // nom déjà connu de cette punaise (venue d'une recherche)
let sheet = null;             // { place, lat, lon, saved } — état de la feuille ouverte
let nameTimer = null;
let lookupToken = 0;          // annule l'affichage d'un géocodage qui répond trop tard

const el = (id) => document.getElementById(id);
const FLY_ZOOM = 15;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- Chargement ----------
export async function loadSavedPlaces() {
  byId.clear();
  let all = [];
  try {
    all = (await loadPlaces()) || [];
  } catch (err) {
    console.warn("Lieux épinglés illisibles :", err);
    return;
  }
  all.sort((a, b) => (b.ts || 0) - (a.ts || 0)); // le dernier épinglé en tête de liste
  for (const p of all) byId.set(p.id, p);
  refreshMarkers();
}

export const allPlaces = () => [...byId.values()];

// ---------- Coordonnées ----------
function toDMS(deg, [pos, neg]) {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = ((a - d - m / 60) * 3600).toFixed(1);
  return `${d}°${String(m).padStart(2, "0")}′${s.padStart(4, "0")}″${deg >= 0 ? pos : neg}`;
}

const decimals = (lat, lon) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
const dms = (lat, lon) => `${toDMS(lat, ["N", "S"])} · ${toDMS(lon, ["E", "O"])}`;

// ---------- Nom et altitude d'un point (best-effort, jamais bloquant) ----------
// Géocodage INVERSE Nominatim — même fournisseur que la recherche de lieu (geosearch.js),
// donc même politique : une requête par geste utilisateur, largement sous la limite d'1/s.
// `zoom=14` cadre la réponse au village plutôt qu'au numéro de rue : c'est le nom qu'on
// veut voir tomber dans le champ (« Le Lavancher », pas « 42 route des Tines »).
async function reverseName(lat, lon) {
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=14` +
    `&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`;
  const res = await fetchRetry(url, { timeout: 8000, retries: 0 });
  const r = await res.json();
  const a = r.address || {};
  const name =
    r.name || a.hamlet || a.village || a.town || a.city ||
    String(r.display_name || "").split(",")[0].trim();
  // Commune puis département. `municipality` est piégeux en France — il porte
  // l'ARRONDISSEMENT (« Bonneville » pour Chamonix) : il ne vient qu'en dernier recours.
  // Idem `state` (région) après `county` (département), plus parlant en montagne.
  const context = [
    a.city || a.town || a.village || a.municipality,
    a.county || a.state,
    a.country,
  ]
    .filter((v, i, arr) => v && arr.indexOf(v) === i && v !== name)
    .slice(0, 2)
    .join(", ");
  return { name: name || null, context };
}

// Altitude : un seul point, donc l'API Elevation d'Open-Meteo (même source que les profils
// d'itinéraire, api.js) — une requête minuscule, pas de tuile de MNT à décoder pour ça.
async function pointElevation(lat, lon) {
  const res = await fetchRetry(
    `https://api.open-meteo.com/v1/elevation?latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}`,
    { timeout: 8000, retries: 0 }
  );
  const v = (await res.json()).elevation?.[0];
  return Number.isFinite(v) ? Math.round(v) : null;
}

// ---------- Punaises sur la carte ----------
const PIN_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M12 22.5S4.6 14.9 4.6 9.9a7.4 7.4 0 0 1 14.8 0c0 5-7.4 12.6-7.4 12.6Z"/>' +
  '<circle cx="12" cy="9.9" r="2.6"/></svg>';

function pinEl(className, { ping = false, label = "" } = {}) {
  const node = document.createElement("div");
  node.className = className;
  // L'anneau du ping est un frère du SVG, ancré sur la POINTE de la punaise : c'est le
  // point désigné, pas le centre du dessin, qui doit irradier.
  node.innerHTML =
    (ping ? '<span class="place-ping" aria-hidden="true"></span>' : "") +
    PIN_SVG +
    (label ? `<span class="place-pin-label">${escapeHtml(label)}</span>` : "");
  return node;
}

function refreshMarkers() {
  for (const [id, mk] of markers) {
    if (!byId.has(id)) { mk.remove(); markers.delete(id); }
  }
  for (const p of byId.values()) {
    const existing = markers.get(p.id);
    if (existing) { existing.setLngLat([p.lon, p.lat]); continue; }
    const node = pinEl("place-pin saved");
    node.title = p.name || "Lieu enregistré";
    node.addEventListener("click", (e) => {
      e.stopPropagation();
      openPlace(p);
    });
    markers.set(p.id, domMarker(p.lat, p.lon, { element: node, anchor: "bottom" }).addTo(map));
  }
}

// Punaise du point en cours : posée par l'appui long (sans fioriture, la feuille s'ouvre
// dans la foulée) ou par une recherche de lieu (avec ping et étiquette — là, rien ne
// s'ouvre, il faut que l'œil trouve le résultat tout seul sur la carte).
//   seed  : nom/contexte DÉJÀ connus (résultat de recherche) → la feuille les reprend
//           sans repasser par le géocodage inverse.
function showPin(lat, lon, { ping = false, label = "", seed = null } = {}) {
  clearPin();
  const node = pinEl("place-pin fresh", { ping, label });
  if (seed) {
    // Une punaise de recherche est un point PROPOSÉ : elle attend un tap pour ouvrir la
    // feuille et devenir un lieu qu'on garde.
    node.classList.add("clickable");
    node.title = `${seed.name} — enregistrer ce lieu`;
    node.addEventListener("click", (e) => {
      e.stopPropagation();
      openSheet({ lat, lon, seed });
    });
  }
  pinSeed = seed;
  pinMarker = domMarker(lat, lon, { element: node, anchor: "bottom" }).addTo(map);
}

function clearPin() {
  pinMarker?.remove();
  pinMarker = null;
  pinSeed = null;
}

// Résultat de recherche mis en valeur sur la carte (geosearch.js). Le nom vient de
// Nominatim, qui vient déjà de répondre : inutile de le lui redemander à l'ouverture de
// la feuille — seule l'altitude reste à chercher.
export function pingSearchResult({ lat, lon, name, sub }) {
  showPin(lat, lon, { ping: true, label: name, seed: { name, context: sub || "" } });
}

// ---------- La feuille ----------
// Deux états dans le même cadre, comme la feuille « repère » de la navigation : un point
// tout juste épinglé (à nommer, à garder) et un lieu déjà enregistré (à retoucher, à
// supprimer). Le bouton primaire porte la différence — « Enregistrer » puis « OK ».
function openSheet({ lat, lon, place = null, seed = null }) {
  commitName(); // un nom en cours de saisie sur un AUTRE lieu n'est jamais perdu
  sheet = { place, lat, lon, saved: !!place, context: seed?.context || "" };
  const token = ++lookupToken;

  el("place-eyebrow").textContent = place ? "Mon lieu" : seed ? "Lieu trouvé" : "Point épinglé";
  el("place-coords").innerHTML =
    `<span class="place-dec">${decimals(lat, lon)}</span><span class="place-dms">${dms(lat, lon)}</span>`;
  el("place-del").classList.toggle("hidden", !place);
  el("place-save").textContent = place ? "OK" : "Enregistrer";

  const nameInput = el("place-name");
  nameInput.value = place?.name || seed?.name || "";
  nameInput.placeholder = place || seed ? "Nom du lieu" : "Recherche du lieu…";
  setMeta(place ? metaOf(place) : seed ? metaOf({ context: seed.context }) : "");

  el("place-sheet").classList.remove("hidden");

  if (place) return;
  // L'altitude manque toujours ; le nom, lui, est déjà là quand le point vient d'une
  // recherche — pas de géocodage inverse dans ce cas.
  pointElevation(lat, lon)
    .then((ele) => {
      if (token !== lookupToken || !sheet) return;
      sheet.ele = ele;
      setMeta(metaOf({ ele, context: sheet.context }));
    })
    .catch(() => {});
  if (seed) return;
  // Point neuf : le nom arrive en tâche de fond et s'affiche dès qu'il est là — un réseau
  // lent ne doit pas retarder le geste « Enregistrer ».
  reverseName(lat, lon)
    .then(({ name, context }) => {
      if (token !== lookupToken || !sheet) return;
      sheet.context = context;
      if (!nameInput.value) nameInput.value = name || "";
      nameInput.placeholder = "Nom du lieu";
      setMeta(metaOf({ ele: sheet.ele, context }));
    })
    .catch(() => {
      if (token !== lookupToken) return;
      nameInput.placeholder = "Nom du lieu";
    });
}

const metaOf = (p) => [p.ele != null ? `${p.ele} m` : null, p.context].filter(Boolean).join(" · ");

function setMeta(text) {
  const node = el("place-meta");
  node.textContent = text;
  node.classList.toggle("hidden", !text);
}

function closeSheet() {
  commitName();
  // La punaise « fraîche » ne survit pas à la fermeture : un point non enregistré qui
  // resterait planté sur la carte se confondrait avec un lieu gardé. Exception : celle
  // d'une RECHERCHE, qui n'est pas un brouillon mais le résultat mis en valeur — la fermer
  // par curiosité ne doit pas effacer ce qu'on vient de chercher. Elle part au prochain
  // épinglage ou à la prochaine recherche.
  if (!sheet?.saved && !pinSeed) clearPin();
  sheet = null;
  el("place-sheet")?.classList.add("hidden");
}

// Le geste qui compte : un tap sur « Enregistrer » ET C'EST GARDÉ.
function savePlace() {
  if (!sheet) return;
  if (sheet.saved) { closeSheet(); return; } // second état : le bouton n'est plus qu'un « OK »
  const name = el("place-name").value.trim();
  const p = {
    id: `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: name || decimals(sheet.lat, sheet.lon),
    lat: sheet.lat,
    lon: sheet.lon,
    ele: sheet.ele ?? null,
    context: sheet.context || "",
    note: "",
    ts: Date.now(),
  };
  byId.set(p.id, p);
  persist(p);
  clearPin(); // remplacée par la punaise pleine du lieu enregistré
  refreshMarkers();
  renderPlacesList();

  sheet.place = p;
  sheet.saved = true;
  el("place-eyebrow").textContent = "Lieu enregistré";
  el("place-save").textContent = "OK";
  el("place-del").classList.remove("hidden");
  el("place-name").value = p.name;
  navigator.vibrate?.(30);
}

// Nom modifiable au fil de la frappe (débouncé) ET à la fermeture — même règle que la note
// d'un repère de terrain : on peut ranger le téléphone à tout moment.
function onNameInput() {
  clearTimeout(nameTimer);
  nameTimer = setTimeout(commitName, 500);
}

function commitName() {
  clearTimeout(nameTimer);
  const p = sheet?.place;
  const input = el("place-name");
  if (!p || !input) return;
  const name = input.value.trim() || decimals(p.lat, p.lon);
  if (name === p.name) return;
  p.name = name;
  persist(p);
  const node = markers.get(p.id)?.getElement();
  if (node) node.title = name;
  renderPlacesList();
}

function deleteSheetPlace() {
  const p = sheet?.place;
  if (!p) return;
  clearTimeout(nameTimer);
  sheet.place = null; // avant la fermeture : le nom d'un lieu supprimé ne se réécrit pas
  removePlace(p.id);
  closeSheet();
  toast("Lieu supprimé.", { type: "info" });
}

export function removePlace(id) {
  if (!byId.delete(id)) return;
  markers.get(id)?.remove();
  markers.delete(id);
  delPlace(id).catch((err) => console.warn("Suppression du lieu non persistée :", err));
  touchPlaces();
  renderPlacesList();
}

let warned = false;
function persist(p) {
  putPlace({ ...p }).catch((err) => {
    console.warn("Lieu non enregistré :", err);
    if (warned) return;
    warned = true; // une seule alerte : un flot de toasts n'aide personne
    toast("Lieu non enregistré — stockage indisponible.", { type: "error" });
  });
  touchPlaces();
}

// ---------- Ouverture depuis l'extérieur (marqueur, liste) ----------
export function openPlace(p) {
  clearPin();
  openSheet({ lat: p.lat, lon: p.lon, place: p });
}

export function flyToPlace(id) {
  const p = byId.get(id);
  if (!p) return;
  if (state.view !== "carte") switchTab("carte");
  flyToL(p.lat, p.lon, Math.max(FLY_ZOOM, mapZoom()), { duration: 900 });
  openPlace(p);
}

// ---------- Liste « Mes lieux » (onglet Itinéraires) ----------
export function renderPlacesList() {
  const host = el("navview-places");
  if (!host) return;
  const list = allPlaces();
  if (!list.length) {
    host.innerHTML =
      `<p class="muted">Aucun lieu épinglé. Sur la carte, appuyez longuement (ou clic droit) sur un point pour l'enregistrer.</p>`;
    return;
  }
  host.innerHTML = list
    .map(
      (p) => `<div class="place-row" data-place="${p.id}">
        <span class="place-row-pin">${PIN_SVG}</span>
        <button type="button" class="place-row-main">
          <span class="place-row-name">${escapeHtml(p.name)}</span>
          <span class="place-row-meta">${escapeHtml(metaOf(p) || decimals(p.lat, p.lon))}</span>
        </button>
        <button type="button" class="place-row-del btn-ghost btn-ghost-danger" aria-label="Supprimer ${escapeHtml(p.name)}">✕</button>
      </div>`
    )
    .join("");

  host.querySelectorAll(".place-row").forEach((row) => {
    const id = row.dataset.place;
    row.querySelector(".place-row-main").addEventListener("click", () => flyToPlace(id));
    row.querySelector(".place-row-del").addEventListener("click", () => removePlace(id));
  });
}

// ---------- Câblage ----------
export function initPlaces() {
  // Rôle par défaut de l'appui long / clic droit hors navigation. Enregistré ici plutôt
  // qu'importé par map.js : c'est places.js qui dépend de la carte, pas l'inverse.
  setPinHandler((lngLat) => {
    showPin(lngLat.lat, lngLat.lng);
    openSheet({ lat: lngLat.lat, lon: lngLat.lng });
  });

  el("place-close")?.addEventListener("click", closeSheet);
  el("place-scrim")?.addEventListener("click", closeSheet);
  el("place-save")?.addEventListener("click", savePlace);
  el("place-del")?.addEventListener("click", deleteSheetPlace);
  el("place-name")?.addEventListener("input", onNameInput);
  el("place-name")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); savePlace(); }
  });

  el("place-copy")?.addEventListener("click", async () => {
    if (!sheet) return;
    const btn = el("place-copy");
    try {
      await navigator.clipboard.writeText(decimals(sheet.lat, sheet.lon));
      btn.textContent = "✓ Copié";
    } catch {
      btn.textContent = "Copie impossible";
    }
    setTimeout(() => (btn.textContent = "Copier"), 1500);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el("place-sheet")?.classList.contains("hidden")) closeSheet();
  });
}
