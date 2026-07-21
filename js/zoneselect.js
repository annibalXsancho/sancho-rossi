// Sancho Rossi — cadrage d'une zone à emporter hors-ligne (S-V2-PACKS-ZONE).
// Un rectangle ANCRÉ À L'ÉCRAN posé sur la carte : on tire ses coins pour le
// redimensionner, on déplace la carte DESSOUS (pan/pinch natifs à travers l'overlay,
// qui est en pointer-events:none sauf poignées et barre). À la validation, les 2 coins
// écran sont projetés en géo (`map.unproject`) → bbox {s,w,n,e}. Choix utilisateur du
// 21/07 : rectangle ajustable plutôt que « toute la vue » seule.
import { map } from "./map.js";

let active = false;

// Chip de progression fixe pour un téléchargement de zone (le lancement se fait depuis la
// feuille réduite — pas de bouton de fiche à muter comme pour les packs de rando). Partagé
// par le flux « nouvelle zone » (explorer.js) et « reprendre » (ui.js). `job(onProgress,
// shouldStop)` = buildZonePack/resumeZonePack. Résout { result, err } : result = entrée
// manifeste (succès), null (annulé, pending conservé), err = échec.
export function runZonePackJob({ label, job }) {
  return new Promise((resolve) => {
    let stop = false;
    const chip = document.createElement("div");
    chip.className = "zone-progress";
    chip.innerHTML =
      `<span class="zone-progress-label"></span>` +
      `<button class="btn btn-ghost zone-progress-cancel" type="button">Annuler</button>`;
    const labelEl = chip.querySelector(".zone-progress-label");
    labelEl.textContent = `${label} — préparation…`;
    chip.querySelector(".zone-progress-cancel").addEventListener("click", () => {
      stop = true;
      labelEl.textContent = `${label} — arrêt…`;
    });
    document.body.appendChild(chip);

    const onProgress = (p) => {
      if (p.phase === "tiles") labelEl.textContent = `${label} — carte ${Math.round((p.done / p.total) * 100) || 0} %`;
      else if (p.phase === "poi") labelEl.textContent = `${label} — points d'intérêt…`;
      else if (p.phase === "prepare") labelEl.textContent = `${label} — préparation…`;
    };
    const finish = (result, err) => { chip.remove(); resolve({ result, err }); };
    job(onProgress, () => stop).then((result) => finish(result, null)).catch((err) => finish(null, err));
  });
}

// Ouvre le cadrage. Résout la bbox {s,w,n,e} si l'utilisateur valide, null s'il annule.
export function selectZone() {
  return new Promise((resolve) => {
    if (active) { resolve(null); return; }
    active = true;
    const host = document.getElementById("view-carte");
    host.classList.add("zone-selecting");   // masque contrôles carte + feuille (CSS)

    const overlay = document.createElement("div");
    overlay.className = "zone-overlay";
    overlay.innerHTML = `
      <div class="zone-box">
        <span class="zone-handle" data-corner="nw"></span>
        <span class="zone-handle" data-corner="ne"></span>
        <span class="zone-handle" data-corner="se"></span>
        <span class="zone-handle" data-corner="sw"></span>
      </div>
      <div class="zone-bar">
        <div class="zone-bar-text">
          <span class="eyebrow">Zone à emporter</span>
          <span class="zone-bar-hint">Déplacez la carte, tirez les coins</span>
        </div>
        <div class="zone-bar-actions">
          <button class="btn btn-ghost" id="zone-cancel">Annuler</button>
          <button class="btn btn-primary" id="zone-next">Suivant</button>
        </div>
      </div>`;
    host.appendChild(overlay);

    const box = overlay.querySelector(".zone-box");
    const MIN = 64;                          // côté mini (px) : une zone plus petite n'a pas de sens

    // Boîte en coordonnées écran (px, relatives à #view-carte). Init : retrait ~12 % des
    // bords → se lit « la vue courante, ajustable ».
    const r0 = host.getBoundingClientRect();
    const insetX = Math.round(r0.width * 0.12), insetY = Math.round(r0.height * 0.16);
    const geo = { left: insetX, top: insetY, right: r0.width - insetX, bottom: r0.height - insetY };
    function apply() {
      box.style.left = `${geo.left}px`;
      box.style.top = `${geo.top}px`;
      box.style.width = `${geo.right - geo.left}px`;
      box.style.height = `${geo.bottom - geo.top}px`;
    }
    apply();

    // Redimensionnement par coin. Le pointer est capturé par la poignée (au-dessus de tout,
    // pointer-events:auto) → la carte ne panne pas pendant le geste.
    box.querySelectorAll(".zone-handle").forEach((h) => {
      h.addEventListener("pointerdown", (e) => {
        e.preventDefault(); e.stopPropagation();
        h.setPointerCapture(e.pointerId);
        const corner = h.dataset.corner;
        const move = (ev) => {
          const b = host.getBoundingClientRect();
          const x = Math.max(0, Math.min(b.width, ev.clientX - b.left));
          const y = Math.max(0, Math.min(b.height, ev.clientY - b.top));
          if (corner.includes("n")) geo.top = Math.min(y, geo.bottom - MIN);
          if (corner.includes("s")) geo.bottom = Math.max(y, geo.top + MIN);
          if (corner.includes("w")) geo.left = Math.min(x, geo.right - MIN);
          if (corner.includes("e")) geo.right = Math.max(x, geo.left + MIN);
          apply();
        };
        const up = () => {
          h.releasePointerCapture(e.pointerId);
          h.removeEventListener("pointermove", move);
          h.removeEventListener("pointerup", up);
          h.removeEventListener("pointercancel", up);
        };
        h.addEventListener("pointermove", move);
        h.addEventListener("pointerup", up);
        h.addEventListener("pointercancel", up);
      });
    });

    // Rotation d'écran / redimensionnement : on garde la boîte dans le cadre.
    function clampToView() {
      const b = host.getBoundingClientRect();
      geo.right = Math.min(geo.right, b.width);
      geo.bottom = Math.min(geo.bottom, b.height);
      geo.left = Math.max(0, Math.min(geo.left, geo.right - MIN));
      geo.top = Math.max(0, Math.min(geo.top, geo.bottom - MIN));
      apply();
    }

    function close(result) {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", clampToView);
      host.classList.remove("zone-selecting");
      overlay.remove();
      active = false;
      resolve(result);
    }
    const onKey = (e) => { if (e.key === "Escape") close(null); };

    overlay.querySelector("#zone-cancel").addEventListener("click", () => close(null));
    overlay.querySelector("#zone-next").addEventListener("click", () => {
      // Coins écran → géo. On décale du rect du conteneur de carte (comme map.js pour
      // l'appui long / l'échelle) : la boîte est positionnée dans #view-carte, unproject
      // attend des pixels relatifs au canevas MapLibre.
      const mapRect = map.getContainer().getBoundingClientRect();
      const bx = box.getBoundingClientRect();
      const tl = map.unproject([bx.left - mapRect.left, bx.top - mapRect.top]);
      const br = map.unproject([bx.right - mapRect.left, bx.bottom - mapRect.top]);
      close({
        n: Math.max(tl.lat, br.lat), s: Math.min(tl.lat, br.lat),
        w: Math.min(tl.lng, br.lng), e: Math.max(tl.lng, br.lng),
      });
    });
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", clampToView);
  });
}
