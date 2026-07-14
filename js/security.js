// Sancho Rossi — sécurité : veille automatique ntfy, contacts, position, plan de marche
// Indissociables : planMessage/showPrealert lisent watchTopic + state.contacts.
import { state, BASE_TRAILS as TRAILS, catalogTrails, getTrail, trackOf } from "./state.js";

// ---------- Veille automatique : alerte si aucune activité après l'heure prévue ----------
let watchTopic = localStorage.getItem("sr-topic");
if (!watchTopic) {
  watchTopic = "sancho-" + Math.random().toString(36).slice(2, 10);
  localStorage.setItem("sr-topic", watchTopic);
}
let watch = JSON.parse(localStorage.getItem("sr-watch") || "null");

const ALERT_DELAY_H = 5;    // alerte 5 h après l'heure de retour prévue
const PREWARN_MIN = 30;     // pré-alerte adressée à l'utilisateur 30 min avant

// Toute interaction ou position GPS compte comme signe de vie
let lastActThrottle = 0;
function markActivity() {
  const now = Date.now();
  if (now - lastActThrottle < 30000) return;
  lastActThrottle = now;
  localStorage.setItem("sr-lastact", String(now));
}

function ntfyPush(title, body, priority = "default") {
  return fetch(`https://ntfy.sh/${watchTopic}`, {
    method: "POST",
    body,
    headers: { Title: title, Priority: priority, Tags: "sos,mountain" },
  }).catch(() => {});
}

function saveWatch() {
  localStorage.setItem("sr-watch", JSON.stringify(watch));
  renderWatchStatus();
}

function armWatch() {
  const t = getTrail(document.getElementById("plan-trail").value);
  const date = document.getElementById("plan-date").value;
  const retour = document.getElementById("plan-retour").value;
  if (!t || !date || !retour) { alert("Complétez le plan de marche (itinéraire, date, heure de retour)."); return; }
  const retourMs = new Date(`${date}T${retour}`).getTime();
  watch = {
    armed: true,
    trailName: t.name,
    retour: retourMs,
    deadline: retourMs + ALERT_DELAY_H * 3600000,
    prewarned: false,
    alertSent: false,
  };
  saveWatch();
  ntfyPush("🛡 Veille armée — Sancho Rossi",
    `${t.name} — retour prévu ${new Date(retourMs).toLocaleString("fr-FR")}. ` +
    `Alerte automatique si aucune activité d'ici ${new Date(watch.deadline).toLocaleString("fr-FR")}.`);
}

function disarmWatch(reason) {
  if (!watch) return;
  watch.armed = false;
  saveWatch();
  document.getElementById("prealert").classList.add("hidden");
  ntfyPush("✓ Veille levée — Sancho Rossi", reason || "Tout va bien, veille désarmée.");
}

export function checkWatch() {
  if (!watch?.armed) return;
  const now = Date.now();
  const lastAct = Number(localStorage.getItem("sr-lastact") || 0);

  // Activité après l'heure de retour : tout va bien, la veille se lève seule
  if (lastAct > watch.retour) {
    disarmWatch("Activité détectée après l'heure de retour — veille levée automatiquement.");
    return;
  }
  if (now >= watch.deadline && !watch.alertSent) {
    watch.alertSent = true;
    saveWatch();
    const pos = state.lastPos
      ? `Dernière position connue : https://maps.google.com/?q=${state.lastPos.lat.toFixed(5)},${state.lastPos.lon.toFixed(5)} (${new Date(state.lastPos.ts).toLocaleString("fr-FR")})`
      : "Dernière position inconnue.";
    ntfyPush("🚨 ALERTE — Sancho Rossi",
      `Aucune activité ${ALERT_DELAY_H} h après le retour prévu.\n` +
      `Itinéraire : ${watch.trailName}\nRetour prévu : ${new Date(watch.retour).toLocaleString("fr-FR")}\n${pos}\n` +
      `Prévenir les secours : 112 (118 secours alpin Italie).`, "urgent");
    showPrealert(true);
  } else if (now >= watch.deadline - PREWARN_MIN * 60000 && !watch.prewarned) {
    watch.prewarned = true;
    saveWatch();
    ntfyPush("⚠ Pré-alerte — Sancho Rossi",
      `Aucune activité détectée. Sans confirmation dans les ${PREWARN_MIN} min, l'alerte sera envoyée.`, "high");
    navigator.vibrate?.([300, 100, 300, 100, 300]);
    showPrealert(false);
  }
}

