// Sancho Rossi — navigation : suivi du tracé en temps réel (HUD + mode Survivor)
import { getTrail, trackOf, sampleTrack, haversineKm } from "./state.js";
import { map } from "./map.js";
import { selectTrail } from "./trails.js";
import { switchTab } from "./ui.js";
import { savePos } from "./security.js";

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
};

async function requestWakeLock() {
  try {
    nav.wakeLock = await navigator.wakeLock?.request("screen");
  } catch { /* refusé ou non supporté : sans gravité */ }
}

function releaseWakeLock() {
  nav.wakeLock?.release().catch(() => {});
  nav.wakeLock = null;
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

export function startNavigation(id) {
  if (!navigator.geolocation) { alert("Géolocalisation non supportée sur cet appareil."); return; }
  stopNavigation();
  const t = getTrail(id);
  nav.trail = t;
  nav.active = true;

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

  nav.watchId = navigator.geolocation.watchPosition(onNavFix, (err) => {
    document.getElementById("nav-offtrack").classList.remove("hidden");
    document.getElementById("nav-offdist").textContent = `GPS : ${err.message}`;
  }, { enableHighAccuracy: true, maximumAge: 5000 });
  requestWakeLock();
}

function onNavFix(pos) {
  savePos(pos); // alimente la dernière position connue (volet Sécurité)
  const throttle = nav.survivor ? 20000 : 2500; // Survivor : écran rafraîchi toutes les 20 s
  const now = Date.now();
  if (now - nav.lastUi < throttle) return;
  nav.lastUi = now;

  const { latitude: lat, longitude: lon, altitude, speed } = pos.coords;
  const m = navMetrics(lat, lon);
  const altText = altitude != null ? `${Math.round(altitude)} m` : "—";

  if (nav.survivor) {
    document.getElementById("surv-remaining").textContent = m.remaining.toFixed(1);
    document.getElementById("surv-alt").textContent = altText;
    document.getElementById("surv-heading").textContent =
      `${COMPASS[Math.round(m.heading / 45) % 8]} ${Math.round(m.heading)}°`;
    document.getElementById("surv-time").textContent =
      new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    document.getElementById("surv-off").classList.toggle("hidden", m.offM <= 120);
    return;
  }

  document.getElementById("nav-remaining").textContent = m.remaining.toFixed(1);
  document.getElementById("nav-done").textContent = m.done.toFixed(1);
  document.getElementById("nav-alt").textContent = altText;
  document.getElementById("nav-speed").textContent =
    speed != null ? (speed * 3.6).toFixed(1) : "—";
  const off = m.offM > 120;
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
    requestWakeLock();
    setTimeout(() => map.invalidateSize(), 60);
  }
}

function stopNavigation() {
  if (nav.watchId !== null) navigator.geolocation.clearWatch(nav.watchId);
  nav.watchId = null;
  nav.active = false;
  nav.marker?.remove();
  nav.marker = null;
  releaseWakeLock();
  setSurvivor(false);
  document.body.classList.remove("nav-active");
  document.getElementById("nav-hud").classList.add("hidden");
}

export function initNav() {
  document.getElementById("nav-stop").addEventListener("click", stopNavigation);
  document.getElementById("surv-stop").addEventListener("click", stopNavigation);
  document.getElementById("nav-mode").addEventListener("click", () => setSurvivor(true));
  document.getElementById("surv-advanced").addEventListener("click", () => setSurvivor(false));
}
