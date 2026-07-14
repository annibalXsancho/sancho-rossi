// Sancho Rossi — météo Open-Meteo : 7 jours + heure par heure + météo sur la route
import { trackOf } from "./state.js";
import { putPackMeta, getPackMeta } from "./storage.js";

const weatherCache = new Map();

const WMO = [
  [[0], "☀️", "Ciel clair"],
  [[1, 2], "🌤", "Peu nuageux"],
  [[3], "☁️", "Couvert"],
  [[45, 48], "🌫", "Brouillard"],
  [[51, 53, 55, 56, 57], "🌦", "Bruine"],
  [[61, 63, 65, 66, 67], "🌧", "Pluie"],
  [[71, 73, 75, 77, 85, 86], "🌨", "Neige"],
  [[80, 81, 82], "🌧", "Averses"],
  [[95, 96, 99], "⛈", "Orage"],
];

function wmoInfo(code) {
  const found = WMO.find(([codes]) => codes.includes(code));
  return found ? { icon: found[1], label: found[2] } : { icon: "❓", label: "—" };
}

async function fetchWeather(trail) {
  if (weatherCache.has(trail.id)) return weatherCache.get(trail.id);
  const [lat, lon] = trail.center;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max` +
    `&hourly=temperature_2m,precipitation,cloud_cover,wind_speed_10m,weather_code` +
    `&timezone=auto&forecast_days=7`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const data = await res.json();
  weatherCache.set(trail.id, data);
  return data;
}

function renderHourly(el, data, dayIndex) {
  const rows = [];
  for (let h = 5; h <= 21; h++) {
    const i = dayIndex * 24 + h;
    const { icon } = wmoInfo(data.hourly.weather_code[i]);
    rows.push(`
      <div class="hour-row">
        <span class="hour-h">${String(h).padStart(2, "0")} h</span>
        <span class="hour-icon">${icon}</span>
        <span class="hour-t">${Math.round(data.hourly.temperature_2m[i])}°</span>
        <span class="hour-rain ${data.hourly.precipitation[i] >= 1 ? "warn" : ""}">💧 ${data.hourly.precipitation[i].toFixed(1)}</span>
        <span class="hour-cloud">☁️ ${data.hourly.cloud_cover[i]} %</span>
        <span class="hour-wind">💨 ${Math.round(data.hourly.wind_speed_10m[i])}</span>
      </div>`);
  }
  el.innerHTML = rows.join("");
}

function renderWeatherInto(el, data) {
  const daily = data.daily;
  const days = daily.time.map((iso, i) => {
    const d = new Date(iso);
    const { icon, label } = wmoInfo(daily.weather_code[i]);
    const rain = daily.precipitation_sum[i];
    return `
      <button class="weather-day ${rain >= 5 ? "weather-alert" : ""} ${i === 0 ? "active" : ""}" data-day="${i}">
        <div class="weather-date">${d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" })}</div>
        <div class="weather-icon" title="${label}">${icon}</div>
        <div class="weather-temp">${Math.round(daily.temperature_2m_max[i])}° <span>/ ${Math.round(daily.temperature_2m_min[i])}°</span></div>
        <div class="weather-rain">💧 ${rain.toFixed(1)} mm</div>
      </button>`;
  });
  el.innerHTML = `
    <div class="weather-row">${days.join("")}</div>
    <h3 class="section-title">Heure par heure — <span id="hourly-day-label">aujourd'hui</span></h3>
    <div id="hourly-rows"></div>
    <p class="muted">Prévisions Open-Meteo pour le point de départ (${el.dataset.spot}).
    Choisissez le jour prévu de votre trek. Indicatif au-delà de 48 h en montagne.</p>`;

  const hourlyEl = el.querySelector("#hourly-rows");
  renderHourly(hourlyEl, data, 0);
  el.querySelectorAll(".weather-day").forEach((btn) => {
    btn.addEventListener("click", () => {
      el.querySelectorAll(".weather-day").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const i = Number(btn.dataset.day);
      el.querySelector("#hourly-day-label").textContent = new Date(daily.time[i])
        .toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
      renderHourly(hourlyEl, data, i);
    });
  });
}

// ---------- Météo sur la route (trajet en voiture vers le départ) ----------
async function geocodeCity(name) {
  const res = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=fr`
  );
  if (!res.ok) throw new Error("géocodage indisponible");
  const r = (await res.json()).results?.[0];
  if (!r) throw new Error(`ville « ${name} » introuvable`);
  return { lat: r.latitude, lon: r.longitude, label: `${r.name}${r.admin1 ? ` (${r.admin1})` : ""}` };
}

