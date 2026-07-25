// Sancho Rossi — capteur d'orientation physique, partagé (extrait de S-V2-BOUSSOLE)
//
// Module à abonnés multiples : la vue carte (boussole continue) et le HUD de
// navigation (aiguille du bouton d'orientation) peuvent tous deux demander le cap
// capteur en même temps sans se marcher dessus — le listener navigateur n'est
// attaché qu'une fois (premier abonné) et détaché seulement au dernier départ.
//
// Retour terrain (25/07/2026) : sur Brave/Android le capteur est bloqué par défaut
// (réglage « Motion Sensors » par site, sans prompt contrairement à iOS Safari) —
// pas un bug de l'app, mais on prévient l'utilisateur si aucun évènement n'arrive.
import { toast } from "./toast.js";

const NO_SIGNAL_MS = 5000;

let sensorHeading = null; // dernier cap capteur (0-360°, nord réel) ; null = jamais reçu
let sensorAttached = false;
const subscribers = new Set();
let noSignalTimer = null;
let hintShown = false; // une seule fois par session, pas la peine de persister en localStorage

function onDeviceOrientation(e) {
  let heading;
  if (typeof e.webkitCompassHeading === "number") {
    heading = e.webkitCompassHeading; // iOS : déjà horaire depuis le nord réel
  } else if (e.absolute && e.alpha != null) {
    // Approximation « téléphone à plat » standard + correction si l'écran n'est pas
    // verrouillé portrait (screen.orientation absent sur certains navigateurs → 0).
    heading = (360 - e.alpha + (screen.orientation?.angle ?? 0)) % 360;
  } else {
    return; // orientation relative non calibrée au nord : pas fiable, on ignore
  }
  sensorHeading = (heading + 360) % 360;
  clearTimeout(noSignalTimer);
  noSignalTimer = null;
  subscribers.forEach((cb) => cb(sensorHeading));
}

/**
 * S'abonne au cap capteur. `onHeading(heading)` est rappelé à chaque relevé ; si un
 * cap est déjà connu, l'abonné le reçoit tout de suite (pas besoin d'attendre le
 * prochain évènement physique pour se synchroniser).
 */
export async function startCompass(onHeading) {
  subscribers.add(onHeading);
  if (sensorHeading != null) onHeading(sensorHeading);
  if (sensorAttached) return;

  if (typeof DeviceOrientationEvent?.requestPermission === "function") {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== "granted") return; // refusé : les abonnés restent sur leur repli
    } catch {
      return; // pas de geste utilisateur actif (ex. reprise auto après reload) : on abandonne
    }
  }
  const evt = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
  window.addEventListener(evt, onDeviceOrientation);
  sensorAttached = true;

  if (!hintShown) {
    noSignalTimer = setTimeout(() => {
      hintShown = true;
      toast("Boussole indisponible — vérifiez que les capteurs de mouvement sont autorisés pour ce site dans les réglages du navigateur.", { type: "info" });
    }, NO_SIGNAL_MS);
  }
}

export function stopCompass(onHeading) {
  subscribers.delete(onHeading);
  if (subscribers.size > 0) return;
  window.removeEventListener("deviceorientationabsolute", onDeviceOrientation);
  window.removeEventListener("deviceorientation", onDeviceOrientation);
  sensorAttached = false;
  sensorHeading = null;
  clearTimeout(noSignalTimer);
  noSignalTimer = null;
}

// Plus courte distance angulaire de `current` vers `target` (degrés, non bornés) —
// évite qu'un passage 359°→0° fasse visuellement un tour complet au lieu d'un petit pas.
export function shortestRotate(current, target) {
  const delta = (((target - current) % 360) + 540) % 360 - 180;
  return current + delta;
}