function showPrealert(sent) {
  const el = document.getElementById("prealert");
  document.getElementById("prealert-text").textContent = sent
    ? `L'alerte a été envoyée automatiquement sur ntfy.sh/${watchTopic} (retour prévu dépassé de ${ALERT_DELAY_H} h sans activité). Si c'est une fausse alerte, désarmez et prévenez vos proches.`
    : `Aucune activité détectée depuis votre heure de retour prévue (${new Date(watch.retour).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}). Sans réponse d'ici ${new Date(watch.deadline).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}, l'alerte sera envoyée automatiquement à vos proches.`;
  document.getElementById("prealert-links").innerHTML = sent
    ? state.contacts.map((c) => {
        const msg = encodeURIComponent(`FAUSSE ALERTE / ou besoin d'aide — ${watch.trailName}. ${planMessage()}`);
        const href = c.channel === "whatsapp" ? `https://wa.me/${c.addr.replace(/[^\d]/g, "")}?text=${msg}`
          : c.channel === "sms" ? `sms:${c.addr}?body=${msg}`
          : `mailto:${c.addr}?body=${msg}`;
        return `<a class="btn" href="${href}" target="_blank" rel="noopener">📤 ${c.name}</a>`;
      }).join("")
    : "";
  el.classList.remove("hidden");
}

function renderWatchStatus() {
  const statusEl = document.getElementById("watch-status");
  const btn = document.getElementById("btn-arm-watch");
  const link = document.getElementById("watch-topic-link");
  link.textContent = `ntfy.sh/${watchTopic}`;
  link.href = `https://ntfy.sh/${watchTopic}`;
  if (watch?.armed) {
    statusEl.innerHTML = `🛡 <strong>Veille armée</strong> — ${watch.trailName}, alerte auto le
      ${new Date(watch.deadline).toLocaleString("fr-FR", { weekday: "short", hour: "2-digit", minute: "2-digit" })} sans activité.`;
    btn.textContent = "Désarmer";
  } else {
    statusEl.textContent = watch?.alertSent ? "Alerte envoyée puis veille désarmée." : "Veille désarmée.";
    btn.textContent = "🛡 Armer la veille";
  }
}

// ---------- Sécurité : contacts, position, plan de marche ----------
export function saveContacts() {
  localStorage.setItem("sr-contacts", JSON.stringify(state.contacts));
}

function renderContacts() {
  const el = document.getElementById("contacts-list");
  el.innerHTML = state.contacts.length
    ? state.contacts
        .map(
          (c) => `
      <div class="contact-row">
        <span><strong>${c.name}</strong> · ${c.channel === "whatsapp" ? "WhatsApp" : c.channel === "sms" ? "SMS" : "E-mail"} · ${c.addr}</span>
        <button class="btn btn-danger" data-del-contact="${c.id}">✕</button>
      </div>`
        )
        .join("")
    : `<p class="muted">Aucun contact pour l'instant — ajoutez au moins une personne de confiance.</p>`;
  el.querySelectorAll("[data-del-contact]").forEach((b) =>
    b.addEventListener("click", () => {
      state.contacts = state.contacts.filter((c) => c.id !== b.dataset.delContact);
      saveContacts();
      renderSafety();
    })
  );
}

// Position
let watchId = null;

export function savePos(pos) {
  markActivity(); // une position GPS vaut signe de vie pour la veille
  state.lastPos = {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    acc: Math.round(pos.coords.accuracy),
    ts: Date.now(),
  };
  localStorage.setItem("sr-lastpos", JSON.stringify(state.lastPos));
  renderPos();
  renderPlanPreview();
}

function renderPos() {
  const el = document.getElementById("last-pos");
  if (!state.lastPos) { el.textContent = "Aucune position enregistrée."; return; }
  const d = new Date(state.lastPos.ts);
  el.innerHTML = `Dernière position : <strong>${state.lastPos.lat.toFixed(5)}, ${state.lastPos.lon.toFixed(5)}</strong>
    (±${state.lastPos.acc} m) à ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
}

// Plan de marche
function planMessage() {
  const t = getTrail(document.getElementById("plan-trail").value);
  if (!t) return "";
  const date = document.getElementById("plan-date").value;
  const retour = document.getElementById("plan-retour").value;
  const gain = t.elevationGain ?? state.elev[t.id]?.gain;
  const start = trackOf(t)[0];
  const dateFr = date
    ? new Date(date + "T00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })
    : "(date à préciser)";
  const posLine = state.lastPos
    ? `Ma dernière position connue : https://maps.google.com/?q=${state.lastPos.lat.toFixed(5)},${state.lastPos.lon.toFixed(5)} (à ${new Date(state.lastPos.ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}, ±${state.lastPos.acc} m)`
    : "Ma dernière position connue : non disponible pour l'instant";
  return `🥾 PLAN DE MARCHE — Sancho Rossi
Itinéraire : ${t.name} (${t.location}, ${t.region})
${t.distance} km · ${gain ? Math.round(gain) + " m D+ · " : ""}${t.duration}${t.bivouac ? " · nuit en bivouac" : ""}
Date : ${dateFr} — retour prévu à ${retour}
Point de départ : https://maps.google.com/?q=${start[0].toFixed(5)},${start[1].toFixed(5)}
${posLine}
🔔 Abonne-toi à mon canal d'alerte automatique : https://ntfy.sh/${watchTopic} (application ou site ntfy — tu recevras une notification si je ne donne pas signe de vie)
⚠️ Sans nouvelles de moi 2 h après l'heure de retour prévue, appelle les secours : 112 (ou 118 secours alpin Italie) en indiquant ce message.`;
}

