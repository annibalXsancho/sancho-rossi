// Sancho Rossi — « Boucler avant la nuit » (S-NUIT)
//
// Bandeau .info-block (grammaire S-UX-SYSTÈME) posé sous la météo/conditions : croise
// l'arrivée estimée (départ partagé + durée Naismith) avec le coucher du soleil et le
// crépuscule civil du jour, calculés EN LOCAL (astronomy.js, zéro réseau → offline). Le
// but : voir d'un coup si on rentre avant la nuit, et de combien. Sur une fiche bivouac,
// il ajoute lune (phase + illumination) et heures du soleil de la nuit passée dehors.
//
// Tout est calcul astronomique local : ce bandeau s'affiche aussi bien hors-ligne
// qu'en ligne, sans snapshot ni API — c'est justement son intérêt sécurité.
import { computeGain, naismithHours } from "./metrics.js";
import { getSharedDepart, subscribeDepart } from "./hikeweather.js";
import { sunEvents, moonPhase } from "./astronomy.js";

const fmtHM = (d) => d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const dayLabelOf = (d) => d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });

// Écart en langage naturel (« 1 h 52 », « 25 min »).
function fmtGap(ms) {
  const min = Math.round(Math.abs(ms) / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
}

function durationH(eles, totalKm) {
  if (eles && eles.length > 1) return naismithHours(totalKm || 0, computeGain(eles));
  return totalKm ? totalKm / 4.5 : 3;
}

// Position de référence du tracé (centre curé, sinon milieu de la géométrie).
function trailLatLon(trail, track) {
  if (Array.isArray(trail.center) && trail.center.length === 2) return trail.center;
  const mid = track[Math.floor(track.length / 2)];
  return [mid[0], mid[1]];
}

/**
 * Construit le contenu du bandeau (pur, testable) : lignes + verdict d'arrivée.
 * @returns {{ dayLabel, sun, arrival, verdict, moon }} ; `verdict` porte { text, sev }.
 */
export function assessNight(trail, { eles = null, track = null, totalKm = null } = {}, depart = getSharedDepart()) {
  const [lat, lon] = trailLatLon(trail, track);
  // Jour calendaire local du départ, évalué à midi pour éviter les bascules de date.
  const noon = new Date(depart.getFullYear(), depart.getMonth(), depart.getDate(), 12);
  const sun = sunEvents(lat, lon, noon);
  const durH = durationH(eles, totalKm);
  const arrival = new Date(depart.getTime() + durH * 3600000);

  let verdict = null;
  if (sun.polar === "up") {
    verdict = { text: "Nuit polaire — le soleil ne se lève pas ce jour", sev: "alert" };
  } else if (sun.polar === "down") {
    verdict = { text: "Jour polaire — soleil au-dessus de l'horizon en continu", sev: "info" };
  } else if (sun.sunset) {
    const toSunset = sun.sunset - arrival; // >0 : arrivée avant le coucher
    if (arrival > (sun.dusk || sun.sunset)) {
      verdict = { text: `Arrivée estimée ${fmtHM(arrival)} — ${fmtGap(arrival - (sun.dusk || sun.sunset))} après la tombée de la nuit`, sev: "alert" };
    } else if (arrival > sun.sunset) {
      verdict = { text: `Arrivée estimée ${fmtHM(arrival)} — après le coucher, avant la nuit noire (${fmtHM(sun.dusk)})`, sev: "warn" };
    } else if (toSunset <= 3600000) {
      verdict = { text: `Arrivée estimée ${fmtHM(arrival)} — ${fmtGap(toSunset)} avant le coucher, marge serrée`, sev: "warn" };
    } else {
      verdict = { text: `Arrivée estimée ${fmtHM(arrival)} — ${fmtGap(toSunset)} de marge avant le coucher`, sev: "info" };
    }
  }

  // Bivouac : la nuit se passe dehors → lune (lumière disponible) + lever du lendemain.
  let moon = null;
  if (trail.bivouac) {
    const m = moonPhase(depart);
    const tomorrow = new Date(noon.getTime() + 86400000);
    const nextSunrise = sunEvents(lat, lon, tomorrow).sunrise;
    moon = { ...m, nextSunrise };
  }

  return { dayLabel: dayLabelOf(depart), sun, arrival, verdict, moon };
}

/**
 * Bandeau « Avant la nuit » sous la météo à l'heure de passage.
 * @returns {{ destroy() }}
 */
export function createDaylight(container, trail, { eles = null, track = null, totalKm = null } = {}) {
  if (!container || !track || track.length < 2) return { destroy() {} };
  let destroyed = false;
  let unsub = null;

  function paint() {
    if (destroyed) return;
    const r = assessNight(trail, { eles, track, totalKm });
    const lines = [];

    if (r.sun.polar) {
      lines.push(`<div class="night-line">${r.sun.polar === "up" ? "🌑" : "☀️"} ${r.verdict.text}</div>`);
    } else if (r.sun.sunset) {
      lines.push(
        `<div class="night-line"><span class="night-ico">🌇</span>` +
        `Coucher ${fmtHM(r.sun.sunset)}${r.sun.dusk ? ` · nuit noire ${fmtHM(r.sun.dusk)}` : ""}` +
        `${r.sun.sunrise ? ` · lever ${fmtHM(r.sun.sunrise)}` : ""}</div>`
      );
      lines.push(`<div class="night-verdict night-${r.verdict.sev}">${r.verdict.text}</div>`);
    }

    if (r.moon) {
      lines.push(
        `<div class="night-line"><span class="night-ico">${r.moon.icon}</span>` +
        `${r.moon.name} · ${Math.round(r.moon.illum * 100)} % éclairée` +
        `${r.moon.nextSunrise ? ` · lever du soleil ${fmtHM(r.moon.nextSunrise)}` : ""}</div>`
      );
    }

    container.innerHTML = `
      <div class="info-block night">
        <div class="info-block-head">
          <span class="eyebrow">Avant la nuit</span>
          <span class="eyebrow night-day">${r.dayLabel}</span>
        </div>
        <div class="night-rows">${lines.join("")}</div>
        <p class="info-block-foot muted">Calcul local — disponible hors-ligne</p>
      </div>`;
  }

  // Recalcul quand l'heure de départ partagée (S-METEO) change.
  unsub = subscribeDepart(() => paint());
  paint();

  return {
    destroy() {
      destroyed = true;
      unsub?.();
      container.innerHTML = "";
    },
  };
}
