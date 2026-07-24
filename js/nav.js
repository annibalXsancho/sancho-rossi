// Sancho Rossi — navigation : vraie vue plein écran (S-V2-NAV)
// Façon Google Maps / AllTrails : carte suivie et pivotée au CAP DE MARCHE (légère
// inclinaison), métriques glissables (durée/distance restantes, distance totale,
// D+ RÉALISÉ enfin tracké), profil altimétrique LIÉ à la carte, alerte d'écart (S6).
//
// PRIMAL MODE (S-V2-CAVEMAN) : l'économie d'énergie pour de vrai. Le watchPosition
// continu s'arrête au profit de relevés ponctuels à CADENCE ADAPTATIVE (~20 s en marche,
// espacés jusqu'à 5 min à l'arrêt), l'écran est voilé de noir et STATIQUE (aucune
// animation en boucle, aucune animation de caméra), et il ne reste que deux chiffres :
// km parcourus / km restants.
import { getTrail, trackOf, sampleTrack, haversineKm } from "./state.js";
import { map, domMarker, makeIcon, is3D, set3D, setLayersDim, setLongPress } from "./map.js";
import { selectTrail } from "./trails.js";
import { switchTab } from "./ui.js";
import { savePos, suspendPosWatch, resumePosWatch } from "./security.js";
import { hasPack, packPoiLayer } from "./offline.js";
import { toast } from "./toast.js";
import { createProfile } from "./profile.js";
import { ensureElevation } from "./api.js";
import { naismithHours, fmtDuration, cumulativeKm } from "./metrics.js";
import { ANNOT_KINDS, annotKind } from "./annotations.js";
import { addFieldMark, updateFieldMark, removeFieldMark, trailMarks } from "./fieldmarks.js";

const OFF_BASE_M = 120;      // seuil de base « hors tracé » (m)
const STALE_MS = 30000;      // au-delà : le fix GPS est considéré perdu
const GPS_TIMEOUT_MS = 30000;
const NAV_ZOOM = 16;         // zoom de navigation (lit les lacets du sentier)
const NAV_PITCH = 50;        // inclinaison « cap de marche » (0 = vue du dessus)
const HEADING_MIN_MS = 0.7;  // sous cette vitesse (m/s), le cap GPS n'est pas fiable
const HYST_M = 4;            // même hystérésis que metrics.computeGain (D+ réalisé)

// ---- Primal mode ----
export const PRIMAL_FAST_MS = 20000;   // cadence en marche
export const PRIMAL_SLOW_MS = 300000;  // plafond à l'arrêt (5 min)
const PRIMAL_GROWTH = 1.6;             // espacement progressif : 20 → 32 → 51 → 82 s…
const PRIMAL_MOVE_M = 25;              // en deçà de ce delta, on n'a pas bougé
const PRIMAL_FIX_TIMEOUT_MS = 25000;
// Zoom PROJET garanti hors-ligne : TOUS les packs (rando comme zone) embarquent les
// 7 calques jusqu'à z15 → la vue primal reste lisible en mode avion, quel que soit le
// calque affiché.
const PRIMAL_ZOOM = 15;
// La carte n'est éteinte QUE quand personne ne la regarde : elle revient à pleine lumière
// dès qu'on rallume l'écran ou qu'on la tape — les deux seuls moments où on la consulte,
// « de temps en temps ou à un tournant » (choix utilisateur). Le reste du temps l'écran est
// éteint de toute façon ; l'assombrissement n'est que le filet pour l'écran resté allumé.
const PRIMAL_DIM = 0.45;               // opacité des fonds quand personne ne regarde
const LIT_MS = 30000;                  // durée de pleine lumière après un tap ou un réveil
const PING_PULSE_MS = 2600;

const nav = {
  active: false,
  primal: false,
  trail: null,
  watchId: null,
  samples: null,
  cum: null,        // distances cumulées (km) le long des échantillons
  total: 0,
  lastUi: 0,
  marker: null,
  wakeLock: null,
  poiLayer: null,   // POI eau/refuges/secours du pack offline, visibles hors-ligne
  offAlerted: false, // vrai tant qu'on est signalé hors tracé (vibration one-shot)
  lastFixTs: 0,      // horodatage du dernier fix reçu (détection de perte de signal)
  staleTimer: null,
  startedAt: 0,      // départ de la session (survit au rechargement via sr-nav)
  lastM: null,       // dernières métriques calculées (carte de session, onglet Navigation)
  // --- Suivi caméra (S-V2-NAV) ---
  follow: true,      // la carte suit ma position ; un geste manuel le désarme
  headingUp: true,   // cap de marche en haut + inclinaison ; sinon nord en haut, à plat
  navBearing: null,  // cap lissé (deg) ; null = pas encore de fix
  engaged: false,    // premier cadrage effectué (le suivant s'anime)
  lastPos: null,     // dernière position connue {lat, lon}
  // --- D+ réalisé + profil ---
  eles: null,
  cumDist: null,     // distances cumulées (km) alignées sur `eles`, recalées sur `total`
  cumGain: null,     // D+ cumulé (m) à chaque index de `eles`
  totalGain: null,
  profile: null,     // handle createProfile
  profMarker: null,  // marqueur temporaire posé en survolant le profil
  // --- Primal mode (S-V2-CAVEMAN) ---
  primalTimer: null,
  primalBusy: false,   // un relevé est en cours : jamais deux acquisitions concurrentes
  primalDelay: PRIMAL_FAST_MS,
  primalPrev: null,    // position du relevé précédent (détection de mouvement)
  primalNextAt: 0,     // horodatage du prochain relevé prévu (affiché, pas décompté)
  primalSince: 0,
  fixCount: 0,         // relevés depuis l'entrée : proxy honnête de consommation
  veilTimer: null,
  pingTimer: null,
  batt: null,          // mesure %/h quand navigator.getBattery existe
  was3D: false,
  // --- Repères de terrain (S-V2-ANNOT-TERRAIN) ---
  markMarkers: new Map(), // id de repère → marqueur carte (repères de terrain seuls)
  planMarkers: [],        // repères préparés au planificateur (champ `pois`), inertes
  sheetMark: null,        // repère en cours d'édition dans la feuille
  sheetPoint: null,       // point visé quand la feuille est ouverte avant de choisir un type
  noteTimer: null,
};

