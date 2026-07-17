// Sancho Rossi — repères personnels sur un itinéraire (S-PLAN-C)
//
// Un repère est un point posé PAR l'utilisateur sur son itinéraire en préparation :
// objectif de nuit, point d'eau connu, passage à surveiller… Il est indépendant des
// POI Overpass (données publiques, couches carte) : ici c'est la connaissance de
// l'utilisateur qui est stockée, embarquée dans le tracé sauvegardé (champ `pois`),
// et rejouée sur la fiche. Ce module ne porte que le vocabulaire partagé entre le
// planificateur et la fiche — l'édition vit dans planner.js.
import { cumulativeKm } from "./metrics.js";

export const ANNOT_KINDS = {
  sleep:  { icon: "🌙", label: "Nuit / bivouac" },
  water:  { icon: "💧", label: "Point d'eau" },
  danger: { icon: "⚠️", label: "Passage délicat" },
  supply: { icon: "🛒", label: "Ravitaillement" },
  view:   { icon: "📷", label: "Point de vue" },
  note:   { icon: "📝", label: "Note" },
};

export const annotKind = (k) => ANNOT_KINDS[k] || ANNOT_KINDS.note;

// Au-delà de cet écart, le repère est « hors itinéraire » : on le garde (un point
// d'eau à 400 m du sentier reste une information), mais sans km ni marque de profil.
export const ANNOT_NEAR_M = 250;

// Fabrique un localisateur « où suis-je le long du tracé ? » : renvoie une fonction
// (lat, lon) → { km, offM, index }. Le cumul est recalé sur la distance annoncée,
// même correction que profile.js (le cumul d'un échantillon coupe les virages).
export function trackLocator(track, totalKm) {
  if (!track || track.length < 2) return null;
  const cum = cumulativeKm(track);
  const raw = cum[cum.length - 1] || 1;
  const scale = totalKm > 0 ? totalKm / raw : 1;
  return (lat, lon) => {
    const kx = 111320 * Math.cos((lat * Math.PI) / 180); // m par degré de longitude ici
    let bi = 0, bd = Infinity;
    for (let i = 0; i < track.length; i++) {
      const dy = (track[i][0] - lat) * 111320;
      const dx = (track[i][1] - lon) * kx;
      const d = dy * dy + dx * dx;
      if (d < bd) { bd = d; bi = i; }
    }
    return { km: cum[bi] * scale, offM: Math.sqrt(bd), index: bi };
  };
}
