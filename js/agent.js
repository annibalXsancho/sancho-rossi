// Sancho Rossi — agent local (Accueil) : suggestions heuristiques sans réseau
import { BASE_TRAILS as TRAILS, CATALOG } from "./state.js";
import { cardHTML } from "./trails.js";

const AGENT_REGIONS = {
  dolomites: "Dolomites", aoste: "Val d'Aoste", aosta: "Val d'Aoste",
  lombardie: "Lombardie", piémont: "Piémont", piemont: "Piémont",
  trentin: "Trentin", garde: "Lac de Garde", garda: "Lac de Garde",
};

function agentAnswer(query) {
  const q = query.toLowerCase();
  const wants = {
    bivouac: /bivouac|2 jours|deux jours|nuit|week/.test(q),
    day: /1 jour|journée|demi/.test(q) && !/2 jours/.test(q),
    facile: /facile|tranquille|famille|débutant|pas trop dur|simple/.test(q),
    difficile: /difficile|dur|engagé|alpin|sportif|grosse/.test(q),
    lac: /lac|lago|baignade/.test(q),
    sauvage: /sauvage|isolé|seul|tranquillité|désert/.test(q),
    denivele: /dénivelé|d\+|grimpe/.test(q),
    region: Object.keys(AGENT_REGIONS).find((k) => q.includes(k)),
  };

  const scored = [...TRAILS, ...CATALOG].map((t) => {
    let score = 0;
    const reasons = [];
    if (wants.bivouac && t.bivouac) { score += 4; reasons.push("2 j · bivouac"); }
    if (wants.day && t.days === 1) { score += 4; reasons.push("à la journée"); }
    if (wants.facile) {
      if (t.difficulty === "facile") { score += 3; reasons.push("facile"); }
      else if (t.difficulty === "modéré") { score += 1.5; reasons.push("modéré"); }
      else if (t.difficulty === "difficile") score -= 2;
    }
    if (wants.difficile && t.difficulty === "difficile") { score += 3; reasons.push("engagé"); }
    if (wants.lac && /lac|lago|laghi/i.test(t.name + t.description)) { score += 3; reasons.push("lac"); }
    if (wants.sauvage && /sauvage|isolement|wilderness|à l'écart|fréquentation faible/i.test(t.description)) {
      score += 3; reasons.push("coin sauvage");
    }
    if (wants.denivele) score += (t.elevationGain || 0) / 800;
    if (wants.region && t.region === AGENT_REGIONS[wants.region]) { score += 4; reasons.push(t.region); }
    return { t, score, reasons };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (!scored.length) {
    return {
      text: "Je n'ai rien trouvé d'assez proche. Essayez avec une durée (« 2 jours »), une difficulté ou un massif (Dolomites, Piémont, Val d'Aoste…).",
      trails: [],
    };
  }
  const criteria = [
    wants.bivouac && "bivouac 2 jours", wants.day && "à la journée",
    wants.facile && "niveau accessible", wants.difficile && "engagé",
    wants.lac && "avec lac", wants.sauvage && "sauvage",
    wants.region && AGENT_REGIONS[wants.region],
  ].filter(Boolean).join(", ");
  return {
    text: `D'après vos critères (${criteria || "libres"}), voici mes ${scored.length} suggestions — la première coche ${scored[0].reasons.join(" + ") || "le plus de cases"} :`,
    trails: scored.map((x) => x.t),
  };
}

export function initAgent() {
  const agentInput = document.getElementById("agent-input");
  const agentOutput = document.getElementById("agent-output");

  function runAgent(q) {
    if (!q.trim()) return;
    const { text, trails } = agentAnswer(q);
    agentOutput.innerHTML =
      `<p class="agent-text">${text}</p>` +
      (trails.length ? `<div class="cards-grid">${trails.map(cardHTML).join("")}</div>` : "");
  }

  document.getElementById("agent-send").addEventListener("click", () => runAgent(agentInput.value));
  agentInput.addEventListener("keydown", (e) => { if (e.key === "Enter") runAgent(agentInput.value); });
  document.querySelectorAll(".agent-quick .chip").forEach((c) =>
    c.addEventListener("click", () => { agentInput.value = c.dataset.q; runAgent(c.dataset.q); })
  );
}
