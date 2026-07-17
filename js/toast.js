// Sancho Rossi — toasts (S10 Robustesse)
// Remplace les alert() natifs (bloquants, hors identité) par des notifications discrètes à
// l'esthétique de l'app : nuances de noir translucides, liseré rouge en cas d'erreur, angles
// vifs, entrée/sortie ease-out. Les vraies décisions oui/non (reset, téléchargement de pack)
// gardent un confirm() natif — un toast n'est PAS une porte de décision.
// Host ancré en bas, au-dessus de la tab-nav en mobile (jamais un bouton flottant bas d'écran).

const DEFAULT_MS = 4200;

function host() {
  let el = document.getElementById("toast-host");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast-host";
    el.className = "toast-host";
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  return el;
}

// Montage explicite au boot (idempotent) — appelé par main.js.
export function initToast() {
  host();
}

// toast(message, { type: "info" | "error" | "success", duration }) → fonction de fermeture.
export function toast(message, { type = "info", duration = DEFAULT_MS } = {}) {
  const root = host();
  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");

  const msg = document.createElement("span");
  msg.className = "toast__msg";
  msg.textContent = message;

  const close = document.createElement("button");
  close.className = "toast__close";
  close.type = "button";
  close.setAttribute("aria-label", "Fermer");
  close.textContent = "✕";

  el.append(msg, close);
  root.appendChild(el);

  let timer;
  let removed = false;
  const dismiss = () => {
    if (removed) return;
    removed = true;
    clearTimeout(timer);
    el.classList.remove("show");
    el.classList.add("leaving");
    // Retire après la transition ; filet de sécurité si transitionend ne se déclenche pas.
    const done = () => el.remove();
    el.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 320);
  };

  close.addEventListener("click", dismiss);
  // Entrée à la frame suivante pour laisser la transition partir de l'état initial.
  requestAnimationFrame(() => el.classList.add("show"));
  if (duration > 0) timer = setTimeout(dismiss, duration);

  return dismiss;
}
