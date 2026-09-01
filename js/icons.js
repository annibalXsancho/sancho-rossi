// Sancho Rossi — pictogrammes au trait (S-UI-V3).
//
// Pourquoi un module : l'interface mélangeait des emojis (🧭, 🥾, 🎲, 🛟, 📍, 🆘) et des
// SVG écrits à la main. Un emoji est dessiné par le système d'exploitation — couleur,
// graisse et style échappent à la charte, et sur fond noir il se lit comme une vignette
// collée sur l'écran. Tous les pictogrammes VISIBLES passent donc par ici : même grille
// 24, même graisse de trait, `currentColor` pour suivre la couleur du texte.
//
// Les emojis des messages SORTANTS (SMS, WhatsApp, notification ntfy de security.js) ne
// sont pas concernés : là, ils sont lus par un autre appareil et servent de repère
// visuel dans un fil de discussion.

const STROKE =
  'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';

const PATHS = {
  // Boussole — écrans vides de découverte
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.2 8.8-1.9 4.5-4.5 1.9 1.9-4.5z"/>',
  // Poteau de balisage — écrans vides de liste d'itinéraires
  signpost: '<path d="M12 3v18"/><path d="M12 5.6h6.4l1.8 2.4-1.8 2.4H12z"/><path d="M12 13H5.6l-1.8 2.4L5.6 17.8H12z"/>',
  // Reprise — « autre sélection »
  refresh: '<path d="M19.6 11.2A7.8 7.8 0 1 0 18.9 15"/><path d="M19.9 4.8v6.4h-6.4"/>',
  // Bouée — section Sécurité
  lifebuoy: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.6"/><path d="m5.6 5.6 3.9 3.9M14.5 14.5l3.9 3.9M18.4 5.6l-3.9 3.9M9.5 14.5l-3.9 3.9"/>',
  // Punaise — position, lieu
  pin: '<path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
  // Émission — partage de position en urgence
  broadcast: '<circle cx="12" cy="12" r="2.4"/><path d="M8.1 8.1a5.5 5.5 0 0 0 0 7.8M15.9 15.9a5.5 5.5 0 0 0 0-7.8"/><path d="M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 18.7a9.5 9.5 0 0 0 0-13.4"/>',
  // Import de fichier
  upload: '<path d="M12 16V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  // Cœur — itinéraires enregistrés
  heart: '<path d="M12 20s-7.2-4.4-7.2-9.3A4.1 4.1 0 0 1 12 8a4.1 4.1 0 0 1 7.2 2.7C19.2 15.6 12 20 12 20z"/>',
  // Carte dépliée — « voir sur la carte »
  map: '<path d="m9 5-5 2v12l5-2 6 2 5-2V5l-5 2z"/><path d="M9 5v12M15 7v12"/>',
  // Presse-papier avec trace — plan de marche
  route: '<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 17.2c3.4-.6 3.6-3 1.6-4.2s-1.6-3.6 1.8-4.3l4.2-1"/>',
};

/** Renvoie le balisage SVG d'un pictogramme. `cls` sert à le dimensionner en CSS. */
export function icon(name, cls = "ic") {
  const d = PATHS[name];
  if (!d) return "";
  return `<svg class="${cls}" viewBox="0 0 24 24" ${STROKE} aria-hidden="true">${d}</svg>`;
}

/** Écran vide : un pictogramme dans son disque tonal + une phrase. */
export function emptyState(name, text) {
  return `<div class="empty-state"><div class="empty-icon">${icon(name)}</div><p>${text}</p></div>`;
}
