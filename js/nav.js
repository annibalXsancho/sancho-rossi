// Sancho Rossi — navigation : vraie vue plein écran (S-V2-NAV)
// Façon Google Maps / AllTrails : carte suivie et pivotée au CAP DE MARCHE (légère
// inclinaison), métriques glissables (durée/distance restantes, distance totale,
// D+ RÉALISÉ enfin tracké), profil altimétrique LIÉ à la carte, alerte d'écart (S6).
// Le mode « éco » (ex-Survivor) garde la carte visible, figée sur le dernier ping mesuré.
import { getTrail, trackOf, sampleTrack, haversineKm } from "./state.js";
import { map, domMarker, makeIcon } from "./map.js";
import { selectTrail } from "./trails.js";
import { switchTab } from "./ui.js";
import { savePos } from "./security.js";
import { hasPack, packPoiLayer } from "./offline.js";
import { toast } from "./toast.js";
import { createProfile } from "./profile.js";
import { ensureElevation } from "./api.js";
import { naismithHours, fmtDuration, cumulativeKm } from "./metrics.js";

const OFF_BASE_M = 120;      // seuil de base « hors tracé » (m)
const STALE_MS = 30000;      // au-delà : le fix GPS est considéré perdu
const GPS_TIMEOUT_MS = 30000;
const NAV_ZOOM = 16;         // zoom de navigation (lit les lacets du sentier)
const NAV_PITCH = 50;        // inclinaison « cap de marche » (0 = vue du dessus)
const HEADING_MIN_MS = 0.7;  // sous cette vitesse (m/s), le cap GPS n'est pas fiable
const HYST_M = 4;            // même hystérésis que metrics.computeGain (D+ réalisé)

const nav = {
  active: false,
  survivor: false,
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
};