// La session en cours est persistée dans sr-nav pour qu'un rechargement de la page
// (volontaire ou non) ne coupe jamais une navigation : main.js la relance au boot.
function persistNav() {
  if (!nav.active) return;
  localStorage.setItem("sr-nav", JSON.stringify({
    id: nav.trail.id, startedAt: nav.startedAt, primal: nav.primal,
  }));
}

// Le verrou d'écran est relâché AUTOMATIQUEMENT par le navigateur dès que la page
// passe en arrière-plan (écran éteint, changement d'app). Sans ré-acquisition, il
// est perdu pour toute la rando → on le redemande au retour au premier plan.
async function requestWakeLock() {
  try {
    nav.wakeLock = await navigator.wakeLock?.request("screen");
    nav.wakeLock?.addEventListener?.("release", () => { nav.wakeLock = null; });
  } catch { nav.wakeLock = null; /* refusé ou non supporté : sans gravité */ }
}

function releaseWakeLock() {
  nav.wakeLock?.release().catch(() => {});
  nav.wakeLock = null;
}

// Retour au premier plan. En nav complète : on reprend le verrou d'écran. En primal :
// l'écran a le droit de s'éteindre, et une page cachée est gelée (iOS) ou étranglée
// (Android) — le relevé programmé n'a donc PAS eu lieu. On en prend un tout de suite et
// on réarme la cadence rapide : l'utilisateur regarde son téléphone, il veut du frais.
function onVisibility() {
  if (document.visibilityState !== "visible" || !nav.active) return;
  if (nav.primal) { brighten(); primalNow(); return; }
  if (!nav.wakeLock) requestWakeLock();
}

