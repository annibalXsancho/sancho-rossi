// Sancho Rossi — onglet Navigation : session en cours, mes itinéraires, calques.
// Re-rendu complet à chaque affichage de l'onglet (switchTab) : c'est aussi ce qui
// resynchronise les calques si l'utilisateur les a changés depuis le panneau carte.
import { state, gainOf } from "./state.js";
import { startNavigation, stopNavigation, setSurvivor, navSession } from "./nav.js";
import { switchTab } from "./ui.js";
import { layersConfig, applyLayer, LAYER_META } from "./map.js";
import { renderDetail } from "./detail.js";
import { hasPack } from "./offline.js";
import { renameImported, deleteImported } from "./trails.js";
import { openPlannerForEdit } from "./planner.js";
import { toast } from "./toast.js";

// Gestes d'ergonomie sur « Mes itinéraires » (façon apps pro) :
//   • glisser vers la gauche  → révèle un bouton rouge poubelle → supprimer
//   • maintenir (appui long)  → deux bulles à droite : ✎ renommer, ⤳ modifier le tracé
//   • tap simple              → ouvre la fiche
const DEL_W = 76;             // largeur du bouton poubelle révélé par le glissement
const LONG_PRESS_MS = 450;    // durée d'appui avant les bulles d'action
const AXIS_THRESHOLD = 8;     // px avant de trancher entre glissement horizontal et scroll

// Un seul itinéraire « ouvert » à la fois (glissé OU bulles affichées).
let openItem = null;

function closeOpenItem() {
  if (!openItem) return;
  const card = openItem.querySelector(".itin-card");
  if (card) { card.style.transition = ""; card.style.transform = ""; card.classList.remove("quick-open"); }
  openItem._open = false;
  openItem = null;
}

// Fermer l'itinéraire ouvert dès qu'on touche ailleurs (capture : avant les gestes de ligne).
document.addEventListener("pointerdown", (e) => {
  if (openItem && !openItem.contains(e.target)) closeOpenItem();
}, true);

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

// ---------- Icônes (traits, remplis via currentColor) ----------
const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><line x1="10" y1="11" x2="10" y2="16.5"/><line x1="14" y1="11" x2="14" y2="16.5"/></svg>`;
const ICON_PENCIL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const ICON_ROUTE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18.5 9.5 11l5 3.5L20 6"/><circle cx="4" cy="18.5" r="1.7" fill="currentColor" stroke="none"/><circle cx="20" cy="6" r="1.7" fill="currentColor" stroke="none"/></svg>`;

// ---------- Mes itinéraires (créés au planificateur ou importés en GPX) ----------
function renderTrails() {
  const host = document.getElementById("navview-trails");
  const trails = state.imported;
  openItem = null; // le DOM va être remplacé : aucun élément « ouvert » ne survit

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

  host.innerHTML = `<p class="navview-hint muted">Glissez un itinéraire vers la gauche pour le supprimer, ou maintenez-le pour le renommer ou modifier le tracé.</p>` + trails.map((t) => {
    const g = gainOf(t);
    const stats = [
      `${t.distance} km`,
      g != null ? `${Math.round(g)} m D+` : null,
      t.duration && t.duration !== "—" ? t.duration : null,
      hasPack(t.id) ? "✓ hors-ligne" : null,
    ].filter(Boolean).join(" · ");
    return `
      <div class="itin-item" data-id="${t.id}">
        <div class="itin-swipe-bg">
          <button class="itin-del" data-del="${t.id}" aria-label="Supprimer l'itinéraire" title="Supprimer">${ICON_TRASH}</button>
        </div>
        <div class="itin-card">
          <div class="navview-info">
            <strong>${t.name}</strong>
            <span class="muted">${stats}</span>
          </div>
          <div class="itin-right">
            <button class="btn navview-go" data-go="${t.id}">▶ Suivre</button>
            <div class="itin-quick" aria-hidden="true">
              <button class="itin-bubble" data-act="rename" aria-label="Renommer" title="Renommer">${ICON_PENCIL}</button>
              <button class="itin-bubble" data-act="edit" aria-label="Modifier le tracé" title="Modifier le tracé">${ICON_ROUTE}</button>
            </div>
          </div>
        </div>
      </div>`;
  }).join("");

  host.querySelectorAll(".navview-go").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      startNavigation(b.dataset.go);
    })
  );
  host.querySelectorAll(".itin-item").forEach((item) =>
    bindItemGestures(item, trails.find((t) => t.id === item.dataset.id))
  );
}

