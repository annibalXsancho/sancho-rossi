// Sancho Rossi — onglet Navigation : session en cours, mes itinéraires, calques.
// Re-rendu complet à chaque affichage de l'onglet (switchTab) : c'est aussi ce qui
// resynchronise les calques si l'utilisateur les a changés depuis le panneau carte.
import { state, gainOf } from "./state.js";
import { startNavigation, stopNavigation, setSurvivor, navSession } from "./nav.js";
import { switchTab } from "./ui.js";
import { layersConfig, applyLayer, LAYER_META } from "./map.js";
import { renderDetail } from "./detail.js";
import { hasPack } from "./offline.js";
import { openItinMenu } from "./itinmenu.js";

const LONG_PRESS_MS = 500;    // durée d'appui avant le menu contextuel
const LONG_PRESS_MOVE = 10;   // tolérance de glissement (px) — au-delà, c'est un scroll

let elapsedTimer = null;

function fmtElapsed(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
}

// ---------- Session en cours ----------
function renderSession() {
  const host = document.getElementById("nav-session");
  clearInterval(elapsedTimer);
  elapsedTimer = null;

  const s = navSession();
  if (!s) { host.innerHTML = ""; return; }

  const km = (v) => (v == null ? "—" : v.toFixed(1));
  host.innerHTML = `
    <div class="nav-session">
      <div class="info-block-head">
        <span class="eyebrow">Session en cours</span>
        <span class="nav-session-elapsed" id="nav-session-elapsed"></span>
      </div>
      <div class="nav-session-name">${s.name}</div>
      <div class="nav-session-stats">
        <div><span>${km(s.lastM?.done)}</span><label>km parcourus</label></div>
        <div><span>${km(s.lastM?.remaining)}</span><label>km restants</label></div>
        <div><span>${km(s.total)}</span><label>km au total</label></div>
      </div>
      <div class="nav-session-actions">
        <button class="btn btn-primary" id="navview-map">Voir la carte</button>
        <button class="btn" id="navview-survivor">Mode survie</button>
        <button class="btn btn-ghost btn-danger" id="navview-stop">Terminer</button>
      </div>
    </div>`;

  const tick = () => {
    const cur = navSession();
    if (!cur || state.view !== "itineraires") { clearInterval(elapsedTimer); elapsedTimer = null; return; }
    const el = document.getElementById("nav-session-elapsed");
    if (el) el.textContent = fmtElapsed(Date.now() - cur.startedAt);
  };
  tick();
  elapsedTimer = setInterval(tick, 30000);

  document.getElementById("navview-map").addEventListener("click", () => switchTab("carte"));
  document.getElementById("navview-survivor").addEventListener("click", () => {
    switchTab("carte");
    setSurvivor(true);
  });
  document.getElementById("navview-stop").addEventListener("click", () => {
    if (!confirm("Terminer la navigation en cours ?")) return;
    stopNavigation();
    renderNavView();
  });
}

// ---------- Mes itinéraires (créés au planificateur ou importés en GPX) ----------
function renderTrails() {
  const host = document.getElementById("navview-trails");
  const trails = state.imported;

  if (!trails.length) {
    host.innerHTML = `
      <p class="muted">Aucun itinéraire enregistré pour l'instant. Créez le vôtre avec le
      planificateur, ou importez une trace GPX (bouton ⤒ GPX en haut de l'écran).</p>
      <button class="btn" id="navview-plan">Ouvrir le planificateur</button>`;
    document.getElementById("navview-plan").addEventListener("click", () => {
      switchTab("carte");
      document.getElementById("btn-planner")?.click();
    });
    return;
  }

  host.innerHTML = `<p class="navview-hint muted">Appui long sur un itinéraire pour le renommer, modifier ou supprimer.</p>` + trails.map((t) => {
    const g = gainOf(t);
    const stats = [
      `${t.distance} km`,
      g != null ? `${Math.round(g)} m D+` : null,
      t.duration && t.duration !== "—" ? t.duration : null,
      hasPack(t.id) ? "✓ hors-ligne" : null,
    ].filter(Boolean).join(" · ");
    return `
      <div class="navview-row" data-id="${t.id}">
        <div class="navview-info">
          <strong>${t.name}</strong>
          <span class="muted">${stats}</span>
        </div>
        <button class="btn navview-go" data-go="${t.id}">▶ Suivre</button>
      </div>`;
  }).join("");

  host.querySelectorAll(".navview-go").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      startNavigation(b.dataset.go);
    })
  );
  host.querySelectorAll(".navview-row").forEach((row) =>
    bindRowGestures(row, trails.find((t) => t.id === row.dataset.id))
  );
}

// Tap = ouvrir la fiche ; appui long (ou clic droit) = menu Renommer / Modifier / Supprimer.
// L'appui long s'arme sur pointerdown et s'annule si le doigt glisse (l'utilisateur scrolle)
// ou relâche trop tôt ; il neutralise alors le clic de navigation qui suivrait.
function bindRowGestures(row, trail) {
  if (!trail) return;
  let timer = null, fired = false, sx = 0, sy = 0;

  const cancel = () => { clearTimeout(timer); timer = null; };
  const open = () => {
    fired = true;
    cancel();
    if (navigator.vibrate) navigator.vibrate(12);
    openItinMenu(trail);
  };

  row.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".navview-go")) return; // le bouton « Suivre » garde son geste
    fired = false;
    sx = e.clientX; sy = e.clientY;
    cancel();
    timer = setTimeout(open, LONG_PRESS_MS);
  });
  row.addEventListener("pointermove", (e) => {
    if (timer && (Math.abs(e.clientX - sx) > LONG_PRESS_MOVE || Math.abs(e.clientY - sy) > LONG_PRESS_MOVE)) cancel();
  });
  row.addEventListener("pointerup", cancel);
  row.addEventListener("pointercancel", cancel);
  row.addEventListener("pointerleave", cancel);

  row.addEventListener("contextmenu", (e) => { e.preventDefault(); open(); });
  row.addEventListener("click", (e) => {
    if (fired) { fired = false; return; }        // l'appui long a déjà agi
    if (e.target.closest(".navview-go")) return; // « Suivre » gère son propre clic
    renderDetail(trail.id);
  });
}

// ---------- Calques ----------
// Rangées générées depuis layersConfig ; libellés et bornes d'opacité repris du panneau
// carte (source unique dans index.html). applyLayer resynchronise les deux interfaces.
function renderLayers() {
  const host = document.getElementById("navview-layers");
  host.innerHTML = Object.keys(layersConfig).map((name) => {
    const cfg = layersConfig[name];
    const label = LAYER_META[name]?.label || name;
    const min = LAYER_META[name]?.min || 15;
    return `
      <div class="layer-row" data-layer="${name}">
        <label class="switch"><input type="checkbox" ${cfg.on ? "checked" : ""} /><span class="slider-sw"></span></label>
        <span class="layer-name">${label}</span>
        <input type="range" class="layer-op" min="${min}" max="100" value="${cfg.op}" />
        <span class="op-val">${cfg.op}%</span>
      </div>`;
  }).join("");

  host.querySelectorAll(".layer-row").forEach((row) => {
    const name = row.dataset.layer;
    row.querySelector("input[type=checkbox]").addEventListener("change", (e) => {
      layersConfig[name].on = e.target.checked;
      applyLayer(name);
    });
    row.querySelector(".layer-op").addEventListener("input", (e) => {
      layersConfig[name].op = Number(e.target.value);
      applyLayer(name);
    });
  });
}

export function renderNavView() {
  renderSession();
  renderTrails();
  renderLayers();
}