function bearingDeg([lat1, lon1], [lat2, lon2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Lissage angulaire par le plus court arc : sans lui, le cap saute de 359° à 1° et la
// carte fait un tour complet ; à l'arrêt le cap GPS devient erratique, le lissage l'amortit.
function smoothBearing(prev, target, factor = 0.25) {
  if (prev == null) return target;
  const d = ((target - prev + 540) % 360) - 180;
  return (prev + d * factor + 360) % 360;
}

function navMetrics(lat, lon) {
  let best = 0;
  let bestD = Infinity;
  nav.samples.forEach((p, i) => {
    const d = haversineKm([lat, lon], p);
    if (d < bestD) { bestD = d; best = i; }
  });
  const next = nav.samples[Math.min(best + 3, nav.samples.length - 1)];
  return {
    done: nav.cum[best],
    remaining: nav.total - nav.cum[best],
    offM: Math.round(bestD * 1000),
    heading: bearingDeg([lat, lon], next),
  };
}

// État GPS partagé HUD complet (#nav-gps) + primal (#primal-gps, visible si perdu)
function setGps(text, stateName) {
  const el = document.getElementById("nav-gps");
  if (el) { el.textContent = text; el.dataset.state = stateName; }
  const s = document.getElementById("primal-gps");
  if (s) s.classList.toggle("hidden", stateName !== "lost");
}

function showGpsFix(acc) {
  if (acc == null) { setGps("◉ position acquise", "ok"); return; }
  const stateName = acc <= 30 ? "ok" : acc <= 80 ? "warn" : "poor";
  setGps(`◉ signal GPS ±${acc} m`, stateName);
}

// ---------- D+ réalisé (metrics.computeGain, mais cumulé le long du tracé) ----------
function buildCumGain(eles) {
  const cum = [0];
  let gain = 0, ref = eles[0];
  for (let i = 1; i < eles.length; i++) {
    const e = eles[i];
    if (e - ref > HYST_M) { gain += e - ref; ref = e; }
    else if (ref - e > HYST_M) ref = e;
    cum.push(Math.round(gain));
  }
  return cum;
}

// Dernier index dont le cumul est ≤ km (dichotomie).
function indexAtKm(cum, km) {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= km) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// D+ réalisé à `doneKm` : interpolation linéaire du cumul entre deux échantillons.
function gainDoneAt(doneKm) {
  if (!nav.cumGain || !nav.cumDist) return null;
  const i = indexAtKm(nav.cumDist, doneKm);
  if (i >= nav.cumGain.length - 1) return nav.cumGain[nav.cumGain.length - 1];
  const d0 = nav.cumDist[i], d1 = nav.cumDist[i + 1];
  const f = d1 > d0 ? (doneKm - d0) / (d1 - d0) : 0;
  return Math.round(nav.cumGain[i] + f * (nav.cumGain[i + 1] - nav.cumGain[i]));
}

// Altitude relevée (profil), plus stable que l'altitude GPS bruitée, pour l'écran éco
// et le repli quand le GPS ne fournit pas d'altitude.
function eleDoneAt(doneKm) {
  if (!nav.eles || !nav.cumDist) return null;
  const i = indexAtKm(nav.cumDist, doneKm);
  return Math.round(nav.eles[i]);
}

// Charge les altitudes du tracé → cumuls de distance/D+ + profil interactif. Asynchrone
// (réseau) : avant sa résolution, D+/ETA/profil restent en « — », le reste navigue déjà.
function loadElevation(id, trail) {
  ensureElevation(trail)
    .then((eles) => {
      if (!nav.active || nav.trail?.id !== id || !eles?.length) return;
      nav.eles = eles;
      const track = trail.mainline || trackOf(trail);
      const raw = cumulativeKm(sampleTrack(track, eles.length));
      const rawTotal = raw[raw.length - 1] || 1;
      // Le cumul d'un échantillon coupe les virages : on le recale sur la distance du tracé.
      const scale = nav.total > 0 ? nav.total / rawTotal : 1;
      nav.cumDist = raw.map((c) => c * scale);
      nav.cumGain = buildCumGain(eles);
      nav.totalGain = nav.cumGain[nav.cumGain.length - 1];
      buildProfile(trail, eles, track);
    })
    .catch(() => {}); // hors-ligne sans pack d'altitude : on navigue sans D+ réalisé
}

// ---------- Profil altimétrique lié à la carte ----------
function buildProfile(trail, eles, track) {
  const el = document.getElementById("nav-profile");
  if (!el) return;
  nav.profile?.destroy();
  nav.profile = createProfile(el, {
    eles,
    track,
    ways: trail.ways,
    totalKm: trail.distance,
    height: 96,
    // Glisser un point du profil → marqueur temporaire sur la carte (la bulle du profil
    // porte déjà km + altitude) ; relâcher (pt null) le retire.
    onHover: (pt) => { pt ? showProfMarker(pt.lat, pt.lon) : removeProfMarker(); },
  });
}

function showProfMarker(lat, lon) {
  if (!nav.profMarker) {
    nav.profMarker = domMarker(lat, lon, { element: makeIcon("nav-prof-dot", "", 16) }).addTo(map);
  } else {
    nav.profMarker.setLngLat([lon, lat]);
  }
}
function removeProfMarker() { nav.profMarker?.remove(); nav.profMarker = null; }

// ---------- Caméra : suivi + cap de marche + inclinaison ----------
function cameraOpts(extra = {}) {
  return {
    bearing: nav.headingUp ? (nav.navBearing || 0) : 0,
    pitch: nav.headingUp ? NAV_PITCH : 0,
    ...extra,
  };
}

function followTick(lat, lon) {
  if (!nav.follow || nav.primal) return;
  const opts = cameraOpts({ center: [lon, lat], duration: nav.engaged ? 900 : 0 });
  if (!nav.engaged) { opts.zoom = NAV_ZOOM; nav.engaged = true; }
  map.easeTo(opts);
}

// Un geste manuel (glisser/pivoter/zoomer) désarme le suivi et révèle « Recentrer ». Les
// easeTo programmatiques n'ont pas d'`originalEvent` → on les ignore, sinon le suivi
// se couperait lui-même.
function onUserGesture(e) {
  if (!nav.active || nav.primal || !nav.follow || !e.originalEvent) return;
  nav.follow = false;
  document.getElementById("nav-recenter")?.classList.remove("hidden");
}

function recenter() {
  nav.follow = true;
  nav.engaged = true;
  document.getElementById("nav-recenter")?.classList.add("hidden");
  if (nav.lastPos) map.easeTo(cameraOpts({ center: [nav.lastPos.lon, nav.lastPos.lat], zoom: NAV_ZOOM, duration: 600 }));
}

function toggleHeading() {
  nav.headingUp = !nav.headingUp;
  document.getElementById("nav-heading")?.setAttribute("aria-pressed", String(nav.headingUp));
  if (nav.follow && nav.lastPos) map.easeTo(cameraOpts({ center: [nav.lastPos.lon, nav.lastPos.lat], duration: 450 }));
  else map.easeTo(cameraOpts({ duration: 450 }));
  updatePosMarker();
}

// L'aiguille du bouton d'orientation pointe toujours vers le nord réel (contre-rotée au
// cap de la carte) — repère constant quand la carte pivote.
function updateHeadingNeedle() {
  const n = document.querySelector(".nav-compass-needle");
  if (n) n.style.transform = `rotate(${-map.getBearing()}deg)`;
}

// Le marqueur de position est une flèche. En cap-de-marche la carte pivote (la marche est
// toujours vers le haut de l'écran) → flèche fixe vers le haut ; en nord-en-haut, la flèche
// s'oriente au cap.
function updatePosMarker() {
  const arrow = nav.marker?.getElement().querySelector(".nav-pos-arrow");
  if (arrow) arrow.style.transform = `rotate(${nav.headingUp ? 0 : (nav.navBearing || 0)}deg)`;
}

function ensureMarker(lat, lon) {
  if (!nav.marker) {
    const el = makeIcon("nav-pos");
    el.innerHTML = `<div class="nav-pos-arrow"></div>`;
    nav.marker = domMarker(lat, lon, { element: el }).addTo(map);
  } else {
    nav.marker.setLngLat([lon, lat]);
  }
  nav.marker.getElement().classList.toggle("is-ping", nav.primal);
  updatePosMarker();
}

// ================= PRIMAL MODE (S-V2-CAVEMAN) =================
// Duty-cycle GPS : la puce ne tourne plus en continu, on prend un point, on la laisse
// s'éteindre, on en reprend un plus tard. L'écart entre deux points s'adapte tout seul.

// Cadence suivante, en fonction du déplacement observé depuis le relevé précédent.
// Fonction PURE (aucun DOM, aucun état) — c'est elle qui porte toute la logique
// d'économie, elle se teste donc directement en Node.
// Le seuil de mouvement suit la précision annoncée par le GPS, comme le seuil hors-tracé
// de S6 : à ±60 m, un point qui « saute » de 30 m n'est pas un pas, c'est du bruit.
export function nextPrimalDelay(prevDelay, movedM, accM) {
  const threshold = Math.max(PRIMAL_MOVE_M, accM || 0);
  if (movedM > threshold) return PRIMAL_FAST_MS;
  return Math.min(PRIMAL_SLOW_MS, Math.round((prevDelay || PRIMAL_FAST_MS) * PRIMAL_GROWTH));
}

function primalSchedule(delay) {
  clearTimeout(nav.primalTimer);
  nav.primalDelay = delay;
  nav.primalNextAt = Date.now() + delay;
  nav.primalTimer = setTimeout(primalRequestFix, delay);
}

// Le relevé suivant n'est armé QUE dans le callback (succès ou échec) : deux acquisitions
// ne peuvent jamais se chevaucher, et une acquisition lente ne se fait pas doubler.
function primalRequestFix() {
  if (!nav.active || !nav.primal || nav.primalBusy) return;
  nav.primalBusy = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => { nav.primalBusy = false; onPrimalFix(pos); },
    (err) => { nav.primalBusy = false; onPrimalError(err); },
    {
      enableHighAccuracy: true,
      timeout: PRIMAL_FIX_TIMEOUT_MS,
      // Un point tout frais relevé par un autre consommateur est bon à prendre : il est
      // gratuit. Au-delà, on veut du neuf.
      maximumAge: Math.min(15000, nav.primalDelay / 3),
    }
  );
}

// Relevé immédiat (tap sur la carte, retour au premier plan) + retour à la cadence rapide.
function primalNow() {
  if (!nav.active || !nav.primal) return;
  clearTimeout(nav.primalTimer);
  nav.primalDelay = PRIMAL_FAST_MS;
  primalRequestFix();
}

function onPrimalFix(pos) {
  if (!nav.primal) return;
  savePos(pos); // dernière position connue + signe de vie pour la veille ntfy
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  const acc = accuracy != null ? Math.round(accuracy) : null;
  nav.lastFixTs = Date.now();
  nav.lastPos = { lat, lon };
  nav.fixCount++;

  const movedM = nav.primalPrev
    ? haversineKm([nav.primalPrev.lat, nav.primalPrev.lon], [lat, lon]) * 1000
    : Infinity; // premier point : on démarre en cadence rapide
  nav.primalPrev = { lat, lon };

  const m = navMetrics(lat, lon);
  nav.lastM = m;
  setGps(`◉ signal GPS ±${acc ?? "?"} m`, "ok");

  // Alerte d'écart conservée (S6) : seuil adaptatif + une seule vibration au franchissement.
  const off = m.offM > Math.max(OFF_BASE_M, acc || 0);
  if (off && !nav.offAlerted) { navigator.vibrate?.([220, 90, 220]); nav.offAlerted = true; }
  else if (!off) nav.offAlerted = false;

  ensureMarker(lat, lon);
  pulsePing();
  keepPingInView(lat, lon);

  primalSchedule(nextPrimalDelay(nav.primalDelay, movedM, acc));
  renderPrimal(m, acc, off);
}

// Pas de fix : on n'insiste pas toutes les 20 s (c'est exactement là que la puce consomme
// le plus, à chercher dans le vide) — on s'espace comme à l'arrêt.
function onPrimalError(err) {
  if (!nav.primal) return;
  setGps(`⚠ GPS : ${err.message}`, "lost");
  primalSchedule(nextPrimalDelay(nav.primalDelay, 0, null));
  renderPrimal(nav.lastM, null, false);
}

// ---------- Rendu : deux chiffres, une ligne d'état, rien d'autre ----------
const hhmm = (ms) => new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

function renderPrimal(m, acc, off = false) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("primal-done", m ? m.done.toFixed(1) : "—");
  set("primal-remaining", m ? m.remaining.toFixed(1) : "—");
  set("primal-status", primalStatus(acc));
  document.getElementById("primal-off")?.classList.toggle("hidden", !off);
}

