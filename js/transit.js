// Sancho Rossi — client transport public européen (S-V3-TRAIN-A).
// Source unique : Transitous (https://transitous.org), instance communautaire de MOTIS
// agrégeant les GTFS ouverts d'Europe. Gratuit, sans clé, CORS ouvert (`access-control-
// allow-origin: *` vérifié sur api.transitous.org) — donc appelable directement depuis
// cette app statique, sans serveur applicatif : la contrainte machine du projet tient.
//
// Politique d'usage : Transitous demande une identification de l'appelant. Un navigateur
// INTERDIT de poser `User-Agent` en fetch (en-tête protégé, la requête échouerait) : on
// s'identifie donc par un paramètre `client=` accolé à chaque appel — ignoré par MOTIS,
// visible dans ses journaux — et l'attribution est affichée dans le panneau (trains.js).
// Le reste de la courtoisie passe par le cache mémoire et l'annulation des recherches en
// vol (une frappe remplace la précédente), comme pour Nominatim (geosearch.js).
//
// PIÈGE MAJEUR — les mêmes trains sont publiés par PLUSIEURS jeux de données. À Grenoble,
// le TER de 8 h 28 apparaît dans le GTFS suisse (opentransportdata.swiss, qui couvre le
// transfrontalier) ET dans celui de la SNCF : deux entrées pour un seul train. Pire, elles
// sont complémentaires — le flux suisse porte la destination (`headsign`), le flux français
// porte le temps réel. On interroge donc volontairement LARGE (`radius`, qui ramasse les
// arrêts homologues des autres sources) puis on FUSIONNE par (heure théorique + ligne +
// numéro de train). Sans cette fusion, la liste est doublée et à moitié muette.
import { fetchRetry } from "./net.js";

const BASE = "https://api.transitous.org/api/v1";
const CLIENT = "sancho-rossi"; // identification courtoise (User-Agent interdit au navigateur)
export const ATTRIBUTION = "Transitous · données GTFS ouvertes";
export const ATTRIBUTION_URL = "https://transitous.org/sources/";

// Rayon de collecte autour de l'arrêt choisi : assez large pour attraper l'arrêt homologue
// d'un autre jeu de données (les deux « Grenoble » sont à ~30 m l'un de l'autre), assez
// serré pour ne pas mélanger la gare avec l'arrêt de bus du quartier voisin.
const MERGE_RADIUS_M = 250;

const url = (path, params) => {
  const q = new URLSearchParams({ ...params, client: CLIENT });
  return `${BASE}/${path}?${q}`;
};

