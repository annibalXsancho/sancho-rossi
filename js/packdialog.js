// Sancho Rossi — feuille de choix avant téléchargement d'un pack terrain (S-V2-ZOOM)
// Remplace le confirm() natif : profondeur de zoom + calques détaillés, avec estimation
// de poids recalculée à chaque geste et place restante affichée. Conçue pour resservir
// telle quelle aux packs de zone (S-V2-PACKS-ZONE).
import { DEEP_LAYERS, DEEP_MAX_LAYERS, DEEP_ZOOMS, estimatePack, freeSpaceMB } from "./offline.js";
import { toast } from "./toast.js";

const LAYER_LABEL = {
  plan: "Plan", topo: "Topo", satellite: "Satellite", sombre: "Sombre", trails: "Sentiers balisés",
};

// Choix par défaut : topo (courbes de niveau) + satellite (repères visuels réels) au zoom
// maximal — c'est la combinaison qui répond au retour terrain « navigation aveugle ».
const DEFAULTS = { deepLayers: ["topo", "satellite"], deepMax: 17 };

let lastChoice = null;

// Ouvre la feuille. Résout { deepLayers, deepMax } si l'utilisateur valide, null s'il annule.
export function askPackOptions(trail) {
  return new Promise((resolve) => {
    const choice = {
      deepLayers: [...(lastChoice?.deepLayers ?? DEFAULTS.deepLayers)],
      deepMax: lastChoice?.deepMax ?? DEFAULTS.deepMax,
    };

    const el = document.createElement("div");
    el.className = "pack-modal";
    el.innerHTML = `
      <div class="pack-sheet" role="dialog" aria-modal="true" aria-label="Télécharger pour le terrain">
        <div class="pack-head">
          <div>
            <div class="eyebrow">Emporter sur le terrain</div>
            <h3 class="pack-title"></h3>
          </div>
          <button class="btn-ghost pack-close" aria-label="Fermer">✕</button>
        </div>

        <div class="pack-section">
          <div class="eyebrow">Niveau de détail</div>
          <div class="pack-chips" id="pack-zooms"></div>
          <p class="pack-hint" id="pack-zoom-hint"></p>
        </div>

        <div class="pack-section" id="pack-layers-section">
          <div class="eyebrow">Calques détaillés · ${DEEP_MAX_LAYERS} maximum</div>
          <div class="pack-chips" id="pack-layers"></div>
          <p class="pack-hint">Les 7 calques sont toujours embarqués jusqu'au zoom 15. Seuls ceux-ci descendent plus fin — c'est là qu'est tout le poids.</p>
        </div>

        <div class="pack-estimate">
          <div class="pack-estimate-main"><strong id="pack-mb">—</strong> <span id="pack-tiles" class="muted"></span></div>
          <div class="muted" id="pack-free"></div>
        </div>

        <div class="pack-actions">
          <button class="btn btn-ghost pack-cancel">Annuler</button>
          <button class="btn btn-primary" id="pack-go">Télécharger</button>
        </div>
      </div>`;
    el.querySelector(".pack-title").textContent = trail.name;

    const zoomsEl = el.querySelector("#pack-zooms");
    const layersEl = el.querySelector("#pack-layers");
    const goBtn = el.querySelector("#pack-go");

    // « Standard » = deepMax 0 : aucun calque approfondi, pack z12–15 d'avant S-V2-ZOOM.
    const ZOOM_OPTS = [
      { z: 0, label: "Standard", hint: "Zoom 15 — vue d'ensemble du corridor, pack le plus léger." },
      { z: 16, label: "Détaillé", hint: "Zoom 16 — les sentiers et intersections se lisent." },
      { z: 17, label: "Maximum", hint: "Zoom 17 — les lacets du sentier sont lisibles, à privilégier en navigation." },
    ].filter((o) => o.z === 0 || DEEP_ZOOMS.includes(o.z));

    for (const o of ZOOM_OPTS) {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = o.label;
      b.dataset.z = o.z;
      b.addEventListener("click", () => { choice.deepMax = o.z; render(); });
      zoomsEl.appendChild(b);
    }

    for (const name of DEEP_LAYERS) {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = LAYER_LABEL[name] || name;
      b.dataset.layer = name;
      b.addEventListener("click", () => {
        const i = choice.deepLayers.indexOf(name);
        if (i >= 0) choice.deepLayers.splice(i, 1);
        else if (choice.deepLayers.length >= DEEP_MAX_LAYERS) {
          toast(`${DEEP_MAX_LAYERS} calques détaillés au maximum — désélectionnez-en un.`);
          return;
        } else choice.deepLayers.push(name);
        render();
      });
      layersEl.appendChild(b);
    }

    // Place restante : lue une fois (la jauge ne bouge pas pendant le choix). Reste null
    // si le navigateur ne donne pas de lecture exploitable — on n'affiche alors rien
    // plutôt qu'un chiffre faux.
    let freeMB = null;
    freeSpaceMB().then((mb) => { if (mb != null) { freeMB = mb; render(); } });

    function render() {
      const deep = choice.deepMax > 0 && choice.deepLayers.length > 0;
      zoomsEl.querySelectorAll(".chip").forEach((b) => b.classList.toggle("active", +b.dataset.z === choice.deepMax));
      layersEl.querySelectorAll(".chip").forEach((b) => b.classList.toggle("active", choice.deepLayers.includes(b.dataset.layer)));
      el.querySelector("#pack-zoom-hint").textContent = ZOOM_OPTS.find((o) => o.z === choice.deepMax)?.hint || "";
      // Le choix de calques n'a de sens qu'en mode approfondi.
      el.querySelector("#pack-layers-section").classList.toggle("pack-off", choice.deepMax === 0);

      const est = estimatePack(trail, deep ? choice : {});
      el.querySelector("#pack-mb").textContent = `~${est.mbLabel} Mo`;
      el.querySelector("#pack-tiles").textContent = `· ${est.tiles.toLocaleString("fr-FR")} tuiles`;

      let problem = null;
      if (est.overCap) problem = "Tracé trop long pour un pack unique à ce niveau de détail.";
      else if (choice.deepMax > 0 && !choice.deepLayers.length) problem = "Choisissez au moins un calque détaillé.";
      else if (freeMB != null && est.mb > freeMB * 0.9) problem = `Il ne reste que ~${Math.round(freeMB)} Mo sur cet appareil.`;

      el.querySelector("#pack-free").textContent =
        problem || (freeMB != null ? `${Math.round(freeMB).toLocaleString("fr-FR")} Mo disponibles` : "");
      el.querySelector("#pack-free").classList.toggle("pack-warn", !!problem);
      goBtn.disabled = !!problem;
    }

    function close(result) {
      document.removeEventListener("keydown", onKey);
      el.classList.add("pack-closing");
      el.addEventListener("transitionend", () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 300);   // filet si la transition ne se déclenche pas
      resolve(result);
    }
    const onKey = (e) => { if (e.key === "Escape") close(null); };

    el.querySelector(".pack-close").addEventListener("click", () => close(null));
    el.querySelector(".pack-cancel").addEventListener("click", () => close(null));
    el.addEventListener("click", (e) => { if (e.target === el) close(null); });
    goBtn.addEventListener("click", () => {
      lastChoice = { deepLayers: [...choice.deepLayers], deepMax: choice.deepMax };
      close(choice.deepMax > 0 ? choice : { deepLayers: [], deepMax: 0 });
    });
    document.addEventListener("keydown", onKey);

    document.body.appendChild(el);
    render();
    // setTimeout et non requestAnimationFrame : rAF est gelé quand l'onglet est en
    // arrière-plan, la feuille resterait alors bloquée à opacité 0.
    setTimeout(() => el.classList.add("pack-open"), 0);
  });
}