function primalStatus(acc) {
  const parts = [];
  if (nav.lastFixTs) parts.push(`point à ${hhmm(nav.lastFixTs)}${acc != null ? ` ±${acc} m` : ""}`);
  if (nav.primalNextAt) parts.push(`prochain vers ${hhmm(nav.primalNextAt)}`);
  parts.push(`${nav.fixCount} point${nav.fixCount > 1 ? "s" : ""} depuis ${hhmm(nav.primalSince)}`);
  const drain = battDrain();
  if (drain) parts.push(drain);
  return parts.join(" · ");
}

// Consommation mesurée, quand le navigateur la donne (Chrome/Android ; absente d'iOS et
// de Safari). C'est LE chiffre qui permet de comparer primal et mode complet — l'objet
// même du sprint —, affiché seulement une fois la mesure significative.
function initBattery() {
  nav.batt = null;
  navigator.getBattery?.().then((b) => {
    if (nav.primal) nav.batt = { b, level0: b.level, t0: Date.now() };
  }).catch(() => {});
}

function battDrain() {
  if (!nav.batt) return null;
  const h = (Date.now() - nav.batt.t0) / 3600e3;
  if (h < 1 / 6) return null; // moins de 10 min : la mesure ne veut rien dire
  const pct = ((nav.batt.level0 - nav.batt.b.level) * 100) / h;
  return pct > 0 ? `−${pct.toFixed(1)} %/h` : null;
}

// ---------- Écran sombre et statique ----------
// On éteint les TUILES, pas l'écran : un voile DOM posé sur toute la carte éteignait aussi
// le tracé et le ping (constaté en capture), alors que ce sont les deux seules choses à
// voir. `setLayersDim` (map.js) n'agit que sur les fonds raster.
function dimRasters(on) {
  setLayersDim(on ? PRIMAL_DIM : 1);
}

// Le ping ne pulse plus en boucle (une animation infinie réveille le compositeur à chaque
// frame) : il pulse UNE fois à l'arrivée d'un point, puis c'est un point fixe.
function pulsePing() {
  const el = nav.marker?.getElement();
  if (!el) return;
  el.classList.remove("is-fresh");
  void el.offsetWidth; // force le redémarrage de l'animation si deux points s'enchaînent
  el.classList.add("is-fresh");
  clearTimeout(nav.pingTimer);
  nav.pingTimer = setTimeout(() => el.classList.remove("is-fresh"), PING_PULSE_MS);
}