async function routeWeather(trail, origin, departISO) {
  const dest = trackOf(trail)[0];
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${origin.lon},${origin.lat};${dest[1]},${dest[0]}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("calcul d'itinéraire indisponible");
  const route = (await res.json()).routes?.[0];
  if (!route) throw new Error("aucun itinéraire routier trouvé");

  const coords = route.geometry.coordinates; // [lon, lat]
  const N = 6;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const [lon, lat] = coords[Math.round((i * (coords.length - 1)) / (N - 1))];
    pts.push({ lat, lon, frac: i / (N - 1) });
  }

  const depart = new Date(departISO);
  const wres = await fetch(
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${pts.map((p) => p.lat.toFixed(3)).join(",")}` +
    `&longitude=${pts.map((p) => p.lon.toFixed(3)).join(",")}` +
    `&hourly=temperature_2m,precipitation,weather_code&timezone=auto&forecast_days=7`
  );
  if (!wres.ok) throw new Error("météo indisponible");
  let wdata = await wres.json();
  if (!Array.isArray(wdata)) wdata = [wdata];

  const steps = pts.map((p, i) => {
    const eta = new Date(depart.getTime() + p.frac * route.duration * 1000);
    const hourly = wdata[i].hourly;
    const idx = Math.max(0, Math.min(
      hourly.time.length - 1,
      Math.round((eta - new Date(hourly.time[0])) / 3600000)
    ));
    return {
      km: Math.round((p.frac * route.distance) / 1000),
      eta,
      temp: Math.round(hourly.temperature_2m[idx]),
      rain: hourly.precipitation[idx],
      ...wmoInfo(hourly.weather_code[idx]),
    };
  });
  return { steps, distKm: Math.round(route.distance / 1000), durMin: Math.round(route.duration / 60) };
}

function routeWeatherHTML(trail) {
  const tomorrow = new Date(Date.now() + 86400000);
  const defaultDate = `${tomorrow.toISOString().slice(0, 10)}T07:00`;
  return `
    <h3 class="section-title">Météo sur la route pour y aller</h3>
    <div class="route-form">
      <input id="route-origin" type="text" placeholder="Ville de départ (ex. Milan, Lyon…)" />
      <button class="btn" id="route-mypos" title="Partir de ma position">📍</button>
      <input id="route-depart" type="datetime-local" value="${defaultDate}" />
      <button class="btn btn-primary" id="route-go">Calculer</button>
    </div>
    <div id="route-result"></div>`;
}

function bindRouteWeather(trail, container) {
  const resultEl = container.querySelector("#route-result");
  let myPos = null;

  container.querySelector("#route-mypos").addEventListener("click", (e) => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        myPos = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: "Ma position" };
        container.querySelector("#route-origin").value = "📍 Ma position";
        e.target.classList.add("faved");
      },
      (err) => (resultEl.innerHTML = `<p class="muted">Position indisponible : ${err.message}</p>`)
    );
  });

  container.querySelector("#route-origin").addEventListener("input", () => {
    myPos = null;
    container.querySelector("#route-mypos").classList.remove("faved");
  });

  container.querySelector("#route-go").addEventListener("click", async (e) => {
    const btn = e.target;
    const originText = container.querySelector("#route-origin").value.trim();
    const departISO = container.querySelector("#route-depart").value;
    if (!myPos && !originText) {
      resultEl.innerHTML = `<p class="muted">Indiquez une ville de départ ou utilisez 📍.</p>`;
      return;
    }
    if (new Date(departISO) - Date.now() > 6.5 * 86400000) {
      resultEl.innerHTML = `<p class="muted">Prévisions limitées à 7 jours — choisissez un départ plus proche.</p>`;
      return;
    }
    btn.disabled = true;
    btn.textContent = "⏳";
    try {
      const origin = myPos || (await geocodeCity(originText));
      const { steps, distKm, durMin } = await routeWeather(trail, origin, departISO);
      const rows = steps.map((s, i) => `
        <div class="route-step">
          <span class="route-km">${i === 0 ? "Départ" : i === steps.length - 1 ? "Arrivée" : `km ${s.km}`}</span>
          <span class="route-eta">${s.eta.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
          <span class="route-ico" title="${s.label}">${s.icon}</span>
          <span class="route-t">${s.temp}°</span>
          <span class="route-rain ${s.rain >= 0.5 ? "warn" : ""}">💧 ${s.rain.toFixed(1)} mm</span>
        </div>`).join("");
      resultEl.innerHTML = `
        <p class="route-summary">🚗 ${origin.label} → ${trail.location} :
        <strong>${distKm} km · ${Math.floor(durMin / 60)} h ${String(durMin % 60).padStart(2, "0")}</strong></p>
        ${rows}
        <p class="muted">Conditions prévues à l'heure de passage estimée à chaque point du trajet (OSRM + Open-Meteo).</p>`;
    } catch (err) {
      resultEl.innerHTML = `<p class="muted">Impossible : ${err.message}.</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Calculer";
    }
  });
}

// Snapshot météo embarqué dans un pack offline (S5). Stocké dans le store "tiles"
// (métadonnées de pack), clé "wx:<id>". Appelé par js/offline.js à la construction.
export async function saveWeatherSnapshot(trail) {
  const data = await fetchWeather(trail);
  await putPackMeta(`wx:${trail.id}`, { data, at: Date.now() });
  return data;
}

export async function loadWeatherTab(trail, el) {
  try {
    const data = await fetchWeather(trail);
    renderWeatherInto(el, data);
    el.insertAdjacentHTML("beforeend", routeWeatherHTML(trail));
    bindRouteWeather(trail, el);
  } catch (err) {
    // Hors-ligne : retomber sur le snapshot du pack si la rando en a un.
    const snap = await getPackMeta(`wx:${trail.id}`).catch(() => null);
    if (snap?.data) {
      renderWeatherInto(el, snap.data);
      el.insertAdjacentHTML("afterbegin",
        `<p class="wx-snapshot">📦 Snapshot enregistré le ${new Date(snap.at).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · hors-ligne. « Météo sur la route » nécessite une connexion.</p>`);
      return;
    }
    el.innerHTML = `<p class="muted">Prévisions indisponibles (${err.message}). Vérifiez la connexion internet.</p>`;
  }
}
