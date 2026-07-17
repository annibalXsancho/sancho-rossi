// Sancho Rossi — météo à l'heure de passage (S-METEO)
//
// La météo d'une rando n'est pas celle de « maintenant au parking » : au km 12 on
// sera à 11 h 40, peut-être 900 m plus haut, et c'est CETTE heure-là et CETTE
// altitude-là qu'il faut regarder. Le module croise donc trois choses qui existent
// déjà dans l'app : la distance cumulée (metrics.js), la durée Naismith segment par
// segment (même hystérésis de 4 m que computeGain, sinon le bruit d'altitude gonfle
// le temps de montée) et l'appel Open-Meteo `hourly` multi-points (pattern S9).
//
// Le paramètre `elevation` d'Open-Meteo est passé point par point : la température
// est ainsi descendue à l'altitude réelle du tracé, pas à celle de la maille du
// modèle — un fond de vallée et une crête à 5 km d'écart n'ont pas le même thermomètre.
//
// Bandeau : N cellules d'égale largeur sous le profil altimétrique = N tranches de
// distance ; chaque cellule montre l'heure de passage au centre de sa tranche et la
// météo prévue À CETTE HEURE. Le choix d'heure de départ est partagé entre fiche et
// planificateur le temps de la session. Hors-ligne : repli sur le snapshot daté du
// pack (`hw:<id>`, écrit par offline.js), même contrat que la météo S5.
import { state, trackOf, sampleTrack } from "./state.js";
import { cumulativeKm } from "./metrics.js";
import { wmoInfo } from "./weather.js";
import { fetchRetry } from "./net.js";
import { putPackMeta, getPackMeta } from "./storage.js";

const HYST_M = 4;          // hystérésis du D+ — DOIT rester alignée sur metrics.js
const MAX_FORECAST_D = 16; // horizon Open-Meteo
const SNAPSHOT_DAYS = 7;   // horizon embarqué dans un pack offline

// Une seule heure de départ pour toute la session : on la règle sur la fiche, on la
// retrouve dans le planificateur (et inversement) sans la re-saisir.
let departShared = null;

// Cache de session par (points arrondis, horizon) : rouvrir une fiche ou changer
// l'heure de départ dans la même fenêtre de prévision ne refait pas d'appel réseau.
const fetchCache = new Map();

const fmtHM = (d) => d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