// Tap ou réveil de l'écran : la carte revient à pleine lumière, puis s'éteint d'elle-même.
function brighten() {
  dimRasters(false);
  clearTimeout(nav.veilTimer);
  nav.veilTimer = setTimeout(() => { if (nav.primal) dimRasters(true); }, LIT_MS);
}

// Recadrage seulement quand le ping sort du rectangle intérieur (80 % de l'écran), et
// toujours en jumpTo : une animation de caméra, c'est une seconde de rendu continu.
function keepPingInView(lat, lon) {
  const c = map.getCanvas();
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  const p = map.project([lon, lat]);
  const mx = w * 0.1, my = h * 0.1;
  if (p.x < mx || p.x > w - mx || p.y < my || p.y > h - my) map.jumpTo({ center: [lon, lat] });
}

// Le tap carte est le seul geste du mode : il rallume la carte ET relève un point.
// (`click` MapLibre ne se déclenche pas après un glisser : la carte reste déplaçable.)
function onPrimalMapClick() {
  if (!nav.primal) return;
  showPrimalInfo(false);
  brighten();
  primalNow();
}

// Mode d'emploi : rangé derrière le « i » pour que l'écran ne porte que les deux chiffres.
function showPrimalInfo(on) {
  const bubble = document.getElementById("primal-info-bubble");
  const btn = document.getElementById("primal-info");
  if (!bubble || !btn) return;
  const open = on ?? bubble.classList.contains("hidden");
  bubble.classList.toggle("hidden", !open);
  btn.setAttribute("aria-expanded", String(open));
}

// ================= REPÈRES DE TERRAIN (S-V2-ANNOT-TERRAIN) =================
// Poser un repère en marchant, en DEUX gestes : le bouton, puis le type. Le tap sur le
// type pose le repère — la note qui suit est facultative, jamais une étape obligatoire.
// Tout est local (IndexedDB via fieldmarks.js) : le mode avion ne change rien.

const markEl = (id) => document.getElementById(id);

// Pastille de repère sur la carte de nav — même dessin que la fiche et le planificateur.
function markIconEl(m) {
  return makeIcon("plan-annot", `<span class="plan-annot-i">${annotKind(m.kind).icon}</span>`);
}

// Repères déjà connus de l'itinéraire, posés à l'entrée en navigation : ceux préparés à la
// maison (champ `pois`, inertes) ET ceux du terrain (cliquables → note / suppression).
function renderNavMarks() {
  clearNavMarks();
  if (!nav.trail) return;
  for (const m of trailMarks(nav.trail)) {
    if (m.field) addMarkMarker(m);
    else {
      const el = markIconEl(m);
      el.title = m.note || annotKind(m.kind).label;
      el.style.pointerEvents = "none";
      nav.planMarkers.push(domMarker(m.lat, m.lon, { element: el }).addTo(map));
    }
  }
}

function addMarkMarker(m) {
  const el = markIconEl(m);
  el.title = m.note || annotKind(m.kind).label;
  el.addEventListener("click", (e) => {
    e.stopPropagation(); // ne pas déclencher le tap carte du primal (relevé + éclaircissement)
    openMarkSheet({ mark: m });
  });
  nav.markMarkers.set(m.id, domMarker(m.lat, m.lon, { element: el }).addTo(map));
}

function clearNavMarks() {
  nav.markMarkers.forEach((mk) => mk.remove());
  nav.markMarkers.clear();
  nav.planMarkers.forEach((mk) => mk.remove());
  nav.planMarkers = [];
}

// ---------- Feuille « repère » ----------
function buildMarkKinds() {
  const box = markEl("mark-kinds");
  if (!box) return;
  box.innerHTML = Object.entries(ANNOT_KINDS)
    .map(([k, d]) => `<button type="button" class="mark-kind" data-kind="${k}"><span class="mark-kind-ic">${d.icon}</span>${d.label}</button>`)
    .join("");
  box.addEventListener("click", (e) => {
    const b = e.target.closest(".mark-kind");
    if (b) createMark(b.dataset.kind);
  });
}

// Ouverture : soit sur un point à marquer (bouton « marquer » = ma position, appui long =
// le point pressé), soit sur un repère existant à retoucher.
function openMarkSheet({ lat, lon, mark = null, label = null } = {}) {
  const sheet = markEl("mark-sheet");
  if (!sheet || !nav.active) return;
  commitNote(); // une note en cours de saisie sur un autre repère n'est jamais perdue
  nav.sheetMark = mark;
  nav.sheetPoint = mark ? { lat: mark.lat, lon: mark.lon } : { lat, lon };
  markEl("mark-eyebrow").textContent = mark ? "Mon repère" : label || "Marquer ici";
  markEl("mark-kinds").classList.toggle("hidden", !!mark);
  markEl("mark-saved").classList.toggle("hidden", !mark);
  if (mark) fillSavedMark(mark);
  sheet.classList.remove("hidden");
}

function closeMarkSheet() {
  commitNote();
  nav.sheetMark = null;
  nav.sheetPoint = null;
  markEl("mark-sheet")?.classList.add("hidden");
}

// Le geste qui compte : un tap sur un type ET C'EST POSÉ.
function createMark(kind) {
  const p = nav.sheetPoint;
  if (!nav.trail || !p) return;
  const m = addFieldMark(nav.trail, { kind, lat: p.lat, lon: p.lon });
  // Altitude du profil (jamais celle du GPS, bruitée) quand elle est connue : gratuite,
  // locale, et elle rend le repère lisible sur la fiche.
  const ele = m.km != null ? eleDoneAt(m.km) : null;
  if (ele != null) updateFieldMark(m.id, { ele });
  addMarkMarker(m);
  nav.sheetMark = m;
  markEl("mark-kinds").classList.add("hidden");
  markEl("mark-saved").classList.remove("hidden");
  markEl("mark-eyebrow").textContent = "Repère posé";
  fillSavedMark(m);
  navigator.vibrate?.(30); // confirmation tactile : on marche, on ne regarde pas l'écran
}

