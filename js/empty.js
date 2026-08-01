// Sancho Rossi — états vides (S12).
// Avant cet audit, chaque écran inventait son vide : un emoji couleur (🥾, 🧭) posé au
// centre d'un côté, un simple `<p class="muted">Aucun…</p>` de l'autre. Une seule
// présentation existe désormais — icône DESSINÉE au trait (la famille posée par
// S-V3-CALQUES-UI, qui a banni les emojis du sélecteur de calques), une phrase courte,
// et l'action qui sort de l'impasse quand il y en a une.
//
// Module volontairement sans dépendance : il est importé par des écrans qui n'ont
// aucune raison de charger la carte pour dessiner un pictogramme.

// Traits à 24×24, `currentColor`, mêmes conventions que LAYER_ICONS (map.js).
export const EMPTY_ICONS = {
  route: '<path d="M4.5 18.5 9.5 11l5 3.5L19.5 5.5"/><circle cx="4.5" cy="18.5" r="1.9" fill="currentColor" stroke="none"/><circle cx="19.5" cy="5.5" r="1.9" fill="currentColor" stroke="none"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  download: '<path d="M12 4v10"/><path d="m8 11 4 4 4-4"/><path d="M5 19h14"/>',
  contacts: '<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 7.5a3 3 0 0 1 0 5.5"/><path d="M17.5 19a5.4 5.4 0 0 0-2-3.6"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4.5 4.5"/>',
  outing: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
};

const svg = (key) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${EMPTY_ICONS[key] || ""}</svg>`;

/**
 * Rend le HTML d'un état vide.
 * @param {string} icon  clé d'EMPTY_ICONS
 * @param {string} text  la phrase (déjà échappée si elle vient de l'extérieur)
 * @param {{label:string, id?:string, cls?:string}} [action] bouton facultatif
 * @param {boolean} [inline] version tassée, pour un vide à l'intérieur d'un bloc
 */
export function emptyState(icon, text, action = null, inline = false) {
  const btn = action
    ? `<button class="btn ${action.cls || ""}"${action.id ? ` id="${action.id}"` : ""}>${action.label}</button>`
    : "";
  return `<div class="empty-state${inline ? " empty-state-inline" : ""}">
      <span class="empty-icon">${svg(icon)}</span>
      <p>${text}</p>
      ${btn}
    </div>`;
}
