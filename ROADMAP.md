# Sancho Rossi — Plan de route

## Vision figée (13 juillet 2026)
Outil de rando personnel complet : **préparer partout en Europe depuis le Mac, naviguer sur le terrain au téléphone**. Les deux usages à égalité. Offline complet pour un itinéraire téléchargé. Couverture maximale par chargement à la demande (aucun catalogue embarqué). Hébergement GitHub Pages. Découverte par carte, par lieu, par critères et par suggestions.

L'interface est un objectif produit à part entière : **extrêmement intuitive, belle, fluide, moderne, épurée** — ambiance athlète, nuances de noir, discrétion avec goût (détail dans CLAUDE.md). Ce standard s'applique à chaque sprint touchant l'UI, pas en fin de projet.

## Règles de sprint
- 1 session Claude Code = 1 sprint. Scope fermé, pas de dérive.
- Début de session : lire ce fichier, prendre le premier sprint non coché (sauf indication contraire).
- Fin de sprint : vérification navigateur, cocher ici, `git commit` + `git push`.
- Un sprint qui révèle un problème hors-scope → l'ajouter au backlog ici, ne pas le traiter.

## Sprints

### Fondations
- [x] **S0 — Git + mise en ligne.** *(fait le 13/07/2026 — https://annibalxsancho.github.io/sancho-rossi/)* `git init`, `.gitignore` (.DS_Store, __pycache__), commit de l'état v9, repo GitHub, activer GitHub Pages. Done quand : l'app est accessible en HTTPS depuis le téléphone, géoloc et wake-lock fonctionnent.
- [x] **S1 — Modularisation de app.js.** *(fait le 13/07/2026)* Découpé les 2581 lignes en 14 modules ES natifs + `main.js` (`state`, `api`, `photos`, `weather`, `map`, `filters`, `trails`, `detail`, `osm-live`, `agent`, `builder`, `nav`, `security`, `ui`) chargés via `<script type="module">`. Versionnement par importmap (`?v=`), SW passé en `sr-shell-v3` (liste des modules + purge des anciens caches + `ignoreSearch`). **Zéro changement de comportement** : vérifié dans le navigateur (carte, fiche, météo, filtres, favoris, traceur, agent, sécurité, mobile 375 px, console sans erreur).

### Pivot données « toute l'Europe »
- [x] **S2 — Couche de stockage IndexedDB.** *(fait le 14/07/2026)* Module `storage.js` : base `sancho-rossi` v1, stores `traces` (keyPath id), `meta` (clé-valeur : caches elev/photos), `tiles` (réservé S5) ; primitives `idbGet/getAll/put/delete/clear` + aides `loadPersisted`, `saveTraces`, `putMeta`, `clearAll`. Migration unique et idempotente de `sr-gpx`/`sr-elev`/`sr-photos` depuis localStorage (recopie puis purge des clés) ; fallback localStorage si IndexedDB indisponible. Boot passé en async (`loadPersisted` avant marqueurs/rendu). Les petites prefs (favoris, notes, contacts, thème, calques…) restent en localStorage. Vérifié navigateur : schéma des 3 stores créé, migration bout-en-bout (localStorage purgé → IDB peuplé), tracé importé rendu et persistant, favoris toujours en localStorage, 0 erreur console.
- [ ] **S3 — Chargement à la demande.** Les tracés de la zone visible se chargent via Overpass au déplacement de la carte (comme les POI actuels), cache IndexedDB par tuile de zone, dédup par id de relation OSM. Suppression de `js/data-osm.js` et `scripts/fetch_osm_trails.py`. Done quand : navigation fluide n'importe où en Europe, une zone déjà visitée ne refait pas d'appel réseau.
- [ ] **S4 — « Mes randos ».** Sauvegarder un tracé = copier localement géométrie complète + méta + profil altimétrique. Fusion avec les favoris et circuits custom existants. Done quand : un tracé sauvegardé s'affiche intégralement sans réseau.

### Terrain
- [ ] **S5 — Pack offline itinéraire.** Bouton « Télécharger pour le terrain » sur une rando sauvegardée : corridor de tuiles carte (z12–15 autour du tracé), POI eau/refuges, snapshot météo. Jauge de stockage + suppression de pack dans Réglages. Done quand : mode avion, la rando est pleinement navigable (carte + position + profil + POI).
- [ ] **S6 — Fiabilisation navigation terrain.** Revue du mode GPS/HUD/SURVIVOR avec le HTTPS réel : wake-lock, alerte hors-tracé, veille sécurité ntfy. Test terrain réel. Done quand : une sortie réelle validée sans accroc.

### Découverte
- [ ] **S7 — Recherche par lieu.** Champ « Chamonix, Dolomites… » → géocodage Open-Meteo → la carte s'y déplace et charge les tracés. Done quand : n'importe quel lieu d'Europe est atteignable en une recherche.
- [ ] **S8 — Recherche par critères.** Sur une zone donnée : distance, D+, durée, nb de jours, eau, refuge/bivouac, temps de route depuis ma position. Étend la modale de filtres existante. Done quand : « 2 jours, 25–40 km, point d'eau, < 3 h de route » renvoie des résultats pertinents.
- [ ] **S9 — Suggestions.** Mode « surprends-moi » : propositions selon saison, météo du week-end, historique de favoris. Done quand : l'onglet Accueil propose 3–5 idées pertinentes et datées.

### Consolidation
- [ ] **S10 — Robustesse.** Retries/backoff systématiques sur les API, messages d'erreur utilisateur, états de chargement, audit console sans erreur.
- [ ] **S11 — Performance mobile.** Poids au chargement, fluidité carte sur téléphone, mémoire de la vue 3D.
- [ ] **S12 — Audit UX/design global.** Passage en revue de tous les écrans contre le standard (intuitif, fluide, épuré, nuances de noir) : cohérence des espacements/typo, transitions, états vides et de chargement, gestes mobiles. Done quand : aucun écran ne « sent le prototype ».

## Backlog (réservoir d'idées — pas un engagement)
Règles : une idée = une ligne, ajoutée ici dès qu'elle est exprimée, sans dévier le sprint en cours. Périodiquement (toutes les 3–4 sprints), session de tri : chaque idée est promue en sprint numéroté (avec « done quand »), fusionnée, précisée ou enterrée. Filtres de tri : sert-elle la vision (préparer/naviguer, mono-utilisateur, épuré) ? vaut-elle sa complexité permanente ?
- Textes encore « Italie du Nord » (title de index.html, sous-titres éventuels) → passer au wording Europe.
- Import GPX externe enrichi (fichiers d'autres sources).
- Impression / export PDF d'une fiche rando.
- Multi-jours > 2 (découpage par étapes).

## Décisions actées (ne pas rouvrir sans demande explicite)
- Statique sans Node ; GitHub Pages ; IndexedDB pour le volumineux.
- Catalogue embarqué supprimé au profit du chargement à la demande.
- Mono-utilisateur, pas de social, pas de comptes.
- Identité noir/rouge anguleuse ; exigence UX « intuitif, fluide, épuré » intégrée à chaque sprint (voir CLAUDE.md).
