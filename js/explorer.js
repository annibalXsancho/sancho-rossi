// Sancho Rossi — panneau glissant d'Explorer (bottom-sheet façon AllTrails).
// La carte est l'écran ; le panneau glisse par-dessus. Il porte les actions rapides
// (planifier, boucle, filtres, mes randos), les idées du week-end (recommend.js) et les
// itinéraires de la zone chargée (trails.js). Sur mobile, on tire la feuille vers le haut
// pour lire la liste, vers le bas pour rendre toute la hauteur à la carte ; sur desktop
// c'est un panneau docké repliable. La mécanique reprend celle du planificateur (S-PLAN-C).
import { openFilters } from "./filters.js";
import { switchTab } from "./ui.js";
import { selectZone, runZonePackJob } from "./zoneselect.js";
import { askZonePackOptions } from "./packdialog.js";
import { buildZonePack } from "./offline.js";
import { toast } from "./toast.js";

const el = (id) => document.getElementById(id);

// Télécharger une ZONE hors-ligne (S-V2-PACKS-ZONE) : cadrage rectangle → choix
// calques/zoom → build avec chip de progression. Lancé depuis la feuille Explorer.
async function startZoneDownload() {
  const bbox = await selectZone();
  if (!bbox) return;
  const opts = await askZonePackOptions(bbox);
  if (!opts) return;
  const { name, deepLayers, deepMax } = opts;
  const { result, err } = await runZonePackJob({
    label: name,
    job: (onProgress, shouldStop) =>
      buildZonePack(name, bbox, { deepLayers, deepMax }, onProgress, { shouldStop }),
  });
  if (err) toast(`Téléchargement incomplet : ${err.message}`, { type: "error" });
  else if (result === null) toast("Téléchargement interrompu — reprenez-le depuis Réglages.");
  else toast(`Zone « ${name} » prête hors-ligne.`, { type: "success" });
}

export function initExplorer() {
  const panel = el("results-panel");
  if (!panel) return;

  const grip = el("sheet-grip");
  const head = panel.querySelector(".sheet-actions");
  const isMobile = () => window.matchMedia("(max-width: 700px)").matches;

  // ---------- Actions rapides ----------
  // Planifier (#sheet-planner), Boucle (#sheet-loops) et « Charger la zone »
  // (#btn-load-trails) sont câblés directement par leurs modules (planner.js / loops.js /
  // catalog.js). Filtres et « Mes randos » ici.
  el("sheet-filters")?.addEventListener("click", openFilters);
  el("sheet-library")?.addEventListener("click", () => switchTab("itineraires"));
  el("btn-pack-zone")?.addEventListener("click", startZoneDownload);

  // ---------- Bottom-sheet glissable (mobile) ----------
  // Deux crans : ouvert (transform 0) / réduit (.sheet-collapsed, position CSS). Le
  // glissement pilote --sheet-y (px) sans transition ; au relâchement, snap selon la
  // position et l'élan. maxY = course de glissement = hauteur du panneau − hauteur du peek
  // (--sheet-peek), recalculée au début de chaque geste — le contenu est alors stabilisé.
  let dragging = false, moved = false, startY = 0, baseY = 0, curY = 0, maxY = 0;
  let lastY = 0, lastT = 0, vel = 0;

  const peekPx = () => parseFloat(getComputedStyle(panel).getPropertyValue("--sheet-peek")) || 112;
  const setY = (y) => { curY = y; panel.style.setProperty("--sheet-y", `${y}px`); };
  const collapse = () => panel.classList.add("sheet-collapsed");
  const expand = () => panel.classList.remove("sheet-collapsed");

  const onDown = (e) => {
    if (!isMobile() || dragging) return;
    // Un tap sur une action rapide (planifier, filtres…) n'arme pas le glissement.
    if (e.target.closest("button") && !e.target.closest("#sheet-grip")) return;
    dragging = true; moved = false;
    startY = lastY = e.clientY; lastT = performance.now();
    maxY = Math.max(0, panel.offsetHeight - peekPx());
    baseY = panel.classList.contains("sheet-collapsed") ? maxY : 0;
    setY(baseY);
    panel.classList.add("sheet-dragging");
    grip?.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    setY(Math.min(maxY, Math.max(0, baseY + dy)));
    const now = performance.now();
    if (now > lastT) { vel = (e.clientY - lastY) / (now - lastT); lastY = e.clientY; lastT = now; }
    if (moved) e.preventDefault(); // pas de scroll de page pendant qu'on tire la feuille
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove("sheet-dragging");
    if (!moved) { // simple tap sur la poignée = bascule ouvert/réduit
      if (e.target.closest("#sheet-grip")) panel.classList.contains("sheet-collapsed") ? expand() : collapse();
      return;
    }
    // L'élan tranche ; sinon la moitié parcourue décide.
    (vel > 0.35 || (vel >= -0.35 && curY > maxY * 0.4)) ? collapse() : expand();
  };

  grip?.addEventListener("pointerdown", onDown);
  head?.addEventListener("pointerdown", onDown);
  document.addEventListener("pointermove", onMove, { passive: false });
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", () => {
    if (dragging) { dragging = false; panel.classList.remove("sheet-dragging"); }
  });
  grip?.addEventListener("keydown", (e) => {
    if (!isMobile() || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    panel.classList.contains("sheet-collapsed") ? expand() : collapse();
  });

  // ---------- Flèche de repli (⌄) ----------
  const toggle = () => {
    if (isMobile()) panel.classList.contains("sheet-collapsed") ? expand() : collapse();
    else panel.classList.toggle("collapsed");
  };
  el("panel-collapse")?.addEventListener("click", toggle);

  // ---------- État initial ----------
  // Mobile : réduit (la carte domine, on tire pour lire) ; desktop : ouvert. Placement
  // initial sans transition (.sheet-noanim) pour éviter un glissement au boot.
  const applyInitial = () => {
    if (isMobile()) {
      panel.classList.add("sheet-noanim");
      panel.classList.remove("collapsed", "sheet-dragging");
      panel.classList.add("sheet-collapsed");
      panel.style.removeProperty("--sheet-y");
      requestAnimationFrame(() => panel.classList.remove("sheet-noanim"));
    } else {
      panel.classList.remove("sheet-collapsed", "sheet-dragging");
      panel.style.removeProperty("--sheet-y");
      curY = 0;
    }
  };
  applyInitial();
  window.addEventListener("resize", applyInitial);
}
