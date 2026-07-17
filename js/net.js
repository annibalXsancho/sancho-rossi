// Sancho Rossi — couche réseau mutualisée : fetch résilient (S10 Robustesse)
// Toutes les API de l'app sont publiques, gratuites et souvent lentes ou saturées
// (Overpass 429, BRouter « target island », OSRM/Open-Meteo/Nominatim/Commons). Avant
// S10, chaque appel était un fetch unique, sans retry ni (souvent) timeout : un 429
// transitoire suffisait à faire échouer une action. `fetchRetry` centralise :
//   - un TIMEOUT interne homogène (AbortSignal.timeout), combiné au signal externe
//     éventuel (annulation utilisateur : recherche live, requête en vol remplacée) ;
//   - un BACKOFF exponentiel + jitter entre tentatives, respectant `Retry-After` ;
//   - une politique de retry PRUDENTE : on ne retente que ce qui a des chances d'aboutir
//     (réseau/429/5xx/timeout), jamais un 4xx définitif ni un abort volontaire.
// Le module renvoie la Response brute : les appelants lisent .json()/.text() comme avant.

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const BASE_DELAY = 500;   // ms, première attente
const MAX_DELAY = 4000;   // ms, plafond du backoff
const RETRY_AFTER_CAP = 8000; // ms, on n'attend jamais un Retry-After absurde

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Combine le timeout interne et le signal externe. AbortSignal.any propage le premier
// qui s'abat ; si l'API manque (très vieux moteur), on retombe sur le signal externe seul
// et on laisse le fetch sans garde-temps plutôt que d'échouer à l'import.
function combinedSignal(timeout, signal) {
  const t = AbortSignal.timeout(timeout);
  if (!signal) return t;
  return AbortSignal.any ? AbortSignal.any([t, signal]) : signal;
}

// `Retry-After` : soit un nombre de secondes, soit une date HTTP. Renvoie des ms (bornées)
// ou null si l'en-tête est absent/illisible.
function retryAfterMs(res) {
  const h = res.headers.get("Retry-After");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, RETRY_AFTER_CAP);
  const when = Date.parse(h);
  if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), RETRY_AFTER_CAP);
  return null;
}

// Attente avant la tentative n° `attempt` (0-indexée) : backoff exponentiel + jitter ±25 %,
// sauf si le serveur a dicté un délai via Retry-After (prioritaire).
function backoffMs(attempt, forced) {
  if (forced != null) return forced;
  const base = Math.min(BASE_DELAY * 2 ** attempt, MAX_DELAY);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

// fetch avec retry/backoff/timeout.
//   retries  : nombre de RE-tentatives après le premier essai (0 = un seul essai)
//   timeout  : garde-temps par tentative (ms)
//   signal   : signal d'annulation externe (abort volontaire → aucune retente)
//   retryOn  : (res) => bool, pour retenter aussi sur un statut « ok » applicatif
// Lève la dernière erreur (réseau/timeout) ou renvoie la dernière Response non-ok si les
// tentatives sont épuisées — l'appelant garde donc son propre `if (!res.ok)`.
export async function fetchRetry(url, { retries = 2, timeout = 20000, signal, retryOn, ...init } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (attempt > 0) await sleep(backoffMs(attempt - 1, lastErr?.retryAfter));
    try {
      const res = await fetch(url, { ...init, signal: combinedSignal(timeout, signal) });
      const retriable = RETRY_STATUS.has(res.status) || (retryOn && retryOn(res));
      if (retriable && attempt < retries) {
        lastErr = { retryAfter: retryAfterMs(res) };
        continue;
      }
      return res;
    } catch (err) {
      // Abort VOLONTAIRE (signal externe) : ne pas retenter, remonter tel quel.
      if (err?.name === "AbortError" && signal?.aborted) throw err;
      // Sinon (timeout interne ou erreur réseau) : on retentera si le budget le permet.
      lastErr = err;
      if (attempt >= retries) throw err;
    }
  }
  throw lastErr;
}
