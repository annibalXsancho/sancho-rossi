// Sancho Rossi — remplissage de la portion parcourue d'un <input type="range"> (S12).
//
// Les curseurs étaient laissés natifs (`accent-color` seul) : gros pouce rond et piste
// blanche du système, dix d'affilée sur la bibliothèque de calques. Les styliser impose
// `appearance: none` — et WebKit cesse alors de peindre la portion parcourue (seul Firefox
// a `::-moz-range-progress`). On passe donc le ratio en variable CSS `--range-fill` et le
// dégradé de la piste s'en charge, dans les deux moteurs.
//
// Module feuille (n'importe rien) : map.js et navview.js peuvent l'appeler sans cycle.

export function paintRange(el) {
  if (!el || el.type !== "range") return;
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty("--range-fill", `${pct}%`);
}

export function paintRanges(root = document) {
  root.querySelectorAll('input[type="range"]').forEach(paintRange);
}

// Un seul écouteur délégué couvre tous les glissés, y compris ceux des panneaux
// reconstruits plus tard ; les mises à jour programmatiques (applyLayer, renderLayers)
// appellent paintRange/paintRanges directement.
export function initRangeFill() {
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type === "range") paintRange(t);
  });
  paintRanges();
}
