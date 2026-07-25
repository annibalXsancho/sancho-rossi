// Sancho Rossi — S-V2-SORTIES : choix brut/recalé à l'import GPX (absorbe S-RECALAGE)
// Un GPX tiers peut être une trace fidèle hors-sentier (jamais à écraser) ou un tracé
// grossier (points espacés, dessiné à main levée) qu'un recalage BRouter rend fidèle.
// On propose toujours les deux, on ne force jamais — le brut reste le défaut.
import { haversineKm } from "./state.js";
import { brouterRoute } from "./brouter.js";
import { createFicheMap, drawTrackOn, TRACK_COLOR } from "./map.js";
import { toast } from "./toast.js";

const MIN_SEP_KM = 0.03; // même contrainte que brouter.js — deux points confondus refusés

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Heuristique de géométrie suspecte, sans appel réseau — deux signaux :
//  1. espacement moyen entre points > 150 m (export basse fréquence / tracé grossier) ;
//  2. rectitude excessive sur des fenêtres glissantes ~1 km (dessiné à main levée sur
//     une carte plutôt qu'un vrai sentier qui serpente).
// Seuils conservateurs : ne PAS déclencher sur un GPX dense normal (Strava/Komoot,
// 5-15 m d'espacement), déclencher sur les cas typiques signalés.
export function looksOffTrail(track, distanceKm) {
  if (!track || track.length < 3 || !(distanceKm > 0)) return null;

  const avgSepM = (distanceKm * 1000) / (track.length - 1);
  if (avgSepM > 150) return { reason: `points espacés de ${Math.round(avgSepM)} m en moyenne` };

  const cumKm = [0];
  for (let i = 1; i < track.length; i++) cumKm.push(cumKm[i - 1] + haversineKm(track[i - 1], track[i]));

  let straightWindows = 0, totalWindows = 0, j = 0;
  for (let i = 0; i < track.length; i++) {
    while (cumKm[i] - cumKm[j] > 1) j++;
    const along = cumKm[i] - cumKm[j];
    if (along < 0.5) continue;
    totalWindows++;
    const straight = haversineKm(track[j], track[i]);
    if (straight / along > 0.97) straightWindows++;
  }
  if (totalWindows > 0 && straightWindows / totalWindows > 0.6) {
    return { reason: "tracé anormalement rectiligne" };
  }
  return null;
}

// Sous-échantillonne le tracé pour BRouter : espacés d'au moins `targetSepKm`, sinon
// chaque point du GPX deviendrait un point de passage forcé — ça annulerait tout
// recalage (BRouter router serait contraint de repasser exactement par chaque point).
export function sampleForBrouter(track, targetSepKm = 0.25) {
  const out = [track[0]];
  for (let i = 1; i < track.length; i++) {
    if (haversineKm(out[out.length - 1], track[i]) >= targetSepKm) out.push(track[i]);
  }
  const last = track[track.length - 1];
  if (haversineKm(out[out.length - 1], last) > 0) out.push(last);
  // Filet : garantit MIN_SEP_KM même si `targetSepKm` est trop bas pour un tracé très dense.
  return out.filter((p, i) => i === 0 || haversineKm(p, out[i - 1]) > MIN_SEP_KM);
}

// { before: rawTrail, after: résultat brouterRoute } — avant/après pour l'aperçu.
export async function previewSnap(rawTrail) {
  const waypoints = sampleForBrouter(rawTrail.track);
  if (waypoints.length < 2) throw new Error("tracé trop court pour un recalage");
  const after = await brouterRoute(waypoints, { profile: "hiking-mountain" });
  return { before: rawTrail, after };
}

