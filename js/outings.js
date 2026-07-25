// Sancho Rossi — Sorties prévues (S-V2-SORTIES)
// Réserver un itinéraire pour une date : note libre, lien Google Agenda (URL de
// template, sans clé ni API), sectionnement optionnel en étapes. Store IndexedDB
// séparé (pas un champ du tracé, cf. storage.js v5) : cycle de vie propre, et les
// futures alertes météo par sortie (S-V2-VIGIE-B, backlog) pourront lister les
// sorties datées sans charger les tracés (potentiellement lourds).
import { state, getTrail, outingsFor, upcomingOutings } from "./state.js";
import { loadOutings, putOuting, delOuting, delPackMeta } from "./storage.js";
import { cumulativeKm, naismithHours, fmtDuration } from "./metrics.js";
import { touchOutings } from "./sync.js";
import { toast } from "./toast.js";
import { switchTab } from "./ui.js";
import { getVigilance } from "./vigie.js";

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- Chargement / persistance ----------
export async function loadFieldOutings() {
  try {
    state.outings = (await loadOutings()) || [];
  } catch (err) {
    console.warn("Sorties prévues illisibles :", err);
    state.outings = [];
  }
}

export function saveOuting(outing) {
  const now = Date.now();
  const rec = {
    id: outing.id || `outing-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    trailId: outing.trailId,
    date: outing.date,
    time: outing.time || null,
    note: outing.note || "",
    steps: outing.steps && outing.steps.length ? outing.steps : null,
    createdAt: outing.createdAt || now,
    updatedAt: now,
  };
  const i = state.outings.findIndex((o) => o.id === rec.id);
  if (i >= 0) state.outings[i] = rec; else state.outings.unshift(rec);
  putOuting(rec).catch((err) => {
    console.warn("Sortie non enregistrée :", err);
    toast("Sortie non enregistrée — stockage indisponible.", { type: "error" });
  });
  touchOutings();
  renderOutingsBlock();
  return rec;
}

export function deleteOuting(id) {
  state.outings = state.outings.filter((o) => o.id !== id);
  delOuting(id).catch((err) => console.warn("Suppression de la sortie non persistée :", err));
  delPackMeta(`vigie:${id}`).catch(() => {});
  touchOutings();
  renderOutingsBlock();
}

// ---------- Lien Google Agenda ----------
// URL de template — aucune clé, aucune API, ouverte dans un nouvel onglet sur clic
// explicite (jamais d'auto-ouverture, pour ne pas se heurter au bloqueur de popup).
export function buildGCalUrl(outing, trail) {
  const start = new Date(`${outing.date}T${outing.time || "08:00"}:00`);
  if (isNaN(start.getTime())) return null;
  const hours = naismithHours(trail.distance || 0, trail.elevationGain || 0);
  const end = new Date(start.getTime() + Math.max(hours, 1) * 3600000);
  const fmt = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const details = [
    outing.note,
    `${trail.distance} km · ${trail.duration || fmtDuration(hours)}${trail.sac?.level ? " · " + trail.sac.level : ""}`,
  ].filter(Boolean).join("\n");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `Rando — ${trail.name}`,
    dates: `${fmt(start)}/${fmt(end)}`,
    details,
    location: trail.location || "",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ---------- Sectionnement en étapes ----------
// Bornes en km cumulé le long du tracé — décision de LA sortie (pause, bivouac), pas
// une propriété du tracé : deux réservations du même tracé peuvent le découper différemment.
export function stepsWithStats(trail, steps) {
  if (!steps?.length || !trail.track) return [];
  const cum = cumulativeKm(trail.track);
  const eleAtKm = (km) => {
    if (!trail.eles || trail.eles.length !== trail.track.length) return null;
    let i = 0;
    while (i < cum.length - 1 && cum[i] < km) i++;
    return trail.eles[i];
  };
  return steps.map((s) => {
    const distKm = Math.round((s.kmEnd - s.kmStart) * 10) / 10;
    const eStart = eleAtKm(s.kmStart), eEnd = eleAtKm(s.kmEnd);
    const gain = eStart != null && eEnd != null ? Math.max(0, Math.round(eEnd - eStart)) : null;
    return { ...s, distKm, gain };
  });
}

// Section affichée sur la fiche (detail.js) sous le profil, si une sortie planifiée
// avec étapes existe pour ce tracé.
export function outingsSectionHtml(trail) {
  const outing = outingsFor(trail.id).find((o) => o.steps?.length);
  if (!outing) return "";
  const steps = stepsWithStats(trail, outing.steps);
  return `
    <div class="info-block outing-steps">
      <div class="info-block-head"><span class="eyebrow">Étapes de la sortie</span></div>
      <ol class="outing-steps-list">
        ${steps.map((s, i) => `
          <li>
            <span class="outing-step-label">${i + 1}. ${escapeHtml(s.label || "Étape")}</span>
            <span class="outing-step-stats">${s.distKm} km${s.gain != null ? ` · ${s.gain} m D+` : ""}</span>
          </li>`).join("")}
      </ol>
    </div>`;
}

// ---------- Bloc « Sorties prévues » (panneau Explorer) ----------
export function renderOutingsBlock() {
  const block = document.getElementById("outings-block");
  const list = document.getElementById("outings-list");
  if (!block || !list) return;
  const outings = upcomingOutings();
  block.classList.toggle("hidden", outings.length === 0);
  if (!outings.length) { list.innerHTML = ""; return; }

  list.innerHTML = outings.map((o) => {
    const trail = getTrail(o.trailId);
    const d = new Date(`${o.date}T${o.time || "00:00"}:00`);
    const dateLabel = isNaN(d.getTime())
      ? o.date
      : d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" }) + (o.time ? ` · ${o.time}` : "");
    const vigie = getVigilance(o.id);
    return `
      <div class="outing-item" data-id="${o.id}" data-trail="${o.trailId}">
        <div class="outing-item-main">
          <div class="outing-item-date">${dateLabel}</div>
          <div class="outing-item-name">${escapeHtml(trail?.name || "Itinéraire supprimé")}${vigie ? ` <span class="pill pill-difficile outing-alert" title="${escapeHtml(vigie.reason)}">⚠ météo dégradée</span>` : ""}</div>
          ${o.note ? `<div class="outing-item-note">${escapeHtml(o.note.length > 80 ? o.note.slice(0, 80) + "…" : o.note)}</div>` : ""}
        </div>
        <button class="btn-ghost outing-item-del" data-del="${o.id}" title="Annuler la réservation" aria-label="Annuler la réservation">🗑</button>
      </div>`;
  }).join("");
}

function bindOutingsList() {
  const list = document.getElementById("outings-list");
  if (!list) return;
  list.addEventListener("click", (e) => {
    const delBtn = e.target.closest("[data-del]");
    if (delBtn) { deleteOuting(delBtn.dataset.del); return; }
    const item = e.target.closest(".outing-item");
    if (item?.dataset.trail && getTrail(item.dataset.trail)) {
      switchTab("carte");
      import("./trails.js").then(({ selectTrail }) => selectTrail(item.dataset.trail));
    }
  });
}

// ---------- Formulaire de réservation ----------
// Résout la sortie enregistrée, ou null si annulé/supprimé. Patron `.pack-modal`
// (packdialog.js) réutilisé tel quel.
export function openOutingForm(trail, { existing = null } = {}) {
  return new Promise((resolve) => {
    // Reconstruit les points de rupture intermédiaires (le dernier segment va toujours
    // jusqu'à l'arrivée, donc implicite — pas affiché comme une rupture éditable).
    let breaks = existing?.steps?.length ? existing.steps.slice(0, -1).map((s) => ({ label: s.label, km: s.kmEnd })) : [];

    const el = document.createElement("div");
    el.className = "pack-modal";
    el.innerHTML = `
      <div class="pack-sheet" role="dialog" aria-modal="true" aria-label="Réserver une sortie">
        <div class="pack-head">
          <div>
            <div class="eyebrow">Réserver une sortie</div>
            <h3 class="pack-title">${escapeHtml(trail.name)}</h3>
          </div>
          <button class="btn-ghost pack-close" aria-label="Fermer">✕</button>
        </div>

        <div class="pack-section">
          <label class="eyebrow" for="outing-date">Date</label>
          <div class="outing-datetime">
            <input type="date" id="outing-date" />
            <input type="time" id="outing-time" />
          </div>
        </div>

        <div class="pack-section">
          <label class="eyebrow" for="outing-note">Note</label>
          <textarea id="outing-note" class="outing-note-input" rows="3" placeholder="Départ tôt, covoiturage avec…"></textarea>
        </div>

        <div class="pack-section">
          <button class="btn-ghost outing-steps-toggle" id="outing-steps-toggle" type="button">＋ Découper en étapes</button>
          <div class="outing-steps-editor hidden" id="outing-steps-editor">
            <div id="outing-breaks"></div>
            <button class="btn-ghost" id="outing-add-break" type="button">＋ Ajouter une étape</button>
            <p class="pack-hint">Chaque étape est un point de rupture (pause, bivouac) avec le kilomètre où vous l'atteignez. La dernière étape va jusqu'à l'arrivée.</p>
          </div>
        </div>

        <div class="pack-actions">
          ${existing ? `<button class="btn-ghost btn-ghost-danger" id="outing-delete" type="button">Supprimer la réservation</button>` : ""}
          <button class="btn btn-ghost pack-cancel">Annuler</button>
          <button class="btn" id="outing-save">Enregistrer</button>
          <button class="btn btn-primary" id="outing-save-gcal">Enregistrer + Google Agenda</button>
        </div>
      </div>`;

    const dateEl = el.querySelector("#outing-date");
    const timeEl = el.querySelector("#outing-time");
    const noteEl = el.querySelector("#outing-note");
    dateEl.value = existing?.date || "";
    timeEl.value = existing?.time || "";
    noteEl.value = existing?.note || "";

    const breaksEl = el.querySelector("#outing-breaks");
    const editorEl = el.querySelector("#outing-steps-editor");
    const toggleEl = el.querySelector("#outing-steps-toggle");

    function renderBreaks() {
      breaksEl.innerHTML = breaks.map((b, i) => `
        <div class="outing-break-row" data-i="${i}">
          <input type="text" class="outing-break-label" placeholder="Refuge du Lac" value="${escapeHtml(b.label || "")}" />
          <input type="number" class="outing-break-km" min="0.1" max="${Math.max(trail.distance - 0.1, 0.1)}" step="0.1" value="${b.km ?? ""}" /> km
          <button class="btn-ghost outing-break-del" type="button" aria-label="Retirer cette étape">✕</button>
        </div>`).join("");
      breaksEl.querySelectorAll(".outing-break-row").forEach((row) => {
        const i = +row.dataset.i;
        row.querySelector(".outing-break-label").addEventListener("input", (e) => { breaks[i].label = e.target.value; });
        row.querySelector(".outing-break-km").addEventListener("input", (e) => { breaks[i].km = parseFloat(e.target.value) || 0; });
        row.querySelector(".outing-break-del").addEventListener("click", () => { breaks.splice(i, 1); renderBreaks(); });
      });
    }
    if (breaks.length) { editorEl.classList.remove("hidden"); toggleEl.classList.add("hidden"); renderBreaks(); }

    toggleEl.addEventListener("click", () => {
      editorEl.classList.remove("hidden");
      toggleEl.classList.add("hidden");
      if (!breaks.length) { breaks.push({ label: "", km: Math.round((trail.distance / 2) * 10) / 10 }); renderBreaks(); }
    });
    el.querySelector("#outing-add-break").addEventListener("click", () => {
      const last = breaks[breaks.length - 1];
      const km = last ? Math.min(trail.distance - 0.1, last.km + 1) : Math.round((trail.distance / 2) * 10) / 10;
      breaks.push({ label: "", km: Math.round(km * 10) / 10 });
      renderBreaks();
    });

    function buildSteps() {
      const sorted = breaks.filter((b) => b.km > 0 && b.km < trail.distance).sort((a, b) => a.km - b.km);
      if (!sorted.length) return null;
      const points = [...sorted.map((b) => b.km), trail.distance];
      let kmStart = 0;
      return points.map((km, i) => {
        const step = { label: sorted[i]?.label || (i === points.length - 1 ? "Arrivée" : `Étape ${i + 1}`), kmStart, kmEnd: km };
        kmStart = km;
        return step;
      });
    }

    function close(result) {
      document.removeEventListener("keydown", onKey);
      el.classList.add("pack-closing");
      el.addEventListener("transitionend", () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 300);
      resolve(result);
    }
    const onKey = (e) => { if (e.key === "Escape") close(null); };

    el.querySelector(".pack-close").addEventListener("click", () => close(null));
    el.querySelector(".pack-cancel").addEventListener("click", () => close(null));
    el.addEventListener("click", (e) => { if (e.target === el) close(null); });

    function commit() {
      if (!dateEl.value) { toast("Choisissez une date.", { type: "error" }); return null; }
      return saveOuting({
        id: existing?.id,
        trailId: trail.id,
        date: dateEl.value,
        time: timeEl.value || null,
        note: noteEl.value.trim(),
        steps: buildSteps(),
        createdAt: existing?.createdAt,
      });
    }

    el.querySelector("#outing-save").addEventListener("click", () => {
      const rec = commit();
      if (rec) { toast("Sortie enregistrée.", { type: "success" }); close(rec); }
    });
    el.querySelector("#outing-save-gcal").addEventListener("click", () => {
      const rec = commit();
      if (!rec) return;
      const url = buildGCalUrl(rec, trail);
      if (url) window.open(url, "_blank", "noopener");
      close(rec);
    });
    el.querySelector("#outing-delete")?.addEventListener("click", () => {
      deleteOuting(existing.id);
      toast("Réservation annulée.");
      close(null);
    });

    document.addEventListener("keydown", onKey);
    document.body.appendChild(el);
    setTimeout(() => el.classList.add("pack-open"), 0);
  });
}

export function initOutings() {
  bindOutingsList();
  renderOutingsBlock();
}