function renderPlanPreview() {
  const preview = document.getElementById("plan-preview");
  preview.value = planMessage();
  const btns = document.getElementById("plan-share-buttons");
  const msg = encodeURIComponent(preview.value);
  const canNative = !!navigator.share;
  btns.innerHTML =
    state.contacts
      .map((c) => {
        const href =
          c.channel === "whatsapp" ? `https://wa.me/${c.addr.replace(/[^\d]/g, "")}?text=${msg}`
          : c.channel === "sms" ? `sms:${c.addr}?body=${msg}`
          : `mailto:${c.addr}?subject=${encodeURIComponent("Plan de marche — Sancho Rossi")}&body=${msg}`;
        return `<a class="btn btn-primary" href="${href}" target="_blank" rel="noopener">📤 ${c.name}</a>`;
      })
      .join("") +
    (canNative ? `<button class="btn" id="btn-native-share">Partager…</button>` : "") +
    `<button class="btn" id="btn-copy-plan">Copier</button>`;
  document.getElementById("btn-native-share")?.addEventListener("click", () =>
    navigator.share({ title: "Plan de marche", text: preview.value }).catch(() => {})
  );
  document.getElementById("btn-copy-plan").addEventListener("click", async () => {
    await navigator.clipboard.writeText(preview.value);
    document.getElementById("btn-copy-plan").textContent = "✓ Copié";
  });
}

export function renderSafety() {
  renderContacts();
  renderPos();
  renderWatchStatus();
  const sel = document.getElementById("plan-trail");
  const current = sel.value;
  const opts = [...state.imported, ...TRAILS, ...catalogTrails()];
  const favs = opts.filter((t) => state.favorites.has(t.id));
  const rest = opts.filter((t) => !state.favorites.has(t.id));
  sel.innerHTML =
    (favs.length ? `<optgroup label="♥ Enregistrés">${favs.map((t) => `<option value="${t.id}">${t.name}</option>`).join("")}</optgroup>` : "") +
    `<optgroup label="Tous les itinéraires">${rest.map((t) => `<option value="${t.id}">${t.name}</option>`).join("")}</optgroup>`;
  if (current && getTrail(current)) sel.value = current;
  if (!document.getElementById("plan-date").value) {
    document.getElementById("plan-date").value = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  }
  renderPlanPreview();
}

export function initSecurity() {
  ["pointerdown", "keydown", "touchstart"].forEach((evt) =>
    document.addEventListener(evt, markActivity, { capture: true, passive: true })
  );

  document.getElementById("prealert-ok").addEventListener("click", () => {
    markActivity();
    disarmWatch("Confirmation « je vais bien » reçue.");
  });

  document.getElementById("btn-arm-watch").addEventListener("click", () => {
    if (watch?.armed) disarmWatch("Veille désarmée manuellement.");
    else armWatch();
  });

  document.getElementById("btn-copy-topic").addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(`https://ntfy.sh/${watchTopic}`);
    e.target.textContent = "✓ Copié";
    setTimeout(() => (e.target.textContent = "Copier le lien"), 1600);
  });

  setInterval(checkWatch, 60000);
  document.addEventListener("visibilitychange", checkWatch);

  document.getElementById("btn-add-contact").addEventListener("click", () => {
    const name = document.getElementById("contact-name").value.trim();
    const channel = document.getElementById("contact-channel").value;
    const addr = document.getElementById("contact-addr").value.trim();
    if (!name || !addr) { alert("Nom et coordonnée (numéro ou e-mail) requis."); return; }
    state.contacts.push({ id: Math.random().toString(36).slice(2, 9), name, channel, addr });
    saveContacts();
    document.getElementById("contact-name").value = "";
    document.getElementById("contact-addr").value = "";
    renderSafety();
  });

  document.getElementById("btn-track-pos").addEventListener("click", (e) => {
    const status = document.getElementById("pos-status");
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      status.textContent = "Suivi GPS désactivé.";
      e.target.textContent = "Activer le suivi";
      return;
    }
    if (!navigator.geolocation) { status.textContent = "Géolocalisation non supportée."; return; }
    watchId = navigator.geolocation.watchPosition(savePos,
      (err) => (status.textContent = `Erreur GPS : ${err.message}`),
      { enableHighAccuracy: true, maximumAge: 30000 });
    status.textContent = "Suivi GPS actif — la dernière position est enregistrée en continu.";
    e.target.textContent = "Désactiver le suivi";
  });

  document.getElementById("btn-refresh-pos").addEventListener("click", () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(savePos, (err) =>
      (document.getElementById("pos-status").textContent = `Erreur GPS : ${err.message}`),
      { enableHighAccuracy: true });
  });

  ["plan-trail", "plan-date", "plan-retour"].forEach((id) =>
    document.getElementById(id).addEventListener("change", renderPlanPreview)
  );
}