// Résout { mode: "raw" } | { mode: "snapped", routed } | null (annulé).
export function openImportChoice(rawTrail) {
  return new Promise((resolve) => {
    const suspect = looksOffTrail(rawTrail.track, rawTrail.distance);

    const el = document.createElement("div");
    el.className = "pack-modal";
    el.innerHTML = `
      <div class="pack-sheet" role="dialog" aria-modal="true" aria-label="Importer le tracé GPX">
        <div class="pack-head">
          <div>
            <div class="eyebrow">Trace importée</div>
            <h3 class="pack-title">${escapeHtml(rawTrail.name)}</h3>
          </div>
          <button class="btn-ghost pack-close" aria-label="Fermer">✕</button>
        </div>

        <div class="import-choice" id="import-step1">
          <button class="import-option active" data-mode="raw" type="button">
            <div class="import-option-title">Importer brut</div>
            <p class="import-option-hint">La trace est conservée telle quelle. Recommandé si le parcours sort des sentiers balisés.</p>
          </button>
          <button class="import-option" data-mode="snap" type="button">
            <div class="import-option-title">Recaler sur les sentiers${suspect ? ' <span class="pill pill-warn">recommandé</span>' : ""}</div>
            <p class="import-option-hint">${suspect ? `Géométrie suspecte : ${suspect.reason}. ` : ""}Ajuste la trace sur le réseau de sentiers (BRouter) — un aperçu avant/après est proposé avant de valider.</p>
          </button>
        </div>
        <div class="pack-actions" id="import-step1-actions">
          <button class="btn btn-ghost pack-cancel">Annuler</button>
          <button class="btn btn-primary" id="import-go">Importer</button>
        </div>

        <div class="import-preview hidden" id="import-step2">
          <div class="import-preview-map" id="import-preview-map"></div>
          <p class="pack-hint" id="import-delta">Calcul du recalage…</p>
          <div class="pack-actions">
            <button class="btn btn-ghost" id="import-back">Revenir au brut</button>
            <button class="btn btn-primary" id="import-confirm-snap" disabled>Valider le recalage</button>
          </div>
        </div>
      </div>`;

    let mode = "raw";
    let snapResult = null;
    let previewMap = null;

    const step1 = el.querySelector("#import-step1");
    const step1Actions = el.querySelector("#import-step1-actions");
    const step2 = el.querySelector("#import-step2");

    el.querySelectorAll(".import-option").forEach((b) => {
      b.addEventListener("click", () => {
        mode = b.dataset.mode;
        el.querySelectorAll(".import-option").forEach((x) => x.classList.toggle("active", x === b));
      });
    });

    function close(result) {
      document.removeEventListener("keydown", onKey);
      if (previewMap) { previewMap.remove(); previewMap = null; }
      el.classList.add("pack-closing");
      el.addEventListener("transitionend", () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 300); // filet si la transition ne se déclenche pas
      resolve(result);
    }
    const onKey = (e) => { if (e.key === "Escape") close(null); };

    el.querySelector(".pack-close").addEventListener("click", () => close(null));
    el.querySelector(".pack-cancel").addEventListener("click", () => close(null));
    el.addEventListener("click", (e) => { if (e.target === el) close(null); });

    function renderPreview(before, after) {
      previewMap = createFicheMap("import-preview-map", { inert: true });
      previewMap.on("load", () => {
        const before_l = drawTrackOn(previewMap, before.track, { color: "#7a7a82", weight: 3.5 });
        drawTrackOn(previewMap, after.track, { color: TRACK_COLOR, weight: 3.5 });
        previewMap.fitBounds(before_l.getBounds(), { padding: 24 });
      });
      const afterDist = Math.round(after.distance * 10) / 10;
      el.querySelector("#import-delta").textContent =
        `Distance : ${before.distance} km → ${afterDist} km` +
        (after.ascend != null ? ` · D+ : ${Math.round(after.ascend)} m` : "");
      el.querySelector("#import-confirm-snap").disabled = false;
    }

    el.querySelector("#import-go").addEventListener("click", async () => {
      if (mode === "raw") { close({ mode: "raw" }); return; }
      step1.classList.add("hidden");
      step1Actions.classList.add("hidden");
      step2.classList.remove("hidden");
      try {
        const { before, after } = await previewSnap(rawTrail);
        snapResult = after;
        renderPreview(before, after);
      } catch (err) {
        toast("Recalage impossible — import brut conservé (" + err.message + ")", { type: "error" });
        close({ mode: "raw" });
      }
    });

    el.querySelector("#import-back").addEventListener("click", () => {
      if (previewMap) { previewMap.remove(); previewMap = null; }
      step2.classList.add("hidden");
      step1.classList.remove("hidden");
      step1Actions.classList.remove("hidden");
    });

    el.querySelector("#import-confirm-snap").addEventListener("click", () => {
      close({ mode: "snapped", routed: snapResult });
    });

    document.addEventListener("keydown", onKey);
    document.body.appendChild(el);
    setTimeout(() => el.classList.add("pack-open"), 0);
  });
}
