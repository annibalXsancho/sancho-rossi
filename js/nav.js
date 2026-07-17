// Sancho Rossi — navigation : suivi du tracé en temps réel (HUD + mode Survivor)
import { getTrail, trackOf, sampleTrack, haversineKm } from "./state.js";
import { map } from "./map.js";
import { selectTrail } from "./trails.js";
import { switchTab } from "./ui.js";
import { savePos } from "./security.js";
import { hasPack, packPoiLayer } from "./offline.js";
import { sunEvents } from "./astronomy.js";
import { toast } from "./toast.js";

const OFF_BASE_M = 120;      // seuil de base « hors tracé » (m)
const STALE_MS = 30000;      // au-delà : le fix GPS est considéré perdu
const GPS_TIMEOUT_MS = 30000;
// Allure de marche prudente (montagne, terrain, fatigue) pour estimer le temps restant
// et le comparer au jour restant. Volontairement basse : mieux vaut alerter trop tôt.
const NAV_PACE_KMH = 4;

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
  lastPan: 0,
  wakeLock: null,
  poiLayer: null,   // POI eau/refuges/secours du pack offline, visibles hors-ligne
  offAlerted: false, // vrai tant qu'on est signalé hors tracé (vibration one-shot)
  lastFixTs: 0,      // horodatage du dernier fix reçu (détection de perte de signal)
  staleTimer: null,
  nightAlerted: false, // vrai tant que « la nuit tombera avant l'arrivée » (toast one-shot)
};

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

const COMPASS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];

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

// État GPS partagé HUD avancé (#nav-gps) + Survivor (#surv-gps, visible seulement si perdu)
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