// Valeur par défaut du sélecteur : demain 8 h (heure locale, format datetime-local).
function defaultDepart() {
  const d = new Date(Date.now() + 86400000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T08:00`;
}

// ---------- Timeline de marche ----------
// Distance cumulée (recalée sur la distance annoncée, comme profile.js : le cumul d'un
// échantillon coupe les virages) + heures Naismith cumulées : dist/4,5 toujours, la
// montée seulement quand elle dépasse l'hystérésis — cohérent avec computeGain, donc
// le total colle à la durée affichée sur la fiche.
function buildTimeline(track, eles, totalKm) {
  let pts = eles && track.length === eles.length ? track
    : eles ? sampleTrack(track, eles.length) : track;
  if (eles && pts.length !== eles.length) { pts = track; eles = null; }

  const cum = cumulativeKm(pts);
  const raw = cum[cum.length - 1] || 1;
  const scale = totalKm > 0 ? totalKm / raw : 1;
  const kms = cum.map((c) => c * scale);

  const hours = [0];
  let ref = eles ? eles[0] : 0;
  for (let i = 1; i < pts.length; i++) {
    let dh = (kms[i] - kms[i - 1]) / 4.5;
    if (eles) {
      if (eles[i] - ref > HYST_M) { dh += (eles[i] - ref) / 600; ref = eles[i]; }
      else if (ref - eles[i] > HYST_M) ref = eles[i];
    }
    hours.push(hours[i - 1] + dh);
  }

  // Version décimée [[km, h]…] : sert à l'interpolation du survol et part telle
  // quelle dans le snapshot offline (pas besoin des eles pour rejouer les heures).
  const pairs = [];
  const step = Math.max(1, Math.floor(kms.length / 48));
  for (let i = 0; i < kms.length; i += step) pairs.push([kms[i], hours[i]]);
  if (pairs[pairs.length - 1][0] !== kms[kms.length - 1]) {
    pairs.push([kms[kms.length - 1], hours[hours.length - 1]]);
  }

  return {
    pts, kms, hours, eles, pairs,
    totalKm: kms[kms.length - 1] || 1,
    totalH: hours[hours.length - 1] || 0,
  };
}

// N points d'échantillonnage au CENTRE de N tranches d'égale distance — chaque
// cellule du bandeau parle de « ce tronçon-là », pas d'un point de bord.
function buildSamples(tl, cells) {
  const out = [];
  for (let c = 0; c < cells; c++) {
    const km = (tl.totalKm * (c + 0.5)) / cells;
    let i = 0;
    while (i < tl.kms.length - 1 && tl.kms[i + 1] <= km) i++;
    out.push({
      km,
      h: tl.hours[i],
      lat: tl.pts[i][0],
      lon: tl.pts[i][1],
      ele: tl.eles ? Math.round(tl.eles[i]) : null,
    });
  }
  return out;
}

// Heure de marche au km donné, par interpolation sur la timeline décimée.
function hourAtKm(pairs, km) {
  if (km <= pairs[0][0]) return pairs[0][1];
  for (let i = 1; i < pairs.length; i++) {
    if (km <= pairs[i][0]) {
      const [k0, h0] = pairs[i - 1], [k1, h1] = pairs[i];
      return k1 > k0 ? h0 + ((km - k0) / (k1 - k0)) * (h1 - h0) : h0;
    }
  }
  return pairs[pairs.length - 1][1];
}

// ---------- Open-Meteo ----------
function neededDays(depart, totalH) {
  const end = depart.getTime() + totalH * 3600000;
  const days = Math.ceil((end - new Date().setHours(0, 0, 0, 0)) / 86400000) + 1;
  return Math.max(2, Math.min(MAX_FORECAST_D, days));
}

async function fetchHourly(samples, days) {
  const key = samples.map((s) => `${s.lat.toFixed(3)},${s.lon.toFixed(3)}`).join(";") + `|${days}`;
  if (fetchCache.has(key)) return fetchCache.get(key);
  const hasEle = samples.every((s) => s.ele != null);
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${samples.map((s) => s.lat.toFixed(3)).join(",")}` +
    `&longitude=${samples.map((s) => s.lon.toFixed(3)).join(",")}` +
    (hasEle ? `&elevation=${samples.map((s) => s.ele).join(",")}` : "") +
    `&hourly=temperature_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m` +
    `&timezone=auto&forecast_days=${days}`;
  const p = (async () => {
    const res = await fetchRetry(url, { timeout: 15000 });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    let data = await res.json();
    if (!Array.isArray(data)) data = [data];
    return data;
  })();
  // Promesse en cache pour dédupliquer les appels concurrents ; retirée si elle échoue
  // (sinon une panne réseau passagère condamnerait la clé pour toute la session).
  fetchCache.set(key, p);
  p.catch(() => fetchCache.delete(key));
  return p;
}

// Météo au point i pour une date donnée — null si hors de la fenêtre de prévision.
function weatherAt(wdata, i, eta) {
  const hourly = wdata[i]?.hourly;
  if (!hourly?.time?.length) return null;
  const idx = Math.round((eta - new Date(hourly.time[0])) / 3600000);
  if (idx < 0 || idx >= hourly.time.length) return null;
  return {
    temp: Math.round(hourly.temperature_2m[idx]),
    rain: hourly.precipitation[idx] ?? 0,
    proba: hourly.precipitation_probability?.[idx] ?? null,
    wind: Math.round(hourly.wind_speed_10m[idx] ?? 0),
    ...wmoInfo(hourly.weather_code[idx]),
  };
}

/**
 * Bandeau « météo à l'heure de passage » sous un profil altimétrique.
 * @param {HTMLElement} container
 * @param {object} trail   — sert de clé de snapshot offline (`hw:<id>`)
 * @param {object} opts    { eles, track, totalKm, cells }
 * @returns {{ annotate(km): string, destroy() }}
 */
export function createRouteWeather(container, trail, { eles = null, track = null, totalKm = null, cells = 6 } = {}) {
  if (!container || !track || track.length < 2) return { annotate: () => "", destroy() {} };

  let destroyed = false;
  let st = null; // { samples, wdata, pairs, days, snapshotAt }

  const tl = buildTimeline(track, eles, totalKm);
  const samples = buildSamples(tl, cells);

  if (!departShared) departShared = defaultDepart();
  const minDay = new Date().toISOString().slice(0, 10);

  // Structure `.info-block` (grammaire partagée S-UX-SYSTÈME) : en-tête eyebrow +
  // contrôle, corps, pied. Les bandeaux suivants (conditions, nuit, montées) copient
  // ce moule ; seules les classes `rwx-*` portent les spécificités météo.
  container.innerHTML = `
    <div class="info-block rwx">
      <div class="info-block-head">
        <span class="eyebrow">Météo à l'heure de passage</span>
        <span class="rwx-depart-wrap">
          <label class="eyebrow" for="rwx-depart-${trail.id}">départ</label>
          <input type="datetime-local" class="rwx-depart" id="rwx-depart-${trail.id}"
            min="${minDay}T00:00" value="${departShared}" />
        </span>
      </div>
      <div class="rwx-strip"></div>
      <p class="info-block-foot rwx-foot muted hidden"></p>
    </div>`;

  const stripEl = container.querySelector(".rwx-strip");
  const footEl = container.querySelector(".rwx-foot");
  const departEl = container.querySelector(".rwx-depart");

  const departDate = () => {
    const d = new Date(departEl.value || departShared);
    return isNaN(d) ? new Date(defaultDepart()) : d;
  };

  function paint() {
    if (!st) return;
    const depart = departDate();
    let anyOut = false;
    stripEl.innerHTML = st.samples
      .map((s, i) => {
        const eta = new Date(depart.getTime() + s.h * 3600000);
        const dayShift = Math.round((new Date(eta).setHours(0, 0, 0, 0) - new Date(depart).setHours(0, 0, 0, 0)) / 86400000);
        const w = weatherAt(st.wdata, i, eta);
        if (!w) { anyOut = true; return `<div class="rwx-cell rwx-out" title="Au-delà de la fenêtre de prévision"><span class="rwx-time">${String(eta.getHours()).padStart(2, "0")} h</span><span class="rwx-ico">—</span></div>`; }
        const rainTxt = (w.rain >= 0.1 || (w.proba ?? 0) >= 25)
          ? `💧 ${w.proba != null ? `${w.proba} %` : `${w.rain.toFixed(1)}`}` : "";
        return `<div class="rwx-cell" title="km ${s.km.toFixed(1)}${s.ele != null ? ` · ${s.ele} m` : ""} · ${fmtHM(eta)} · ${w.label} · ${w.temp}° · 💧 ${w.rain.toFixed(1)} mm${w.proba != null ? ` (${w.proba} %)` : ""} · 💨 ${w.wind} km/h">
          <span class="rwx-time">${String(eta.getHours()).padStart(2, "0")} h${dayShift > 0 ? `<em>+${dayShift}</em>` : ""}</span>
          <span class="rwx-ico">${w.icon}</span>
          <span class="rwx-temp">${w.temp}°</span>
          <span class="rwx-rain${w.rain >= 0.5 || (w.proba ?? 0) >= 60 ? " warn" : ""}">${rainTxt}</span>
        </div>`;
      })
      .join("");

    const arrive = new Date(depart.getTime() + tl.totalH * 3600000);
    const bits = [`arrivée estimée ${fmtHM(arrive)}`];
    if (st.snapshotAt) bits.unshift(`📦 prévisions du ${new Date(st.snapshotAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} (hors-ligne)`);
    if (anyOut) bits.push("au-delà de la fenêtre de prévision pour une partie du parcours");
    footEl.textContent = bits.join(" · ");
    footEl.classList.remove("hidden");
  }

  async function load() {
    const days = neededDays(departDate(), tl.totalH);
    try {
      const wdata = await fetchHourly(samples, days);
      if (destroyed) return;
      st = { samples, wdata, pairs: tl.pairs, days, snapshotAt: null };
    } catch {
      // Hors-ligne (ou API en panne) : snapshot du pack s'il existe, sinon rien —
      // l'absence de donnée se montre en ne montrant rien, pas en inventant.
      const snap = await getPackMeta(`hw:${trail.id}`).catch(() => null);
      if (destroyed) return;
      if (!snap) { container.innerHTML = ""; return; }
      st = { samples: snap.samples, wdata: snap.wdata, pairs: snap.pairs, days: snap.days, snapshotAt: snap.at };
    }
    paint();
  }

  departEl.addEventListener("change", () => {
    departShared = departEl.value || defaultDepart();
    // Fenêtre de prévision à rallonger (départ repoussé) → re-fetch ; sinon on
    // ré-indexe les mêmes données en local, zéro réseau.
    if (!st || (!st.snapshotAt && neededDays(departDate(), tl.totalH) > st.days)) load();
    else paint();
  });

  load();

  return {
    // Complément de la bulle du profil : « · 11 h 40 · 14° · 💧 20 % » au km survolé.
    annotate(km) {
      if (!st || km == null) return "";
      const eta = new Date(departDate().getTime() + hourAtKm(st.pairs, km) * 3600000);
      let best = 0, bd = Infinity;
      st.samples.forEach((s, i) => { const d = Math.abs(s.km - km); if (d < bd) { bd = d; best = i; } });
      const w = weatherAt(st.wdata, best, eta);
      if (!w) return ` · ${fmtHM(eta)}`;
      return ` · ${fmtHM(eta)} · ${w.temp}°` + ((w.proba ?? 0) >= 10 ? ` · 💧 ${w.proba} %` : "");
    },
    destroy() {
      destroyed = true;
      container.innerHTML = "";
    },
  };
}

// Snapshot embarqué dans un pack offline (appelé par offline.js, phase météo).
// On stocke tout ce qu'il faut pour rejouer le bandeau sans réseau ni eles :
// échantillons (position + heure de marche), timeline décimée et données horaires.
export async function saveHikeWeatherSnapshot(trail) {
  const track = trail.mainline || trackOf(trail);
  const eles = trail.eles?.length > 1 ? trail.eles : state.elev[trail.id]?.eles || null;
  const tl = buildTimeline(track, eles, trail.distance);
  const samples = buildSamples(tl, 6);
  const wdata = await fetchHourly(samples, SNAPSHOT_DAYS);
  await putPackMeta(`hw:${trail.id}`, {
    at: Date.now(), days: SNAPSHOT_DAYS, samples, pairs: tl.pairs, wdata,
  });
}