// Trois gestes sur une même ligne, sans se marcher dessus :
//   tap → fiche ; appui long → bulles renommer/modifier ; glissé gauche → poubelle.
// On tranche l'axe (horizontal = glissement, vertical = scroll) au premier mouvement franc.
function bindItemGestures(item, trail) {
  if (!trail) return;
  const card = item.querySelector(".itin-card");
  let startX = 0, startY = 0, axis = null, longFired = false, moved = false, baseX = 0, curX = 0;
  let timer = null;

  const clearTimer = () => { clearTimeout(timer); timer = null; };
  const setX = (x) => { curX = x; card.style.transform = x ? `translateX(${x}px)` : ""; };

  const openQuick = () => {
    longFired = true;
    clearTimer();
    if (openItem && openItem !== item) closeOpenItem();
    if (navigator.vibrate) navigator.vibrate(12);
    card.classList.add("quick-open");
    openItem = item; item._open = true;
  };

  card.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".navview-go") || e.target.closest(".itin-quick") || e.target.isContentEditable) return;
    startX = e.clientX; startY = e.clientY;
    axis = null; moved = false; longFired = false;
    // Reprend depuis l'état glissé si la ligne est déjà ouverte en mode poubelle.
    baseX = (item._open && !card.classList.contains("quick-open")) ? -DEL_W : 0;
    clearTimer();
    timer = setTimeout(openQuick, LONG_PRESS_MS);
    card.setPointerCapture?.(e.pointerId);
  });

  card.addEventListener("pointermove", (e) => {
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (axis === null) {
      if (Math.abs(dx) < AXIS_THRESHOLD && Math.abs(dy) < AXIS_THRESHOLD) return;
      axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      clearTimer(); // dès qu'on bouge, plus d'appui long
      if (axis === "x") {
        card.classList.remove("quick-open");
        if (openItem && openItem !== item) closeOpenItem();
        card.style.transition = "none";
      } else return; // scroll vertical : on laisse la page défiler
    }
    if (axis !== "x") return;
    moved = true;
    e.preventDefault();
    setX(Math.max(-DEL_W, Math.min(0, baseX + dx))); // glissement borné, uniquement vers la gauche
  });

  const finish = (e) => {
    clearTimer();
    card.releasePointerCapture?.(e.pointerId);
    if (axis === "x") {
      card.style.transition = "";
      const open = curX < -DEL_W / 2;
      setX(open ? -DEL_W : 0);
      item._open = open;
      if (open) { if (openItem && openItem !== item) closeOpenItem(); openItem = item; }
      else if (openItem === item) openItem = null;
    }
    axis = null;
  };
  card.addEventListener("pointerup", finish);
  card.addEventListener("pointercancel", finish);

  // Clic droit (desktop) : équivalent de l'appui long, sans menu natif.
  card.addEventListener("contextmenu", (e) => { e.preventDefault(); openQuick(); });

  card.addEventListener("click", (e) => {
    if (e.target.closest(".navview-go") || e.target.closest(".itin-quick") || e.target.isContentEditable) return;
    if (longFired) { longFired = false; return; } // l'appui long a déjà agi
    if (moved) { moved = false; return; }         // c'était un glissement
    if (item._open) { closeOpenItem(); return; }  // referme la ligne ouverte
    renderDetail(trail.id);
  });

  // Bulles d'action (appui long)
  item.querySelector('[data-act="rename"]').addEventListener("click", (e) => {
    e.stopPropagation();
    startInlineRename(item, trail);
  });
  item.querySelector('[data-act="edit"]').addEventListener("click", (e) => {
    e.stopPropagation();
    closeOpenItem();
    openPlannerForEdit(trail);
  });

  // Poubelle révélée par le glissement. On agit sur `pointerup` (et non `click`) :
  // après un glissement, le navigateur annule souvent le premier `click` synthétisé —
  // c'est ce qui obligeait à taper deux fois. `pointerup` se déclenche dès le premier
  // relâchement ; un garde empêche la double-suppression (pointerup + click éventuel).
  const delBtn = item.querySelector("[data-del]");
  let deleting = false;
  const doDelete = (e) => {
    e.stopPropagation();
    if (deleting) return;
    deleting = true;
    card.style.transition = "transform 180ms ease-out";
    setX(-item.offsetWidth); // la ligne sort par la gauche, puis on supprime
    setTimeout(() => {
      openItem = null;
      deleteImported(trail.id);
      renderNavView();
      toast("Itinéraire supprimé.");
    }, 170);
  };
  delBtn.addEventListener("pointerup", doDelete);
  delBtn.addEventListener("click", doDelete); // repli desktop (souris) ; dédupliqué par le garde
}

// Renommage en place : le titre de la ligne devient éditable (Entrée/clic-ailleurs valide,
// Échap annule). Même geste que la fiche — un seul champ, pas de boîte de dialogue.
function startInlineRename(item, trail) {
  const card = item.querySelector(".itin-card");
  card.classList.remove("quick-open");
  if (openItem === item) openItem = null;

  const strong = card.querySelector(".navview-info strong");
  if (!strong || strong.isContentEditable) return;
  const original = trail.name;
  strong.setAttribute("contenteditable", "plaintext-only");
  strong.classList.add("editing");
  strong.focus();
  const range = document.createRange();
  range.selectNodeContents(strong);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    strong.removeEventListener("keydown", onKey);
    strong.removeEventListener("blur", onBlur);
    strong.removeAttribute("contenteditable");
    strong.classList.remove("editing");
    const next = strong.textContent.trim();
    if (commit && next && next !== original && renameImported(trail.id, next)) {
      toast("Itinéraire renommé.", { type: "success" });
      renderNavView();
    } else {
      strong.textContent = original; // annulation ou nom vide/inchangé
    }
  };
  const onKey = (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  strong.addEventListener("keydown", onKey);
  strong.addEventListener("blur", onBlur);
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