function fillSavedMark(m) {
  const d = annotKind(m.kind);
  markEl("mark-saved-ic").textContent = d.icon;
  markEl("mark-saved-name").textContent = d.label;
  markEl("mark-saved-meta").textContent = [
    m.km != null ? `km ${m.km.toLocaleString("fr-FR")}` : "hors itinéraire",
    m.ele != null ? `${m.ele} m` : null,
    hhmm(m.ts),
  ].filter(Boolean).join(" · ");
  const input = markEl("mark-note");
  if (input) input.value = m.note || "";
}

// Note enregistrée au fil de la frappe (débouncée) ET à la fermeture : sur le terrain, on
// peut ranger le téléphone à tout moment.
function onNoteInput() {
  clearTimeout(nav.noteTimer);
  nav.noteTimer = setTimeout(commitNote, 500);
}

function commitNote() {
  clearTimeout(nav.noteTimer);
  const m = nav.sheetMark;
  const input = markEl("mark-note");
  if (!m || !input) return;
  const note = input.value.trim();
  if (note === (m.note || "")) return;
  updateFieldMark(m.id, { note });
  const el = nav.markMarkers.get(m.id)?.getElement();
  if (el) el.title = note || annotKind(m.kind).label;
}

function deleteSheetMark() {
  const m = nav.sheetMark;
  if (!m) return;
  clearTimeout(nav.noteTimer);
  nav.sheetMark = null; // avant la fermeture : la note d'un repère supprimé ne se réécrit pas
  removeFieldMark(m.id);
  nav.markMarkers.get(m.id)?.remove();
  nav.markMarkers.delete(m.id);
  closeMarkSheet();
  toast("Repère supprimé.", { type: "info" });
}

// Bouton « marquer » (nav complète et primal) : le repère se pose sur MA POSITION — en
// primal on réutilise le dernier relevé, sans réveiller la puce GPS.
function markHere() {
  if (!nav.lastPos) {
    toast("Position pas encore acquise — appuyez longuement sur la carte pour marquer un point.", { type: "info" });
    return;
  }
  if (nav.primal) brighten(); // on regarde l'écran : il doit être lisible
  openMarkSheet({ lat: nav.lastPos.lat, lon: nav.lastPos.lon });
}

// Appui long / clic droit sur la carte pendant la navigation : marquer AILLEURS que sur soi
// (la source aperçue en contrebas, le passage délicat qu'on vient de franchir). Hors nav,
// le geste garde son rôle d'origine — la bulle de coordonnées (map.js).
function onNavLongPress(lngLat) {
  if (!nav.active) return;
  if (nav.primal) brighten();
  openMarkSheet({ lat: lngLat.lat, lon: lngLat.lng, label: "Marquer ce point" });
}

export function startNavigation(id, { resume = null } = {}) {
  if (!navigator.geolocation) { toast("Géolocalisation non supportée sur cet appareil.", { type: "error" }); return; }
  stopNavigation();
  const t = getTrail(id);
  if (!t) {
    toast("Itinéraire introuvable — navigation annulée.", { type: "error" });
    localStorage.removeItem("sr-nav");
    return;
  }
  nav.trail = t;
  nav.active = true;
  nav.offAlerted = false;
  nav.lastFixTs = 0;
  nav.lastM = null;
  nav.follow = true;
  nav.engaged = false;
  nav.navBearing = null;
  nav.lastPos = null;
  nav.eles = nav.cumDist = nav.cumGain = nav.totalGain = null;
  nav.primalPrev = null;
  nav.primalDelay = PRIMAL_FAST_MS;
  nav.startedAt = resume?.startedAt || Date.now();

  const line = t.mainline || trackOf(t);
  nav.samples = sampleTrack(line, 400);
  nav.cum = [0];
  for (let i = 1; i < nav.samples.length; i++) {
    nav.cum.push(nav.cum[i - 1] + haversineKm(nav.samples[i - 1], nav.samples[i]));
  }
  nav.total = nav.cum[nav.cum.length - 1];

  switchTab("carte");
  setTimeout(() => selectTrail(id, { openDetail: false }), 80);
  document.body.classList.add("nav-active");
  document.getElementById("nav-hud").classList.remove("hidden");
  document.getElementById("nav-title").textContent = t.name;
  document.getElementById("primal-title").textContent = t.name;
  document.getElementById("nav-total").textContent = (t.distance || nav.total).toFixed(1);
  setGps("Recherche du signal GPS…", "search");
  document.getElementById("nav-sheet")?.classList.add("nav-sheet-collapsed");

  // Repères de l'itinéraire (préparés + posés sur le terrain) + appui long détourné vers
  // la pose de repère le temps de la navigation.
  renderNavMarks();
  setLongPress(onNavLongPress);

  loadElevation(id, t);

  // Pack offline : les POI eau/refuges/secours enregistrés s'affichent, y compris
  // sans réseau (Overpass live indisponible en mode avion).
  if (hasPack(id)) {
    packPoiLayer(id).then((group) => {
      if (group && nav.active && nav.trail?.id === id) { nav.poiLayer = group; group.addTo(map); }
    }).catch(() => {});
  }

  // Reprise directement en primal : on n'allume pas la puce en continu pour l'éteindre
  // dans la foulée (`primal` est le nom v2 ; `survivor` reste lu pour ne pas perdre une
  // session en cours au moment de la mise à jour).
  if (resume?.primal ?? resume?.survivor) {
    setPrimal(true);
  } else {
    startWatch();
    requestWakeLock();
  }
  persistNav(); // après le stopNavigation() d'entrée, qui purge sr-nav
}

