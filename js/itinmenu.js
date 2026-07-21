// Sancho Rossi — menu contextuel d'un itinéraire enregistré (appui long / clic droit)
// Depuis « Mes itinéraires » : renommer, modifier le tracé (rouvre le planificateur), ou
// supprimer. Réutilise la feuille glissante des packs (.pack-modal/.pack-sheet) : centrée
// sur Mac, bottom-sheet sur téléphone, mêmes transitions douces.
import { renameImported, deleteImported } from "./trails.js";
import { openPlannerForEdit } from "./planner.js";
import { renderNavView } from "./navview.js";
import { toast } from "./toast.js";

// Une seule feuille à la fois : ouvrir remplace la précédente.
let current = null;

export function openItinMenu(trail) {
  if (!trail) return;
  current?.remove();

  const el = document.createElement("div");
  current = el;
  el.className = "pack-modal itin-menu";
  el.innerHTML = `
    <div class="pack-sheet itin-sheet" role="dialog" aria-modal="true" aria-label="Actions sur l'itinéraire">
      <div class="itin-menu-head">
        <div class="eyebrow">Itinéraire</div>
        <h3 class="pack-title itin-menu-name"></h3>
      </div>
      <div class="itin-actions">
        <button class="act-row" data-act="rename">
          <span class="act-ic">✎</span><span class="act-label">Renommer</span>
        </button>
        <button class="act-row" data-act="edit">
          <span class="act-ic">🗺</span>
          <span class="act-text"><span class="act-label">Modifier le tracé</span>
          <span class="act-sub">Rouvre le planificateur sur cet itinéraire</span></span>
        </button>
        <button class="act-row act-danger" data-act="delete">
          <span class="act-ic">🗑</span><span class="act-label">Supprimer</span>
        </button>
      </div>
      <div class="itin-rename hidden">
        <label class="eyebrow" for="itin-rename-input">Nouveau nom</label>
        <input id="itin-rename-input" class="itin-rename-input" type="text" autocomplete="off" />
        <div class="itin-rename-actions">
          <button class="btn btn-ghost" data-cancel-rename>Annuler</button>
          <button class="btn btn-primary" data-do-rename>Renommer</button>
        </div>
      </div>
    </div>`;

  el.querySelector(".itin-menu-name").textContent = trail.name;

  const actions = el.querySelector(".itin-actions");
  const renameBox = el.querySelector(".itin-rename");
  const input = el.querySelector(".itin-rename-input");
  const delBtn = el.querySelector('[data-act="delete"]');

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    el.classList.add("pack-closing");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 300); // filet si la transition ne se déclenche pas
    if (current === el) current = null;
  }
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };

  // ---------- Renommer (en place dans la feuille) ----------
  function showRename() {
    actions.classList.add("hidden");
    renameBox.classList.remove("hidden");
    input.value = trail.name;
    input.focus();
    input.select();
  }
  function commitRename() {
    const val = input.value.trim();
    if (val && renameImported(trail.id, val)) {
      renderNavView();
      toast("Itinéraire renommé.", { type: "success" });
    }
    close();
  }

  el.querySelector('[data-act="rename"]').addEventListener("click", showRename);
  el.querySelector("[data-cancel-rename]").addEventListener("click", () => {
    renameBox.classList.add("hidden");
    actions.classList.remove("hidden");
  });
  el.querySelector("[data-do-rename]").addEventListener("click", commitRename);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
  });

  // ---------- Modifier le tracé ----------
  el.querySelector('[data-act="edit"]').addEventListener("click", () => {
    close();
    openPlannerForEdit(trail);
  });

  // ---------- Supprimer (confirmation en deux temps, sans confirm() natif) ----------
  let armed = false;
  delBtn.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      delBtn.classList.add("act-armed");
      delBtn.querySelector(".act-label").textContent = "Confirmer la suppression";
      return;
    }
    deleteImported(trail.id); // referme la fiche, met à jour Explorer et les favoris
    renderNavView();          // rafraîchit « Mes itinéraires »
    toast("Itinéraire supprimé.");
    close();
  });

  el.addEventListener("click", (e) => { if (e.target === el) close(); });
  document.addEventListener("keydown", onKey);

  document.body.appendChild(el);
  // setTimeout et non rAF : rAF est gelé en arrière-plan, la feuille resterait à opacité 0.
  setTimeout(() => el.classList.add("pack-open"), 0);
}