// La session en cours est persistée dans sr-nav pour qu'un rechargement de la page
// (volontaire ou non) ne coupe jamais une navigation : main.js la relance au boot.
function persistNav() {
  if (!nav.active) return;
  localStorage.setItem("sr-nav", JSON.stringify({
    id: nav.trail.id, startedAt: nav.startedAt, survivor: nav.survivor,
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

function onVisibility() {
  if (document.visibilityState === "visible" && nav.active && !nav.survivor && !nav.wakeLock) {
    requestWakeLock();
  }
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

// État GPS partagé HUD avancé (#nav-gps) + éco (#surv-gps, visible seulement si perdu)
function setGps(text, stateName) {
  const el = document.getElementById("nav-gps");
  if (el) { el.textContent = text; el.dataset.state = stateName; }
  const s = document.getElementById("surv-gps");
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
  if (!nav.follow || nav.survivor) return;
  const opts = cameraOpts({ center: [lon, lat], duration: nav.engaged ? 900 : 0 });
  if (!nav.engaged) { opts.zoom = NAV_ZOOM; nav.engaged = true; }
  map.easeTo(opts);
}

// Un geste manuel (glisser/pivoter/zoomer) désarme le suivi et révèle « Recentrer ». Les
// easeTo programmatiques n'ont pas d'`originalEvent` → on les ignore, sinon le suivi
// se couperait lui-même.
function onUserGesture(e) {
  if (!nav.active || nav.survivor || !nav.follow || !e.originalEvent) return;
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
  nav.marker.getElement().classList.toggle("is-ping", nav.survivor);
  updatePosMarker();
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
  document.getElementById("surv-title").textContent = t.name;
  document.getElementById("nav-total").textContent = (t.distance || nav.total).toFixed(1);
  setGps("Recherche du signal GPS…", "search");
  document.getElementById("nav-sheet")?.classList.add("nav-sheet-collapsed");

  loadElevation(id, t);

  // Pack offline : les POI eau/refuges/secours enregistrés s'affichent, y compris
  // sans réseau (Overpass live indisponible en mode avion).
  if (hasPack(id)) {
    packPoiLayer(id).then((group) => {
      if (group && nav.active && nav.trail?.id === id) { nav.poiLayer = group; group.addTo(map); }
    }).catch(() => {});
  }

  nav.watchId = navigator.geolocation.watchPosition(onNavFix, onNavError,
    { enableHighAccuracy: true, maximumAge: 5000, timeout: GPS_TIMEOUT_MS });

  // Chien de garde : si aucun fix n'arrive pendant STALE_MS (sans que le callback
  // d'erreur ne se déclenche sur tous les navigateurs), on signale le signal perdu.
  nav.staleTimer = setInterval(() => {
    if (nav.lastFixTs && Date.now() - nav.lastFixTs > STALE_MS) {
      setGps("⚠ signal GPS perdu", "lost");
    }
  }, 10000);

  requestWakeLock();
  if (resume?.survivor) setSurvivor(true);
  persistNav(); // après le stopNavigation() d'entrée, qui purge sr-nav
}

function onNavError(err) {
  setGps(`⚠ GPS : ${err.message}`, "lost");
}

function onNavFix(pos) {
  savePos(pos); // alimente la dernière position connue (volet Sécurité)
  nav.lastFixTs = Date.now();
  const { latitude: lat, longitude: lon, altitude, speed, accuracy, heading } = pos.coords;
  nav.lastPos = { lat, lon };

  const throttle = nav.survivor ? 20000 : 2500; // éco : écran rafraîchi toutes les 20 s
  const now = Date.now();
  if (now - nav.lastUi < throttle) return;
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

  if (nav.survivor) {
    document.getElementById("surv-remaining").textContent = m.remaining.toFixed(1);
    document.getElementById("surv-done").textContent = m.done.toFixed(1);
    document.getElementById("surv-time").textContent =
      new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    document.getElementById("surv-off").classList.toggle("hidden", !off);
    return; // pas de suivi caméra en éco : carte figée sur le ping (jumpTo à l'entrée)
  }

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

export function setSurvivor(on) {
  nav.survivor = on;
  document.getElementById("nav-survivor").classList.toggle("hidden", !on);
  document.body.classList.toggle("survivor-active", on);
  nav.marker?.getElement().classList.toggle("is-ping", on);
  if (on) {
    releaseWakeLock(); // écran libre de se mettre en veille : conso minimale
    // Carte figée : on remet le nord en haut, à plat, centrée une fois sur le dernier ping.
    if (nav.lastPos) map.jumpTo({ center: [nav.lastPos.lon, nav.lastPos.lat], bearing: 0, pitch: 0 });
    else map.jumpTo({ bearing: 0, pitch: 0 });
  } else {
    if (nav.active) { // ne pas ré-armer le verrou en quittant la nav
      requestWakeLock();
      nav.engaged = false; // le prochain fix recadre proprement (zoom + cap + inclinaison)
      if (nav.follow && nav.lastPos) followTick(nav.lastPos.lat, nav.lastPos.lon);
    }
    setTimeout(() => map.resize(), 60);
  }
  persistNav();
}

export function stopNavigation() {
  localStorage.removeItem("sr-nav");
  if (nav.watchId !== null) navigator.geolocation.clearWatch(nav.watchId);
  nav.watchId = null;
  if (nav.staleTimer !== null) clearInterval(nav.staleTimer);
  nav.staleTimer = null;
  nav.active = false;
  nav.offAlerted = false;
  nav.marker?.remove();
  nav.marker = null;
  nav.poiLayer?.remove();
  nav.poiLayer = null;
  removeProfMarker();
  nav.profile?.destroy();
  nav.profile = null;
  releaseWakeLock();
  setSurvivor(false);
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
    total: nav.total, survivor: nav.survivor, lastM: nav.lastM,
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
  document.getElementById("surv-stop").addEventListener("click", stopNavigation);
  document.getElementById("nav-mode").addEventListener("click", () => setSurvivor(true));
  document.getElementById("surv-advanced").addEventListener("click", () => setSurvivor(false));
  document.getElementById("nav-recenter").addEventListener("click", recenter);
  document.getElementById("nav-heading").addEventListener("click", toggleHeading);
  document.addEventListener("visibilitychange", onVisibility);
  map.on("dragstart", onUserGesture);
  map.on("rotatestart", onUserGesture);
  map.on("zoomstart", onUserGesture);
  map.on("rotate", updateHeadingNeedle);
  initNavSheet();
}
