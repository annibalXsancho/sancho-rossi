# Sancho Rossi

Outil de randonnée personnel (mono-utilisateur, pas de social) : découvrir et préparer des itinéraires partout en Europe depuis le Mac, puis naviguer sur le terrain au téléphone — itinéraire téléchargé, carte hors-ligne, GPS, veille sécurité. Sans compte, sans abonnement, sans serveur applicatif. Le bivouac 2 jours est un filtre parmi d'autres ; la liberté de choix est le principe directeur.

## Contraintes machine (non négociables)
- **Pas de Node/npm/Homebrew.** App 100 % statique HTML/CSS/JS. Libs via CDN, modules ES natifs. Vérifier `which npm` avant de proposer un build — ne pas proposer de scaffold Node/React.
- Serveur dev : `python3 -m http.server` (config `.claude/launch.json`). Preview via **127.0.0.1**, pas localhost (échec IPv6).
- Python 3.14 dispo, sans Pillow ni certificats SSL (utiliser `curl` pour le HTTP dans les scripts).
- Déploiement : GitHub Pages via `git push` (HTTPS requis pour géoloc et wake-lock).

## Architecture
- `index.html` — structure, onglets Accueil / Carte / Itinéraires / Réglages + Sécurité.
- `css/style.css` — tout le style.
- `js/` — logique (découpage en modules ES prévu au sprint S1, voir ROADMAP.md).
- `js/viewer3d.js` — vue 3D Three.js (importmap CDN, terrain Terrarium, texture Esri).
- Stockage : localStorage clés `sr-*` pour les petites préférences ; **IndexedDB pour tout objet volumineux** (tracés sauvegardés, tuiles offline) — localStorage plafonne à ~5 Mo.
- Données tracés : **chargées à la demande via Overpass selon la zone visible**, avec cache persistant. Aucun catalogue embarqué.

