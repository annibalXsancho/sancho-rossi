// Sancho Rossi — métriques d'itinéraire (dénivelés, durée, cotation SAC)
// Rassemble ce qui était dupliqué (computeGain existait dans loops.js et, inline,
// dans api.js) et ajoute ce qui manquait : le D− et la cotation de difficulté.
import { haversineKm } from "./state.js";

// Dénivelé cumulé avec hystérésis de 4 m : sans ce seuil, le bruit d'altitude de
// chaque point s'additionne et triple le D+ sur un tracé plat.
const HYST_M = 4;

export function computeGain(eles) {
  let gain = 0, ref = eles[0];
  for (const e of eles) {
    if (e - ref > HYST_M) { gain += e - ref; ref = e; }
    else if (ref - e > HYST_M) ref = e;
  }
  return Math.round(gain);
}

export function computeLoss(eles) {
  let loss = 0, ref = eles[0];
  for (const e of eles) {
    if (ref - e > HYST_M) { loss += ref - e; ref = e; }
    else if (e - ref > HYST_M) ref = e;
  }
  return Math.round(loss);
}

export function naismithHours(distKm, gainM) {
  return distKm / 4.5 + gainM / 600; // Naismith/Tobler : ~4,5 km/h + 600 m/h de montée
}

export function fmtDuration(h) {
  if (h < 9) return `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
  return `${Math.round(h / 7)} j (est.)`;
}

// Distances cumulées le long du tracé, en km. Indispensable dès qu'on raisonne « par
// kilomètre » : les points BRouter ne sont PAS équidistants, un axe par index ment.
export function cumulativeKm(track) {
  const cum = [0];
  for (let i = 1; i < track.length; i++) cum.push(cum[i - 1] + haversineKm(track[i - 1], track[i]));
  return cum;
}

// ---------- Cotation SAC (échelle du Club Alpin Suisse, T1 → T6) ----------
const SAC_ORDER = ["T1", "T2", "T3", "T4", "T5", "T6"];
const SAC_FROM_OSM = {
  hiking: "T1",
  mountain_hiking: "T2",
  demanding_mountain_hiking: "T3",
  alpine_hiking: "T4",
  demanding_alpine_hiking: "T5",
  difficult_alpine_hiking: "T6",
};

// Un tronçon coté doit peser au moins 100 m pour compter : en dessous, c'est plus
// probablement un tag isolé erroné qu'un vrai passage.
const CRUX_MIN_M = 100;
// En deçà de cette part du parcours cotée, la cote est annoncée « estimée ».
const TRUST_COVERAGE = 0.5;

export const SAC_LABEL = {
  T1: "Randonnée",
  T2: "Randonnée en montagne",
  T3: "Randonnée en montagne exigeante",
  T4: "Randonnée alpine",
  T5: "Randonnée alpine exigeante",
  T6: "Randonnée alpine difficile",
};

// Cote d'un itinéraire → { level, coverage, estimated, source, cruxM }.
//
// Deux partis pris, tous deux orientés sécurité :
//  1. LE PASSAGE CLÉ DÉFINIT LA COTE, pas la moyenne. 200 m de T4 sur 20 km de T1
//     font une course T4 : c'est le passage dur qui décide si on y va. On retient
//     donc le niveau le PLUS HAUT couvrant au moins CRUX_MIN_M.
//  2. UNE COTE N'EST JAMAIS MUETTE sur sa provenance. `sac_scale` est très inégal
//     dans OSM (0 % de couverture sur certaines vallées) → au lieu d'inventer, on
//     replie sur la pente et on marque `estimated`, à charge pour l'UI de le dire.
export function sacRating({ ways = [], eles = null, track = null } = {}) {
  const byLevel = new Map();
  let tagged = 0, total = 0;
  for (const w of ways) {
    total += w.distM;
    const lvl = SAC_FROM_OSM[w.tags?.sac_scale];
    if (!lvl) continue;
    tagged += w.distM;
    byLevel.set(lvl, (byLevel.get(lvl) || 0) + w.distM);
  }
  const coverage = total > 0 ? tagged / total : 0;

  if (byLevel.size) {
    let level = null;
    for (let i = SAC_ORDER.length - 1; i >= 0 && !level; i--) {
      if ((byLevel.get(SAC_ORDER[i]) || 0) >= CRUX_MIN_M) level = SAC_ORDER[i];
    }
    // Aucun niveau ne passe le seuil : on garde le plus haut présent, sans le faire
    // disparaître (un T4 de 60 m reste une information qu'on doit au marcheur).
    for (let i = SAC_ORDER.length - 1; i >= 0 && !level; i--) {
      if (byLevel.has(SAC_ORDER[i])) level = SAC_ORDER[i];
    }
    return {
      level,
      coverage,
      estimated: coverage < TRUST_COVERAGE,
      source: "osm",
      cruxM: Math.round(byLevel.get(level) || 0),
    };
  }

  return { level: sacFromSlope(eles, track), coverage: 0, estimated: true, source: "pente", cruxM: 0 };
}

// Repli quand aucun tronçon n'est coté : la pente max soutenue sur ~100 m. Plafonné
// à T4 — au-delà, la cote dépend de l'exposition et de l'usage des mains, que la
// pente seule ne peut pas révéler. Mieux vaut sous-coter et le dire que bluffer.
function sacFromSlope(eles, track) {
  if (!eles || !track || eles.length !== track.length || eles.length < 2) return null;
  const cum = cumulativeKm(track);
  let maxSlope = 0, j = 0;
  for (let i = 0; i < eles.length; i++) {
    while (cum[i] - cum[j] > 0.1) j++; // fenêtre glissante ~100 m
    const runM = (cum[i] - cum[j]) * 1000;
    if (runM < 60) continue; // trop court pour être une pente « soutenue »
    maxSlope = Math.max(maxSlope, Math.abs(eles[i] - eles[j]) / runM);
  }
  if (maxSlope < 0.15) return "T1";
  if (maxSlope < 0.25) return "T2";
  if (maxSlope < 0.4) return "T3";
  return "T4";
}