// ---------- Suivi GPS continu (mode complet) ----------
function startWatch() {
  if (nav.watchId !== null) return;
  nav.watchId = navigator.geolocation.watchPosition(onNavFix, onNavError,
    { enableHighAccuracy: true, maximumAge: 5000, timeout: GPS_TIMEOUT_MS });

  // Chien de garde : si aucun fix n'arrive pendant STALE_MS (sans que le callback
  // d'erreur ne se déclenche sur tous les navigateurs), on signale le signal perdu.
  nav.staleTimer = setInterval(() => {
    if (nav.lastFixTs && Date.now() - nav.lastFixTs > STALE_MS) {
      setGps("⚠ signal GPS perdu", "lost");
    }
  }, 10000);
}

function stopWatch() {
  if (nav.watchId !== null) navigator.geolocation.clearWatch(nav.watchId);
  nav.watchId = null;
  if (nav.staleTimer !== null) clearInterval(nav.staleTimer);
  nav.staleTimer = null;
}

function onNavError(err) {
  setGps(`⚠ GPS : ${err.message}`, "lost");
}

function onNavFix(pos) {
  if (nav.primal) return; // le suivi continu est coupé en primal ; un fix en vol l'ignore
  savePos(pos); // alimente la dernière position connue (volet Sécurité)
  nav.lastFixTs = Date.now();
  const { latitude: lat, longitude: lon, altitude, speed, accuracy, heading } = pos.coords;
  nav.lastPos = { lat, lon };

  const now = Date.now();
  if (now - nav.lastUi < 2500) return;
  nav.lastUi = now;

  const m = navMetrics(lat, lon);
  nav.lastM = m;
  const acc = accuracy != null ? Math.round(accuracy) : null;
  showGpsFix(acc);

  // Cap : GPS si la vitesse le rend fiable, sinon relèvement vers le prochain point du tracé.
  const rawBearing = (heading != null && !Number.isNaN(heading) && (speed || 0) > HEADING_MIN_MS)
    ? heading : m.heading;
  nav.navBearing = smoothBearing(nav.navBearing, rawBearing);

  // Seuil adaptatif : un fix imprécis (couvert, gorge) ne doit pas crier « hors tracé ».
  const off = m.offM > Math.max(OFF_BASE_M, acc || 0);
  if (off && !nav.offAlerted) {
    navigator.vibrate?.([220, 90, 220]); // une seule vibration au franchissement
    nav.offAlerted = true;
  } else if (!off) {
    nav.offAlerted = false;
  }

  const gain = gainDoneAt(m.done);
  const altGps = altitude != null ? Math.round(altitude) : null;
  const altVal = altGps != null ? altGps : eleDoneAt(m.done);
  const altText = altVal != null ? `${altVal} m` : "—";

  ensureMarker(lat, lon);

  // Métriques de la feuille
  const remGain = nav.totalGain != null && gain != null ? Math.max(0, nav.totalGain - gain) : null;
  const etaH = remGain != null ? naismithHours(m.remaining, remGain) : null;
  document.getElementById("nav-remaining").textContent = m.remaining.toFixed(1);
  document.getElementById("nav-done").textContent = m.done.toFixed(1);
  document.getElementById("nav-gain").textContent = gain != null ? `${gain} m` : "—";
  document.getElementById("nav-alt").textContent = altText;
  document.getElementById("nav-speed").textContent = speed != null ? (speed * 3.6).toFixed(1) : "—";
  document.getElementById("nav-remain-time").textContent = etaH != null ? fmtDuration(etaH) : "—";
  document.getElementById("nav-eta").textContent = etaH != null
    ? new Date(now + etaH * 3600e3).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    : "—";
  document.getElementById("nav-offtrack").classList.toggle("hidden", !off);
  if (off) document.getElementById("nav-offdist").textContent = m.offM;

  // Profil : curseur = progression (notify:false → ne rappelle pas onHover).
  nav.profile?.setCursorKm(m.done);

  followTick(lat, lon);
}

export function setPrimal(on) {
  if (nav.primal === on) return;
  nav.primal = on;
  document.getElementById("primal-hud").classList.toggle("hidden", !on);
  document.body.classList.toggle("primal-active", on);
  nav.marker?.getElement().classList.toggle("is-ping", on);

  if (on) {
    // 1. Tout ce qui consomme en continu s'arrête : verrou d'écran, suivi GPS continu de
    //    la nav, chien de garde, suivi GPS optionnel de Réglages, relief 3D (DEM en ligne).
    releaseWakeLock();
    stopWatch();
    suspendPosWatch();
    nav.was3D = is3D();
    if (nav.was3D) set3D(false);

    // 2. Vue de haut minimale : nord en haut, à plat, au zoom garanti par les packs.
    const view = { bearing: 0, pitch: 0, zoom: PRIMAL_ZOOM - 1 }; // −1 : zoom PROJET → MapLibre
    if (nav.lastPos) view.center = [nav.lastPos.lon, nav.lastPos.lat];
    map.jumpTo(view);

    // 3. Session de mesure + premier point tout de suite.
    nav.primalSince = Date.now();
    nav.fixCount = 0;
    // Un relevé encore en vol au moment où l'on avait quitté le mode laisserait la garde
    // levée et la boucle morte au retour : on repart toujours d'une garde propre.
    nav.primalBusy = false;
    // Pas de position de référence héritée de la nav complète : le mode démarre toujours
    // en cadence rapide, l'espacement ne se mérite qu'entre deux relevés primal immobiles.
    nav.primalPrev = null;
    nav.primalDelay = PRIMAL_FAST_MS;
    nav.primalNextAt = 0;
    initBattery();
    renderPrimal(nav.lastM, null, false);
    brighten(); // on vient de taper : la carte reste lisible 12 s, puis s'éteint
    primalNow();
  } else {
    clearTimeout(nav.primalTimer);
    clearTimeout(nav.veilTimer);
    clearTimeout(nav.pingTimer);
    nav.primalTimer = nav.veilTimer = nav.pingTimer = null;
    nav.batt = null;
    dimRasters(false); // la carte retrouve sa luminosité
    resumePosWatch();
    if (nav.was3D) { set3D(true); nav.was3D = false; }
    if (nav.active) { // ne pas ré-armer le verrou ni le suivi en quittant la nav
      requestWakeLock();
      startWatch();
      nav.engaged = false; // le prochain fix recadre proprement (zoom + cap + inclinaison)
      if (nav.follow && nav.lastPos) followTick(nav.lastPos.lat, nav.lastPos.lon);
    }
    setTimeout(() => map.resize(), 60);
  }
  persistNav();
}