## APIs (toutes gratuites, sans clé, couverture Europe)
- **Overpass** (tracés + POI) : `relation["route"="hiking"](bbox);out geom N;` — jamais `out tags geom` (syntaxe invalide). Miroir kumi.systems + `AbortSignal.timeout(25s)` ; 429 fréquents sur overpass-api.de.
- **Open-Meteo** : météo (daily+hourly), géocodage **de villes** (météo sur la route, `weather.js`), Elevation (**max 100 pts/req**). Champs conditions (`conditions.js`, S-CONDITIONS) : `freezing_level_height`, `snow_depth`, `cape`, `precipitation_sum` avec `past_days=3`, `uv_index_max` ; `elevation=` par point pour descendre la T° à l'altitude réelle du tracé.
- **Air Quality API** (air-quality-api.open-meteo.com/v1/air-quality) : gratuite sans clé, `european_aqi` + `uv_index` + pollens CAMS (`grass_pollen`, `birch_pollen`, `alder_pollen`, `olive_pollen`, `ragweed_pollen`, `mugwort_pollen`). Pollens = **CAMS Europe uniquement** → `null` hors zone (le badge disparaît, jamais d'invention). Best-effort dans `conditions.js` : une panne masque seulement air/UV/pollens.
- **Nominatim** (nominatim.openstreetmap.org, `format=jsonv2&addressdetails=1`) : géocodage **par lieu** de la recherche carte (`geosearch.js`, S7). Choisi contre Open-Meteo qui triait par population et égarait les massifs (« Mont Blanc » → Maurice, « Dolomites » → barrage du Montana). Couvre les reliefs européens + renvoie une `boundingbox` pour cadrer la vue. Politique ≤ 1 req/s → débounce 500 ms + requête annulée à chaque frappe (mono-utilisateur = OK).
- **BRouter** (brouter.de, `profile=hiking-mountain`) : routage rando, altitudes en 3e coordonnée, CORS ouvert.
- **OSRM** (router.project-osrm.org) : temps de route voiture.
- **Wikipédia geosearch** : photos de lieux — utiliser `thumbnail.source` tel quel, **jamais d'upscale 640px** (ERR_BLOCKED_BY_ORB). File d'attente 350 ms.
- **RainViewer** : radar pluie (URL horodatée via weather-maps.json).

## Identité graphique & UX — v2 (choix utilisateur, révisée le 17/07/2026, ne pas dévier)
L'exigence esthétique fait partie du produit : interface **belle, fluide, moderne, épurée** — rien d'archaïque, rien qui « sente le prototype », un niveau de finition **au-dessus d'AllTrails**. *(La v1 « athlète » — angles 2px, encadrés 1px, capitales espacées partout — a été abandonnée sur demande utilisateur : trop de boîtes, pas assez travaillée.)*
- Thème **noir** par défaut (#0b0b0c) en **nuances de noir** : la hiérarchie passe par la **valeur des surfaces et les ombres douces** (`--shadow-soft`), **jamais par des bordures** — plus aucun encadré 1px autour des contrôles. Accent **rouge vif #ff2d20** unique ; le **plein rouge est réservé à l'action primaire** (un seul par écran). Le vert AllTrails est banni.
- **Angles adoucis** : tokens `--radius` 10px (contrôles) / `--radius-lg` 16px (cartes, panneaux) / `--radius-full` (chips, pills, recherche). Espacement sur l'échelle `--sp-1..5`.
- **Boutons en 3 poids** : plein (primaire), **tonal** `--surface-2/3` (secondaire), texte `.btn-ghost` (tertiaire). Micro-interactions tactiles : soulèvement au survol, tassement au clic (`prefers-reduced-motion` respecté).
- **Capitales espacées réservées aux micro-étiquettes** (eyebrows, légendes de stats, titres de section, menu header) — boutons, chips et onglets en casse normale. Surfaces translucides `color-mix` + `backdrop-blur` conservées.
- Bandeaux d'info de fiche/planificateur : toujours via la primitive **`.info-block`** (+ `.eyebrow`), jamais de présentation ad hoc.
- **Intuitif d'abord** : toute action courante en 1–2 gestes, sans mode d'emploi. Si une fonction a besoin d'être expliquée, c'est le design qui est faux.
- **Fluide** : transitions/micro-animations discrètes (150–250 ms, ease-out), jamais de saut de layout, états de chargement élégants (squelettes, pas de spinners bruts).
- Épuré : chaque écran montre peu ; le secondaire est accessible, pas affiché. En cas de doute, retirer.
- Chaque sprint qui touche l'UI doit livrer à ce niveau — le polish n'est pas une étape « plus tard ».

## Méthode de travail
- **`git fetch origin` AVANT de lire ROADMAP.md**, en tout début de session. Le travail se fait depuis plusieurs machines : le ROADMAP local peut être en retard sur `origin/main` et annoncer comme « à faire » un sprint déjà livré. Comparer `git log --oneline main..origin/main` avant d'annoncer le prochain sprint. *(Le 16/07/2026, S8 et S9 étaient faits sur le distant et ont été annoncés comme disponibles ; découvert seulement au push de S-PLAN-A, qui a dû être fusionné après coup.)*
- **1 session = 1 sprint = 1 scope fermé**, défini dans `ROADMAP.md`. Lire ROADMAP.md en début de session ; en fin de sprint : vérifier dans le navigateur, cocher la case, committer.
- Mode Plan avant tout sprint non trivial.
- Cache-buster `?v=` sur les JS modifiés (`http.server` n'envoie pas de headers de cache).
- Ne jamais lire un fichier de données généré en entier (ex-data-osm.js pesait 2 Mo).

## Pièges résolus — ne pas retomber dedans
- Segments des relations OSM **désordonnés** → chaînage `orderSegments()` obligatoire, sinon D+ triplé.
- 3D : UV de texture calés sur la bbox (pas la mosaïque) ; en occlusion la caméra **pivote** autour de la cible (crans 10°) — jamais de dézoom ni surélévation (refus utilisateur).
- Géoloc/wake-lock bloqués en HTTP non sécurisé.
- `import()` dynamique dans un script classique se résout par rapport à l'URL du script.
- Mobile ≤700 px : tab-nav en bas, bottom-sheets, aucun bouton flottant en bas d'écran.
- **Tuiles carto = réponses opaques cross-origin** (fetch `no-cors`) : le script ne peut PAS lire leurs octets → **impossible en IndexedDB** ; seul le **Cache Storage** les détient (packs offline `sr-pack-<id>`). Clé de cache **normalisée** (sous-domaine `{s}` retiré) identique côté page et SW, sinon Leaflet (a/b/c rotatif) rate l'entrée. Taille par tuile inaccessible → jauge via `navigator.storage.estimate()`.
