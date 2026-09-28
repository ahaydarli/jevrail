const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MODEL = "jev-latest";

// One call, any questions. Returns { answers, ms, model } or null on any failure:
// callers treat null as "Jev had nothing to say" and fall back.
export async function ask(state, questions, { fetchImpl = fetch, apiKey, timeoutMs = 4000, model = MODEL } = {}) {
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, state, questions }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json();
    return { answers: body.answers ?? {}, ms: performance.now() - started, model: body.model ?? model };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Flatten one answer so rules can read `risk`, `risk.confidence`, `risk.p.block`.
export function flatten(answer) {
  if (!answer || typeof answer !== "object") return undefined;
  if (answer.type === "noul") return { value: answer.noul, confidence: Math.abs(answer.noul - 0.5) * 2 };
  if (answer.type === "choice") return { value: answer.choice, confidence: answer.confidence, p: answer.probabilities ?? {} };
  if (answer.type === "score") return { value: answer.score, confidence: answer.confidence, p: answer.probabilities ?? {} };
  return undefined;
}

// --- memory capture -------------------------------------------------------

export const MEMORY_QUESTIONS = {
  decision: {
    type: "noul",
    instructions: "Is the user stating a project decision that later sessions should remember?",
  },
  constraint: {
    type: "noul",
    instructions: "Is the user stating a hard constraint or rule for this project?",
  },
  bug: {
    type: "noul",
    instructions: "Is the user reporting a bug or broken behavior that later sessions should remember?",
  },
  chatter: {
    type: "noul",
    instructions: "Is this small talk, a greeting, or a one-off command with nothing worth remembering?",
  },
};

export function classify(answers, { saveAt = 0.7, chatterAt = 0.6 } = {}) {
  const chatter = answers.chatter ?? 0;
  if (chatter >= chatterAt) return null;
  const ranked = ["decision", "constraint", "bug"]
    .map((kind) => ({ kind, score: answers[kind] ?? 0 }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < saveAt) return null;
  return best.kind;
}

export async function askMemory(text, options) {
  const result = await ask(text, MEMORY_QUESTIONS, { timeoutMs: 3000, ...options });
  if (!result) return null;
  const read = (key) => result.answers[key]?.noul ?? 0;
  return { decision: read("decision"), constraint: read("constraint"), bug: read("bug"), chatter: read("chatter") };
}