async function getJson(path, params, { signal, retries = 1, timeout = 15000 } = {}) {
  const res = await fetchRetry(url(path, params), { signal, retries, timeout });
  if (!res.ok) {
    // MOTIS répond 422 « too many stops » quand la fenêtre demandée en couvre trop :
    // ce n'est pas une panne mais une invitation à zoomer, l'appelant doit le distinguer.
    const err = new Error(`Transitous ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------- Modes ----------
// Vocabulaire MOTIS → libellés français + famille (l'icône et les filtres s'y accrochent).
// Les remontées mécaniques ne sont pas un détail ici : en montagne, télécabine et
// funiculaire SONT le transport public qui mène au départ du sentier.
const MODES = {
  HIGHSPEED_RAIL: { label: "Grande vitesse", family: "rail" },
  LONG_DISTANCE: { label: "Grandes lignes", family: "rail" },
  NIGHT_RAIL: { label: "Train de nuit", family: "rail" },
  COACH: { label: "Car", family: "bus" },
  REGIONAL_FAST_RAIL: { label: "Train régional", family: "rail" },
  REGIONAL_RAIL: { label: "Train régional", family: "rail" },
  RAIL: { label: "Train", family: "rail" },
  METRO: { label: "Métro", family: "urban" },
  SUBWAY: { label: "Métro", family: "urban" },
  TRAM: { label: "Tram", family: "urban" },
  SUBURBAN: { label: "Train de banlieue", family: "rail" },
  BUS: { label: "Bus", family: "bus" },
  FERRY: { label: "Bateau", family: "boat" },
  AIRPLANE: { label: "Avion", family: "other" },
  AERIAL_LIFT: { label: "Télécabine", family: "lift" },
  FUNICULAR: { label: "Funiculaire", family: "lift" },
  CABLE_CAR: { label: "Téléphérique", family: "lift" },
  GONDOLA: { label: "Télécabine", family: "lift" },
  OTHER: { label: "Autre", family: "other" },
};

export const modeLabel = (m) => MODES[m]?.label || "Transport";
export const modeFamily = (m) => MODES[m]?.family || "other";

// Filtres du tableau des départs. `modes` est envoyé tel quel à MOTIS (paramètre `mode`),
// ce qui évite de rapatrier 200 passages de bus pour n'en afficher que les trains.
export const MODE_FILTERS = {
  tout: { label: "Tout", modes: null },
  train: {
    label: "Trains",
    modes: ["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "REGIONAL_FAST_RAIL", "REGIONAL_RAIL", "SUBURBAN", "RAIL"],
  },
  bus: { label: "Bus & cars", modes: ["BUS", "COACH"] },
  // Pas de GONDOLA ici : le mot existe côté GTFS mais PAS dans l'énumération de l'API
  // MOTIS, qui répond 500 « unknown value GONDOLA » et fait tomber tout le filtre. Il
  // reste dans la table des libellés ci-dessus (une réponse peut le porter), jamais en
  // paramètre de requête.
  lift: { label: "Remontées", modes: ["AERIAL_LIFT", "FUNICULAR", "CABLE_CAR"] },
};

// Un arrêt est « ferroviaire » s'il voit passer autre chose que du bus urbain : c'est le
// critère de tri des arrêts d'une zone (une gare avant un abribus).
const RAIL_FAMILIES = new Set(["rail", "lift", "boat"]);
export const isRailStop = (s) => (s.modes || []).some((m) => RAIL_FAMILIES.has(modeFamily(m)));

// ---------- Arrêts ----------
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Fusionne les doublons inter-sources d'une liste d'arrêts : même nom normalisé et même
// position au kilomètre près = un seul arrêt (les deux « Chamonix » des flux suisse et
// français sont à ~500 m l'un de l'autre — un seuil plus serré les laisserait passer).
// On garde l'entrée la mieux dotée en modes (elle sait ce qui passe) et on cumule les
// modes de toutes les sources.
function mergeStops(list) {
  const out = new Map();
  for (const s of list) {
    const key = `${norm(s.name)}|${s.lat.toFixed(2)}|${s.lon.toFixed(2)}`;
    const prev = out.get(key);
    if (!prev) { out.set(key, { ...s, modes: [...(s.modes || [])] }); continue; }
    prev.modes = [...new Set([...prev.modes, ...(s.modes || [])])];
    prev.importance = Math.max(prev.importance || 0, s.importance || 0);
    // L'id retenu est celui de la source la plus riche : c'est lui qui sera interrogé
    // (le `radius` des départs rattrapera de toute façon les arrêts homologues).
    if ((s.modes || []).length > (prev.srcModes || 0)) {
      prev.id = s.id;
      prev.srcModes = (s.modes || []).length;
    }
  }
  return [...out.values()];
}

const shapeStop = (r) => ({
  id: r.id || r.stopId,
  name: r.name,
  lat: r.lat,
  lon: r.lon,
  tz: r.tz,
  modes: r.modes || [],
  importance: r.importance || 0,
  area: (r.areas || []).filter((a) => a.adminLevel >= 4 && a.adminLevel <= 8).map((a) => a.name)[0] || "",
  country: r.country || "",
});

// Transitous agrège quelques réseaux hors d'Europe (Québec, notamment) : « Chamonix »
// y ramène quatre arrêts de bus de la ville de Québec, qui n'ont rien à faire dans un
// outil dont la couverture annoncée est européenne. On filtre sur le pays plutôt que sur
// la distance : chercher une gare lointaine (préparer un voyage en Norvège depuis les
// Alpes) doit rester possible.
const EUROPE = new Set([
  "AD","AL","AT","AX","BA","BE","BG","BY","CH","CY","CZ","DE","DK","EE","ES","FI","FO",
  "FR","GB","GE","GG","GI","GR","HR","HU","IE","IM","IS","IT","JE","LI","LT","LU","LV",
  "MC","MD","ME","MK","MT","NL","NO","PL","PT","RO","RS","RU","SE","SI","SK","SM","TR",
  "UA","VA","XK",
]);

// Recherche d'arrêt par le nom. `near` ([lat, lon]) biaise le classement vers la zone
// regardée : « Gare » tapé au-dessus des Écrins doit sortir Grenoble, pas Berlin.
export async function searchStops(q, { signal, near } = {}) {
  const params = { text: q, type: "STOP", language: "fr" };
  if (near) params.place = `${near[0].toFixed(5)},${near[1].toFixed(5)}`;
  const data = await getJson("geocode", params, { signal, retries: 0, timeout: 12000 });
  const stops = mergeStops(data.map(shapeStop).filter((s) => !s.country || EUROPE.has(s.country)));
  // Le score MOTIS est déjà un classement pertinent ; on remonte juste les arrêts
  // ferroviaires à score comparable, plus utiles ici qu'un arrêt de bus homonyme.
  return stops
    .sort((a, b) => (isRailStop(b) ? 1 : 0) - (isRailStop(a) ? 1 : 0))
    .slice(0, 8);
}

// Arrêts contenus dans la zone affichée. bbox = [[sud, ouest], [nord, est]].
// MOTIS attend `lat,lon` (l'ordre inverse renvoie silencieusement une liste vide).
export async function stopsInBounds([[south, west], [north, east]], { signal, limit = 12 } = {}) {
  const data = await getJson(
    "map/stops",
    { min: `${south.toFixed(5)},${west.toFixed(5)}`, max: `${north.toFixed(5)},${east.toFixed(5)}` },
    { signal, retries: 0, timeout: 15000 }
  );
  return mergeStops(data.map(shapeStop))
    .sort((a, b) => (isRailStop(b) ? 1 : 0) - (isRailStop(a) ? 1 : 0) || b.importance - a.importance)
    .slice(0, limit);
}

// ---------- Départs ----------
const minutes = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 60000);

function shapeDeparture(st) {
  const p = st.place || {};
  const scheduled = p.scheduledDeparture || p.scheduledArrival;
  const actual = p.departure || p.arrival;
  return {
    mode: st.mode,
    // La destination manque dans certains flux (la SNCF laisse `headsign` vide) : le
    // terminus du trajet (`tripTo`) prend alors le relais — jamais de ligne anonyme.
    to: (st.headsign || "").trim() || st.tripTo?.name || "",
    line: (st.routeShortName || st.displayName || "").trim(),
    number: (st.tripShortName || "").trim(),
    agency: st.agencyName || "",
    scheduled,
    time: actual || scheduled,
    delay: scheduled && actual ? minutes(actual, scheduled) : 0,
    realTime: !!st.realTime,
    cancelled: !!(st.cancelled || st.tripCancelled),
    track: p.track || p.scheduledTrack || "",
    stopName: p.name || "",
    tz: p.tz || "",
  };
}

// Fusion des doublons inter-sources (cf. en-tête). Clé : heure théorique + ligne + numéro
// de train — le numéro est le même dans tous les flux, c'est lui qui identifie le train.
// À défaut de numéro (bus urbains), on retombe sur la destination.
function mergeDepartures(rows) {
  const out = new Map();
  for (const r of rows) {
    const key = `${r.scheduled}|${norm(r.line)}|${r.number || norm(r.to)}`;
    const prev = out.get(key);
    if (!prev) { out.set(key, r); continue; }
    // On garde le meilleur de chaque source : la destination de celle qui l'a, l'horaire
    // réel de celle qui le publie. Un flux sans temps réel ne doit jamais écraser l'autre.
    if (!prev.to && r.to) prev.to = r.to;
    if (!prev.track && r.track) prev.track = r.track;
    if (!prev.realTime && r.realTime) {
      prev.realTime = true;
      prev.time = r.time;
      prev.delay = r.delay;
    }
    prev.cancelled = prev.cancelled || r.cancelled;
  }
  return [...out.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

// Tableau des départs d'un arrêt.
//   stopId  : id MOTIS (searchStops / stopsInBounds)
//   filter  : clé de MODE_FILTERS
//   cursor  : `nextPageCursor` d'un appel précédent (bouton « plus tard »)
// → { stop, rows, cursor } — `rows` déjà fusionnées et triées.
export async function departures(stopId, { filter = "tout", cursor, n = 12, signal } = {}) {
  const params = { stopId, n: String(n), radius: String(MERGE_RADIUS_M), arriveBy: "false" };
  const modes = MODE_FILTERS[filter]?.modes;
  if (modes) params.mode = modes.join(",");
  if (cursor) params.pageCursor = cursor;
  const data = await getJson("stoptimes", params, { signal, retries: 1, timeout: 20000 });
  return {
    stop: data.place ? shapeStop({ ...data.place, id: data.place.stopId }) : null,
    rows: mergeDepartures((data.stopTimes || []).map(shapeDeparture)),
    cursor: data.nextPageCursor || null,
  };
}

// ---------- Rendu des heures ----------
// MOTIS renvoie de l'UTC ; un départ se lit dans le fuseau de SA gare (un train à Zermatt
// s'affiche à l'heure suisse même si le téléphone est resté à l'heure de Paris).
export function hhmm(iso, tz) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("fr-FR", {
      hour: "2-digit", minute: "2-digit", timeZone: tz || undefined,
    }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  }
}

// « dans 7 min » tant que c'est imminent (l'information utile sur un quai), sinon rien :
// au-delà d'une heure, l'heure d'horloge suffit.
export function inMinutes(iso) {
  const d = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (!Number.isFinite(d) || d > 59) return "";
  if (d <= 0) return "à l'instant";
  return `dans ${d} min`;
}