export function stopNavigation() {
  localStorage.removeItem("sr-nav");
  stopWatch();
  closeMarkSheet();   // avant `active = false` : la note en cours part en base
  nav.active = false;
  clearNavMarks();
  setLongPress(null); // la bulle de coordonnées retrouve l'appui long
  nav.offAlerted = false;
  nav.marker?.remove();
  nav.marker = null;
  nav.poiLayer?.remove();
  nav.poiLayer = null;
  removeProfMarker();
  nav.profile?.destroy();
  nav.profile = null;
  releaseWakeLock();
  setPrimal(false);
  document.body.classList.remove("nav-active");
  document.getElementById("nav-hud").classList.add("hidden");
  document.getElementById("nav-recenter")?.classList.add("hidden");
  // Retour à une carte plate, nord en haut, après le suivi incliné.
  map.easeTo({ bearing: 0, pitch: 0, duration: 400 });
  setTimeout(() => map.resize(), 60);
}

// Instantané de la session pour l'onglet Navigation (null si aucune nav en cours).
export function navSession() {
  if (!nav.active) return null;
  return {
    id: nav.trail.id, name: nav.trail.name, startedAt: nav.startedAt,
    total: nav.total, primal: nav.primal, lastM: nav.lastM,
  };
}

// ---------- Feuille de métriques glissable (mécanique reprise d'explorer.js) ----------
function initNavSheet() {
  const sheet = document.getElementById("nav-sheet");
  if (!sheet) return;
  const grip = document.getElementById("nav-sheet-grip");
  const peekPx = () => parseFloat(getComputedStyle(sheet).getPropertyValue("--nav-peek")) || 96;
  const collapsed = () => sheet.classList.contains("nav-sheet-collapsed");
  const setY = (y) => sheet.style.setProperty("--nav-y", `${y}px`);
  const expand = () => { sheet.classList.remove("nav-sheet-collapsed"); sheet.style.removeProperty("--nav-y"); };
  const collapse = () => { sheet.classList.add("nav-sheet-collapsed"); sheet.style.removeProperty("--nav-y"); };

  let dragging = false, moved = false, startY = 0, baseY = 0, curY = 0, maxY = 0, lastY = 0, lastT = 0, vel = 0;
  const onDown = (e) => {
    if (dragging) return;
    dragging = true; moved = false;
    startY = lastY = e.clientY; lastT = performance.now();
    maxY = Math.max(0, sheet.offsetHeight - peekPx());
    baseY = collapsed() ? maxY : 0;
    curY = baseY; setY(baseY);
    sheet.classList.add("nav-sheet-dragging");
    grip?.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    curY = Math.min(maxY, Math.max(0, baseY + dy));
    setY(curY);
    const now = performance.now();
    if (now > lastT) { vel = (e.clientY - lastY) / (now - lastT); lastY = e.clientY; lastT = now; }
    if (moved) e.preventDefault();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove("nav-sheet-dragging");
    sheet.style.removeProperty("--nav-y");
    if (!moved) { collapsed() ? expand() : collapse(); return; }
    (vel > 0.35 || (vel >= -0.35 && curY > maxY * 0.4)) ? collapse() : expand();
  };
  grip?.addEventListener("pointerdown", onDown);
  document.addEventListener("pointermove", onMove, { passive: false });
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", () => {
    if (dragging) { dragging = false; sheet.classList.remove("nav-sheet-dragging"); sheet.style.removeProperty("--nav-y"); }
  });
  grip?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    collapsed() ? expand() : collapse();
  });
}

export function initNav() {
  document.getElementById("nav-stop").addEventListener("click", stopNavigation);
  document.getElementById("primal-stop").addEventListener("click", stopNavigation);
  document.getElementById("nav-mode").addEventListener("click", () => setPrimal(true));
  document.getElementById("primal-full").addEventListener("click", () => setPrimal(false));
  document.getElementById("primal-info").addEventListener("click", () => showPrimalInfo());
  document.getElementById("nav-recenter").addEventListener("click", recenter);
  document.getElementById("nav-heading").addEventListener("click", toggleHeading);
  document.addEventListener("visibilitychange", onVisibility);

  // Repères de terrain : deux entrées (FAB de la nav, bouton de la barre primal), une
  // seule feuille.
  buildMarkKinds();
  document.getElementById("nav-mark")?.addEventListener("click", markHere);
  document.getElementById("primal-mark-btn")?.addEventListener("click", markHere);
  document.getElementById("mark-close")?.addEventListener("click", closeMarkSheet);
  document.getElementById("mark-scrim")?.addEventListener("click", closeMarkSheet);
  document.getElementById("mark-ok")?.addEventListener("click", closeMarkSheet);
  document.getElementById("mark-del")?.addEventListener("click", deleteSheetMark);
  document.getElementById("mark-note")?.addEventListener("input", onNoteInput);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("mark-sheet")?.classList.contains("hidden")) closeMarkSheet();
  });

  map.on("click", onPrimalMapClick);
  map.on("dragstart", onUserGesture);
  map.on("rotatestart", onUserGesture);
  map.on("zoomstart", onUserGesture);
  map.on("rotate", updateHeadingNeedle);
  initNavSheet();
}
