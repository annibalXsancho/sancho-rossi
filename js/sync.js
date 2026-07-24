// Sancho Rossi — synchronisation entre appareils (S-V2-SYNC)
//
// Un dépôt GitHub PRIVÉ sert de coffre JSON, lu/écrit via l'API Contents avec un jeton à
// portée restreinte collé dans Réglages sur chaque appareil (jamais dans le code, jamais
// committé, jamais inclus dans l'export/import JSON de « Mes données »).
//
// Structure du coffre :
//   itineraries/<id>.json  — un fichier par tracé de state.imported (id encodé en URI :
//                             filename-safe même si un id contenait un caractère spécial).
//   marks.json              — tableau complet des repères de terrain (store `marks`).
//   prefs.json               — { favorites, notes, contacts }.
// Pas d'index.json à maintenir à la main : `GET contents/itineraries` renvoie déjà la liste
// avec le sha de chaque fichier, qui sert d'index pour ne retélécharger que ce qui a changé.
//
// Réconciliation « dernier écrit gagne » par unité, horodatage embarqué dans le JSON :
//   - itinéraires : `updatedAt` PAR TRACÉ (posé par les sites de mutation eux-mêmes).
//   - marks.json / prefs.json : un seul fichier, `updatedAt` DE FICHIER (sr-sync-*-touched),
//     réécrit en entier — une suppression locale s'efface d'elle-même dans ce qui est poussé.
// Garde de concurrence : chaque écriture (PUT) porte le dernier `sha` connu ; en cas de
// conflit (409/422, un autre appareil a écrit entretemps) on relit et retente une fois en
// comparant les `updatedAt`.
//
// Suppression d'un itinéraire : un fichier qui n'existe plus localement est ambigu (supprimé
// ici, ou jamais poussé par cet appareil ?) → tombstones légers (sr-sync-tombstones) qui
// déclenchent un DELETE distant tant qu'aucune édition plus récente n'a eu lieu ailleurs.
import { state } from "./state.js";
import { fetchRetry } from "./net.js";
import { idbGet, idbGetAll, idbClear, idbPut, idbDelete, putMeta, saveTraces } from "./storage.js";
import { loadFieldMarks } from "./fieldmarks.js";
import { toast } from "./toast.js";

const API = "https://api.github.com";
const CFG_REPO = "sr-sync-repo";
const CFG_TOKEN = "sr-sync-token";
const LAST_SYNC_KEY = "sr-sync-last";
const TOMBSTONES_KEY = "sr-sync-tombstones";
const MARKS_TOUCHED = "sr-sync-marks-touched";
const MARKS_PUSHED = "sr-sync-marks-pushed";
const PREFS_TOUCHED = "sr-sync-prefs-touched";
const PREFS_PUSHED = "sr-sync-prefs-pushed";

class SyncAuthError extends Error {}

// ---------- Configuration ----------
export function getSyncConfig() {
  const repo = localStorage.getItem(CFG_REPO) || "";
  const token = localStorage.getItem(CFG_TOKEN) || "";
  return { repo, token, configured: !!(repo && token) };
}

function setSyncConfig(repo, token) {
  localStorage.setItem(CFG_REPO, repo);
  localStorage.setItem(CFG_TOKEN, token);
}

// ---------- Marqueurs « à synchroniser » (appelés par les sites de mutation) ----------
export function touchMarks() {
  localStorage.setItem(MARKS_TOUCHED, String(Date.now()));
}
export function touchPrefs() {
  localStorage.setItem(PREFS_TOUCHED, String(Date.now()));
}

function loadTombstones() {
  try { return JSON.parse(localStorage.getItem(TOMBSTONES_KEY) || "[]"); } catch { return []; }
}
function saveTombstones(list) {
  // Cap large mais borné : le jeu réel (randos supprimées) reste minuscule.
  localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(list.slice(-200)));
}
export function tombstoneTrace(id) {
  saveTombstones([...loadTombstones().filter((t) => t.id !== id), { id, deletedAt: Date.now() }]);
}
function clearTombstone(id) {
  saveTombstones(loadTombstones().filter((t) => t.id !== id));
}