const fmtDur = (ms) => {
  const min = Math.round(ms / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
};

// Jour restant (calcul astronomique LOCAL, donc valable hors-ligne) + alerte quand le
// temps de marche estimé du reste dépasse le jour disponible. Alimente les deux HUD.
function updateDaylight(lat, lon, remainingKm) {
  const sun = sunEvents(lat, lon, new Date());
  let text, alert;
  if (sun.polar === "down") {
    text = "☀ Jour permanent"; alert = false;
  } else if (sun.polar === "up" || !sun.sunset) {
    text = "🌙 Nuit polaire — pas de jour aujourd'hui"; alert = true;
  } else {
    const remMs = sun.sunset - Date.now();
    const hm = sun.sunset.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    if (remMs <= 0) {
      text = `🌙 Nuit tombée — coucher ${hm}`; alert = true;
    } else {
      const needMs = (remainingKm / NAV_PACE_KMH) * 3600000;
      alert = needMs > remMs; // le reste ne tiendra pas dans le jour
      text = `${alert ? "⚠" : "☀"} ${fmtDur(remMs)} de jour${alert ? " — nuit avant l'arrivée" : ` (coucher ${hm})`}`;
    }
  }

  for (const id of ["nav-daylight", "surv-daylight"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = text;
    el.dataset.state = alert ? "alert" : "ok";
    el.classList.remove("hidden");
  }

  // Toast one-shot au basculement en alerte (comme la vibration hors-tracé) : on ne
  // matraque pas, mais le franchissement mérite d'être signalé une fois.
  if (alert && !nav.nightAlerted) {
    toast("⚠ La nuit tombera avant la fin du tracé au rythme actuel.", { type: "error" });
    navigator.vibrate?.([220, 90, 220]);
    nav.nightAlerted = true;
  } else if (!alert) {
    nav.nightAlerted = false;
  }
}

export function startNavigation(id) {
  if (!navigator.geolocation) { toast("Géolocalisation non supportée sur cet appareil.", { type: "error" }); return; }
  stopNavigation();
  const t = getTrail(id);
  nav.trail = t;
  nav.active = true;
  nav.offAlerted = false;
  nav.nightAlerted = false;
  nav.lastFixTs = 0;

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
  setGps("Recherche du signal GPS…", "search");

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
}

function onNavError(err) {
  setGps(`⚠ GPS : ${err.message}`, "lost");
}

function onNavFix(pos) {
  savePos(pos); // alimente la dernière position connue (volet Sécurité)
  nav.lastFixTs = Date.now();
  const throttle = nav.survivor ? 20000 : 2500; // Survivor : écran rafraîchi toutes les 20 s
  const now = Date.now();
  if (now - nav.lastUi < throttle) return;
  nav.lastUi = now;

  const { latitude: lat, longitude: lon, altitude, speed, accuracy } = pos.coords;
  const m = navMetrics(lat, lon);
  const altText = altitude != null ? `${Math.round(altitude)} m` : "—";
  const acc = accuracy != null ? Math.round(accuracy) : null;
  showGpsFix(acc);
  updateDaylight(lat, lon, m.remaining); // jour restant + alerte nuit (offline)

  // Seuil adaptatif : un fix imprécis (couvert, gorge) ne doit pas crier « hors tracé ».
  const off = m.offM > Math.max(OFF_BASE_M, acc || 0);
  if (off && !nav.offAlerted) {
    navigator.vibrate?.([220, 90, 220]); // une seule vibration au franchissement
    nav.offAlerted = true;
  } else if (!off) {
    nav.offAlerted = false;
  }

  if (nav.survivor) {
    document.getElementById("surv-remaining").textContent = m.remaining.toFixed(1);
    document.getElementById("surv-alt").textContent = altText;
    document.getElementById("surv-heading").textContent =
      `${COMPASS[Math.round(m.heading / 45) % 8]} ${Math.round(m.heading)}°`;
    document.getElementById("surv-time").textContent =
      new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    document.getElementById("surv-off").classList.toggle("hidden", !off);
    return;
  }

  document.getElementById("nav-remaining").textContent = m.remaining.toFixed(1);
  document.getElementById("nav-done").textContent = m.done.toFixed(1);
  document.getElementById("nav-alt").textContent = altText;
  document.getElementById("nav-speed").textContent =
    speed != null ? (speed * 3.6).toFixed(1) : "—";
  document.getElementById("nav-offtrack").classList.toggle("hidden", !off);
  if (off) document.getElementById("nav-offdist").textContent = m.offM;

  if (!nav.marker) {
    nav.marker = L.circleMarker([lat, lon], {
      radius: 9, color: "#fff", weight: 2.5, fillColor: "#ff2d20", fillOpacity: 1,
    }).addTo(map);
  } else {
    nav.marker.setLatLng([lat, lon]);
  }
  if (now - nav.lastPan > 4000) {
    map.panTo([lat, lon]);
    nav.lastPan = now;
  }
}

function setSurvivor(on) {
  nav.survivor = on;
  document.getElementById("nav-survivor").classList.toggle("hidden", !on);
  document.body.classList.toggle("survivor-active", on);
  if (on) {
    releaseWakeLock(); // écran libre de se mettre en veille : conso minimale
  } else {
    if (nav.active) requestWakeLock(); // ne pas ré-armer le verrou en quittant la nav
    setTimeout(() => map.invalidateSize(), 60);
  }
}

function stopNavigation() {
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
  releaseWakeLock();
  setSurvivor(false);
  document.getElementById("nav-daylight")?.classList.add("hidden");
  document.getElementById("surv-daylight")?.classList.add("hidden");
  document.body.classList.remove("nav-active");
  document.getElementById("nav-hud").classList.add("hidden");
}

export function initNav() {
  document.getElementById("nav-stop").addEventListener("click", stopNavigation);
  document.getElementById("surv-stop").addEventListener("click", stopNavigation);
  document.getElementById("nav-mode").addEventListener("click", () => setSurvivor(true));
  document.getElementById("surv-advanced").addEventListener("click", () => setSurvivor(false));
  document.addEventListener("visibilitychange", onVisibility);
}
