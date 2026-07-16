// Sancho Rossi — nature du terrain sous les pieds (S-PLAN-B)
//
// Cinq classes, du plus « sentier » au plus « bitume », parce que c'est dans cet
// ordre que ça compte pour un marcheur : savoir qu'un itinéraire fait 6 km d'asphalte
// change la décision d'y aller, bien plus que son D+.
//
// RÈGLE DE CLASSEMENT — on croise TOUJOURS `highway` et `surface`, jamais `surface`
// seule. Couverture mesurée sur la sortie BRouter (cf. brouter.js) : `highway` est
// renseigné à 100 %, `surface` seulement à 27–100 % selon les massifs. Classer sur
// `surface` seule ferait donc disparaître les trois quarts d'un itinéraire alpin ;
// `highway` fournit le socle, `surface` affine quand il est là.
//
// Corollaire assumé : une route sans `surface` reste « Route » et ne devient pas
// « Asphalte ». En Europe elle l'est probablement — mais « probablement » n'est pas
// une donnée, et l'app ne présente jamais une déduction comme un relevé.

export const SURFACE_ORDER = ["sentier", "chemin", "chemin-terre", "route", "asphalte", "autre"];

export const SURFACE_LABEL = {
  sentier: "Sentier",
  chemin: "Chemin",
  "chemin-terre": "Chemin de terre",
  route: "Route",
  asphalte: "Asphalte",
  autre: "Autre",
};

export const SURFACE_HINT = {
  sentier: "Sente étroite, non revêtue",
  chemin: "Piste large, gravier ou terre damée",
  "chemin-terre": "Piste large en terre, herbe ou boue",
  route: "Voie carrossable, revêtement non renseigné",
  asphalte: "Revêtement dur : bitume, béton, pavés",
  autre: "Type de voie non renseigné",
};

// Revêtements durs. `sett`/`cobblestone` (pavés) rejoignent l'asphalte : la classe dit
// « dur sous les pieds », ce qui est l'information utile en rando. `wood` et `metal`
// (passerelles, caillebotis) en sont volontairement exclus — une passerelle sur un
// sentier reste un sentier.
const PAVED = new Set([
  "asphalt", "paved", "concrete", "concrete:plates", "concrete:lanes",
  "paving_stones", "sett", "cobblestone", "unhewn_cobblestone", "chipseal",
]);

const EARTH = new Set(["ground", "dirt", "earth", "mud", "grass", "sand", "soil", "woodchips"]);
const FIRM = new Set(["gravel", "fine_gravel", "compacted", "pebblestone", "rock", "stone"]);

const ROAD_HW = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
  "secondary", "secondary_link", "tertiary", "tertiary_link",
  "unclassified", "residential", "living_street", "service", "road", "pedestrian",
]);

const PATH_HW = new Set(["path", "footway", "bridleway", "steps", "cycleway", "via_ferrata"]);

// tags { highway, surface, tracktype… } → clé de classe (jamais null : « autre » assume
// le trou plutôt que de le maquiller en sentier).
export function classifyWay(tags = {}) {
  const h = String(tags.highway || "").toLowerCase();
  const s = String(tags.surface || "").toLowerCase();

  // Le dur prime sur la nature de la voie : un chemin bitumé se marche comme une route.
  if (PAVED.has(s)) return "asphalte";

  if (h === "track") {
    if (EARTH.has(s)) return "chemin-terre";
    if (FIRM.has(s)) return "chemin";
    // `surface` absent : `tracktype` est le meilleur signal restant (grade4/5 = terre).
    const tt = String(tags.tracktype || "").toLowerCase();
    if (tt === "grade4" || tt === "grade5") return "chemin-terre";
    return "chemin";
  }
  if (ROAD_HW.has(h)) return "route";
  if (PATH_HW.has(h)) return "sentier";
  return h ? "sentier" : "autre";
}

// ways BRouter → bandes contiguës [{ cls, startKm, endKm }], fusionnées par classe.
//
// La position vient du CUMUL des `distM`, pas des lat/lon des messages : c'est la même
// grandeur que l'axe du profil (une distance parcourue), donc les deux ne peuvent pas
// se désaligner. `totalKm` recale la somme sur la distance affichée — le profil est
// tracé sur un échantillon du tracé (~100 points), dont le cumul raccourcit
// légèrement les virages ; sans ce recalage les bandes finiraient avant la courbe.
export function surfaceBands(ways, totalKm) {
  if (!Array.isArray(ways) || !ways.length || !(totalKm > 0)) return null;
  const totalM = ways.reduce((a, w) => a + (w.distM || 0), 0);
  if (!(totalM > 0)) return null;
  const scale = (totalKm * 1000) / totalM;

  const bands = [];
  let m = 0;
  for (const w of ways) {
    if (!(w.distM > 0)) continue;
    const cls = classifyWay(w.tags);
    const startKm = (m * scale) / 1000;
    m += w.distM;
    const endKm = (m * scale) / 1000;
    const last = bands[bands.length - 1];
    if (last && last.cls === cls) last.endKm = endKm;
    else bands.push({ cls, startKm, endKm });
  }
  return bands.length ? bands : null;
}

// bandes → [{ cls, km }] dans l'ordre SURFACE_ORDER, classes absentes omises.
export function surfaceTotals(bands) {
  if (!bands?.length) return [];
  const byCls = new Map();
  for (const b of bands) byCls.set(b.cls, (byCls.get(b.cls) || 0) + (b.endKm - b.startKm));
  return SURFACE_ORDER
    .filter((cls) => byCls.get(cls) > 0.005) // < 5 m : bruit de tag, pas une bande
    .map((cls) => ({ cls, km: byCls.get(cls) }));
}