// ---------- Base64 UTF-8 (l'API Contents attend du base64 standard) ----------
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// ---------- Bas niveau : API Contents GitHub ----------
let authFailed = false;
function onAuthError() {
  renderSyncStatus();
  if (authFailed) return; // un seul toast, pas un flot à chaque appel en échec
  authFailed = true;
  toast("Jeton GitHub invalide ou expiré — reconfigurez la synchronisation dans Réglages.", {
    type: "error",
    duration: 0,
    action: { label: "Réglages", onClick: () => document.querySelector('[data-view="reglages"]')?.click() },
  });
}

async function gh(path, opts = {}) {
  const { repo, token } = getSyncConfig();
  const url = path ? `${API}/repos/${repo}/${path}` : `${API}/repos/${repo}`;
  const res = await fetchRetry(url, {
    ...opts,
    retries: 2,
    timeout: 15000,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    onAuthError();
    throw new SyncAuthError(`GitHub ${res.status}`);
  }
  return res;
}

async function ghGetFile(path) {
  const res = await gh(`contents/${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} (${path})`);
  const data = await res.json();
  return { sha: data.sha, content: b64decode(data.content) };
}

async function ghListDir(path) {
  const res = await gh(`contents/${path}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub ${res.status} (${path})`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function ghPutFile(path, content, sha, message) {
  const body = { message, content: b64encode(content) };
  if (sha) body.sha = sha;
  const res = await gh(`contents/${path}`, { method: "PUT", body: JSON.stringify(body) });
  if (!res.ok) {
    const err = new Error(`GitHub PUT ${res.status} (${path})`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.content.sha;
}

async function ghDeleteFile(path, sha, message) {
  const res = await gh(`contents/${path}`, { method: "DELETE", body: JSON.stringify({ message, sha }) });
  if (!res.ok && res.status !== 404) throw new Error(`GitHub DELETE ${res.status} (${path})`);
}

async function testConnection() {
  const { repo } = getSyncConfig();
  if (!repo.includes("/")) throw new Error("format attendu : compte/dépôt");
  const res = await gh("");
  if (res.status === 404) throw new Error("dépôt introuvable, ou jeton sans accès à ce dépôt");
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
}

// ---------- Itinéraires (un fichier par tracé, réconciliation par updatedAt) ----------
async function syncItineraries() {
  let changed = false;
  const tombstones = loadTombstones();
  const pendingDeletes = [];

  let list = [];
  try {
    list = await ghListDir("itineraries");
  } catch (err) {
    if (err instanceof SyncAuthError) throw err;
    list = []; // réseau capricieux : on tente quand même le push plus bas
  }

  for (const entry of list) {
    if (!entry.name?.endsWith(".json")) continue;
    const shaKey = `sync:sha:itineraries/${entry.name}`;
    const knownSha = await idbGet("meta", shaKey);
    if (entry.sha === knownSha) continue; // contenu déjà connu, rien à relire
    const remote = await ghGetFile(`itineraries/${entry.name}`);
    if (!remote) continue;
    await putMeta(shaKey, remote.sha);
    let trail;
    try { trail = JSON.parse(remote.content); } catch { continue; }
    const id = decodeURIComponent(entry.name.slice(0, -5));
    const tomb = tombstones.find((t) => t.id === id);
    if (tomb && tomb.deletedAt >= (trail.updatedAt || 0)) {
      pendingDeletes.push(id); // suppression locale toujours valable : purger le distant
      continue;
    }
    if (tomb) clearTombstone(id); // édité ailleurs après notre suppression : l'édition gagne
    const existing = state.imported.find((t) => t.id === id);
    if (!existing || (trail.updatedAt || 0) > (existing.updatedAt || 0)) {
      state.imported = state.imported.filter((t) => t.id !== id);
      state.imported.unshift(trail);
      changed = true;
    }
  }
  if (changed) await saveTraces(state.imported);

  for (const id of pendingDeletes) {
    const name = `${encodeURIComponent(id)}.json`;
    const shaKey = `sync:sha:itineraries/${name}`;
    const sha = await idbGet("meta", shaKey);
    if (sha) {
      try { await ghDeleteFile(`itineraries/${name}`, sha, `sync : suppression ${id}`); }
      catch (err) { if (err instanceof SyncAuthError) throw err; }
    }
    await idbDelete("meta", shaKey);
    clearTombstone(id);
  }

  for (const t of state.imported) {
    if (!t.updatedAt) continue; // jamais touché depuis l'introduction du sync
    const name = `${encodeURIComponent(t.id)}.json`;
    const pushedKey = `sync:pushedAt:itineraries/${name}`;
    const lastPushed = Number((await idbGet("meta", pushedKey)) || 0);
    if (t.updatedAt <= lastPushed) continue; // déjà poussé à jour
    const shaKey = `sync:sha:itineraries/${name}`;
    const sha = await idbGet("meta", shaKey);
    try {
      const newSha = await ghPutFile(`itineraries/${name}`, JSON.stringify(t), sha, `sync : ${t.name || t.id}`);
      await putMeta(shaKey, newSha);
      await putMeta(pushedKey, t.updatedAt);
    } catch (err) {
      if (err instanceof SyncAuthError) throw err;
      if (err.status === 409 || err.status === 422) {
        const remote = await ghGetFile(`itineraries/${name}`);
        let remoteTrail = null;
        if (remote) { try { remoteTrail = JSON.parse(remote.content); } catch {} }
        if (remoteTrail && (remoteTrail.updatedAt || 0) > t.updatedAt) {
          // le distant a gagné la course : on l'adopte plutôt que d'écraser une édition plus récente
          state.imported = state.imported.filter((x) => x.id !== t.id);
          state.imported.unshift(remoteTrail);
          await saveTraces(state.imported);
          await putMeta(shaKey, remote.sha);
          changed = true;
        } else if (remote) {
          const newSha = await ghPutFile(`itineraries/${name}`, JSON.stringify(t), remote.sha, `sync : ${t.name || t.id}`);
          await putMeta(shaKey, newSha);
          await putMeta(pushedKey, t.updatedAt);
        }
      } else {
        console.warn("Push itinéraire échoué :", t.id, err);
      }
    }
  }
  return changed;
}

// ---------- Fichier unique (marks.json / prefs.json), dernier écrit gagne ----------
async function syncMarks() {
  let changed = false;
  let remote = null;
  try { remote = await ghGetFile("marks.json"); }
  catch (err) { if (err instanceof SyncAuthError) throw err; }
  let remoteObj = null;
  if (remote) { try { remoteObj = JSON.parse(remote.content); } catch {} }

  const localTouched = Number(localStorage.getItem(MARKS_TOUCHED) || 0);
  const localPushed = Number(localStorage.getItem(MARKS_PUSHED) || 0);

  if (remoteObj && (remoteObj.updatedAt || 0) > localTouched) {
    await idbClear("marks");
    await Promise.all((remoteObj.marks || []).map((m) => idbPut("marks", m)));
    await loadFieldMarks();
    localStorage.setItem(MARKS_TOUCHED, String(remoteObj.updatedAt));
    localStorage.setItem(MARKS_PUSHED, String(remoteObj.updatedAt));
    await putMeta("sync:sha:marks.json", remote.sha);
    changed = true;
  } else if (localTouched > localPushed) {
    const marks = await idbGetAll("marks");
    const sha = await idbGet("meta", "sync:sha:marks.json");
    try {
      const newSha = await ghPutFile(
        "marks.json",
        JSON.stringify({ updatedAt: localTouched, marks }),
        sha ?? remote?.sha,
        "sync : repères de terrain"
      );
      await putMeta("sync:sha:marks.json", newSha);
      localStorage.setItem(MARKS_PUSHED, String(localTouched));
    } catch (err) {
      if (err instanceof SyncAuthError) throw err;
      console.warn("Push repères échoué :", err);
    }
  }
  return changed;
}

async function syncPrefs() {
  let changed = false;
  let remote = null;
  try { remote = await ghGetFile("prefs.json"); }
  catch (err) { if (err instanceof SyncAuthError) throw err; }
  let remoteObj = null;
  if (remote) { try { remoteObj = JSON.parse(remote.content); } catch {} }

  const localTouched = Number(localStorage.getItem(PREFS_TOUCHED) || 0);
  const localPushed = Number(localStorage.getItem(PREFS_PUSHED) || 0);

  if (remoteObj && (remoteObj.updatedAt || 0) > localTouched) {
    state.favorites = new Set(remoteObj.favorites || []);
    state.notes = remoteObj.notes || {};
    state.contacts = remoteObj.contacts || [];
    localStorage.setItem("sr-favorites", JSON.stringify([...state.favorites]));
    localStorage.setItem("sr-notes", JSON.stringify(state.notes));
    localStorage.setItem("sr-contacts", JSON.stringify(state.contacts));
    localStorage.setItem(PREFS_TOUCHED, String(remoteObj.updatedAt));
    localStorage.setItem(PREFS_PUSHED, String(remoteObj.updatedAt));
    await putMeta("sync:sha:prefs.json", remote.sha);
    changed = true;
  } else if (localTouched > localPushed) {
    const payload = { updatedAt: localTouched, favorites: [...state.favorites], notes: state.notes, contacts: state.contacts };
    const sha = await idbGet("meta", "sync:sha:prefs.json");
    try {
      const newSha = await ghPutFile("prefs.json", JSON.stringify(payload), sha ?? remote?.sha, "sync : préférences");
      await putMeta("sync:sha:prefs.json", newSha);
      localStorage.setItem(PREFS_PUSHED, String(localTouched));
    } catch (err) {
      if (err instanceof SyncAuthError) throw err;
      console.warn("Push préférences échoué :", err);
    }
  }
  return changed;
}

// ---------- Orchestration ----------
let syncing = false;
export async function runSync() {
  if (!getSyncConfig().configured || syncing) return;
  syncing = true;
  let changed = false;
  try {
    changed = (await syncItineraries()) || changed;
    changed = (await syncMarks()) || changed;
    changed = (await syncPrefs()) || changed;
    authFailed = false;
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
    if (changed) window.dispatchEvent(new CustomEvent("sr-sync-changed"));
  } catch (err) {
    if (!(err instanceof SyncAuthError)) {
      console.warn("Synchronisation échouée :", err);
      toast(`Synchronisation impossible : ${err.message || err}.`, { type: "error" });
    }
  } finally {
    syncing = false;
    renderSyncStatus();
  }
}

let debounceTimer = null;
export function scheduleSync() {
  if (!getSyncConfig().configured) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSync, 2500);
}

// ---------- Réglages : statut + câblage du formulaire ----------
function relTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "à l'instant";
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

export function renderSyncStatus() {
  const { repo, configured } = getSyncConfig();
  const repoEl = document.getElementById("sync-repo");
  if (repoEl && document.activeElement !== repoEl) repoEl.value = repo;

  const statusEl = document.getElementById("sync-status");
  if (statusEl) {
    if (!configured) {
      statusEl.textContent = "Non configuré.";
      statusEl.classList.remove("danger-text");
    } else if (authFailed) {
      statusEl.textContent = "🔴 Jeton invalide ou expiré — reconfigurez ci-dessus.";
      statusEl.classList.add("danger-text");
    } else {
      statusEl.textContent = `Connecté à ${repo}.`;
      statusEl.classList.remove("danger-text");
    }
  }

  const lastEl = document.getElementById("sync-last");
  if (lastEl) {
    const last = Number(localStorage.getItem(LAST_SYNC_KEY) || 0);
    lastEl.textContent = last ? `Dernière synchro : ${relTime(last)}` : "Jamais synchronisé.";
  }
}

export function initSync() {
  window.addEventListener("online", () => runSync());

  const repoEl = document.getElementById("sync-repo");
  const tokenEl = document.getElementById("sync-token");
  const connectBtn = document.getElementById("sync-connect");
  const nowBtn = document.getElementById("sync-now");

  connectBtn?.addEventListener("click", async () => {
    const repo = repoEl.value.trim();
    const token = tokenEl.value.trim();
    if (!repo || !token) { toast("Renseignez le dépôt et le jeton.", { type: "error" }); return; }
    connectBtn.disabled = true;
    const prevRepo = getSyncConfig().repo;
    const prevToken = getSyncConfig().token;
    setSyncConfig(repo, token);
    try {
      await testConnection();
      tokenEl.value = "";
      authFailed = false;
      toast("Coffre connecté.", { type: "success" });
      await runSync();
    } catch (err) {
      setSyncConfig(prevRepo, prevToken); // pas de config à moitié cassée en cas d'échec
      toast(`Connexion impossible : ${err.message || err}.`, { type: "error" });
    } finally {
      connectBtn.disabled = false;
      renderSyncStatus();
    }
  });

  nowBtn?.addEventListener("click", async () => {
    if (!getSyncConfig().configured) { toast("Configurez d'abord le dépôt et le jeton.", { type: "error" }); return; }
    nowBtn.disabled = true;
    await runSync();
    if (!authFailed) toast("Synchronisation terminée.", { type: "success" });
    nowBtn.disabled = false;
  });

  renderSyncStatus();
}
