// Sancho Rossi — photos réelles des lieux. Graine : articles Wikipédia dédiés
// (it.wikipedia pour les tracés italiens embarqués). Catalogue Europe : géosearch
// Wikimedia Commons (geoPhoto), indépendant de la langue du pays.
import { state, BASE_TRAILS as TRAILS } from "./state.js";
import { renderAll } from "./trails.js";
import { putMeta } from "./storage.js";

const WIKI = {
  "tre-cime-bivouac": "Tre_Cime_di_Lavaredo",
  "braies-fanes": "Lago_di_Braies",
  "gran-paradiso-vittorio": "Gran_Paradiso",
  "sentiero-roma-sud": "Sentiero_Roma",
  "val-grande-traversata": "Parco_nazionale_della_Val_Grande",
  "laghi-gemelli": "Rifugio_Laghi_Gemelli",
  "puez-odle": "Gruppo_delle_Odle",
  "catinaccio-antermoia": "Catinaccio",
  "monviso-tour": "Monviso",
  "devero-veglia": "Alpe_Devero",
  "rosa-ayas-lacs": "Val_d'Ayas",
  "sassolungo-tour": "Sassolungo",
  "sorapis-lago": "Lago_di_Sorapiss",
  "grigna-settentrionale": "Grigna_settentrionale",
  "baldo-crete": "Monte_Baldo",
  "val-genova-cascades": "Val_Genova",
  "marmolada-viel-del-pan": "Marmolada",
};

export function photoOf(trail) {
  return state.photos[trail.id] || trail.image || null;
}

export function photoStyle(trail) {
  const url = photoOf(trail);
  return url
    ? `background-image: url('${url}'), ${trail.gradient};`
    : `background-image: ${trail.gradient};`;
}

export async function loadWikiPhotos() {
  const missing = TRAILS.filter((t) => WIKI[t.id] && !state.photos[t.id]);
  if (!missing.length) return;
  await Promise.allSettled(
    missing.map(async (t) => {
      const res = await fetch(
        `https://it.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(WIKI[t.id])}`
      );
      if (!res.ok) return;
      const data = await res.json();
      const url = data.thumbnail?.source?.split("?")[0];
      if (url) state.photos[t.id] = url;
    })
  );
  putMeta("photos", state.photos);
  renderAll();
}

// Photos des itinéraires du catalogue : image géolocalisée la plus proche du tracé.
// Wikimedia Commons (et non une Wikipédia nationale) → couverture Europe entière,
// indépendante de la langue du pays. On prend la vignette `thumbnail.source` telle
// quelle (pas d'upscale, cf. CLAUDE.md → ERR_BLOCKED_BY_ORB).
export async function geoPhoto(trail) {
  const [lat, lon] = trail.center;
  const url =
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*` +
    `&generator=geosearch&ggsnamespace=6&ggscoord=${lat}%7C${lon}&ggsradius=9000&ggslimit=1` +
    `&prop=imageinfo&iiprop=url&iiurlwidth=480`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status);
  const pages = (await res.json()).query?.pages || {};
  return Object.values(pages)[0]?.imageinfo?.[0]?.thumburl || null;
}

export function updateCardPhotos(trail) {
  document
    .querySelectorAll(`.trail-card[data-id="${trail.id}"] .card-photo`)
    .forEach((el) => (el.style.cssText = photoStyle(trail)));
}
