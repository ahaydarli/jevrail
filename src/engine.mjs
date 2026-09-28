// Rule engine: pick the rules that apply to an event, ask Jev all their
// questions in one call, and turn the answers into one decision.
import { homedir } from "node:os";
import path from "node:path";
import { cacheGet, cacheKey, cachePut, logDecision } from "./cache.mjs";
import { classifyFile, classifyTamper } from "./files.mjs";
import { classifyMcp, classifyOutbound, classifyUntrusted, responseText } from "./tools.mjs";
import { ask, flatten, MODEL } from "./jev.mjs";
import { scrubText } from "./memory.mjs";
import { classifyShell } from "./shell.mjs";

// "warn" adds a note for Claude and the user but stops nothing; it is what
// rules can do after a tool already ran.
const SEVERITY = { allow: 0, warn: 1, ask: 2, deny: 3 };
const MAX_STATE = 8000;

export const PREFILTERS = {
  "risky-shell": (event) => {
    const { risky, reasons } = classifyShell(event.command);
    return { look: risky, reasons };
  },
  "risky-file": classifyFile,
  tamper: classifyTamper,
  outbound: classifyOutbound,
  "risky-mcp": classifyMcp,
  untrusted: classifyUntrusted,
};

function applies(rule, event) {
  if (rule.on !== event.event) return false;
  if (Array.isArray(rule.tools) && !rule.tools.includes(event.tool)) return false;
  return true;
}

function tildify(dir) {
  const home = homedir();
  return dir && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
}

// Lines that talk to or about an AI reader are kept even from the middle of
// a long page, so an injection can't hide past the part Jev sees.
const ADDRESSED = /\b(?:ai|assistant|agent|llm|claude|copilot|gpt|chatgpt|gemini|model|instructions?|system prompt|ignore (?:all|any|previous|prior))\b|<\/?system>/i;

// Long content: the start, suspicious lines from the middle, and the end.
function excerpt(text) {
  if (text.length <= MAX_STATE) return text;
  const head = text.slice(0, 4000);
  const tail = text.slice(-2000);
  const middle = text.slice(4000, -2000).split("\n").filter((line) => ADDRESSED.test(line));
  let picked = "";
  for (const line of middle) {
    if (picked.length + line.length > 2000) break;
    picked += `${line.slice(0, 600)}\n`;
  }
  return `${head}\n[…]\n${picked}[…]\n${tail}`;
}

// What Jev sees. Secrets are scrubbed here, before anything leaves the machine.
export function stateFor(event) {
  const clip = (text) => scrubText(text).slice(0, MAX_STATE);
  if (event.event === "pre_tool" && event.tool === "shell") {
    const state = { command: clip(event.command), cwd: tildify(event.cwd ?? "") };
    // what the local parser noticed, e.g. "uses a secret environment variable"
    if (event.signals?.length) state.noticed = event.signals;
    return state;
  }
  if (event.event === "pre_tool") {
    const state = { tool: event.toolName, input: clip(JSON.stringify(event.toolInput ?? {})), cwd: tildify(event.cwd ?? "") };
    if (event.mcp) Object.assign(state, { server: event.mcp.server, action: event.mcp.action });
    if (event.signals?.length) state.noticed = event.signals;
    return state;
  }
  if (event.event === "post_tool") {
    const input = event.toolInput ?? {};
    const from = event.tool === "shell" ? event.command : input.url ?? input.query ?? event.mcp?.server ?? "";
    return { tool: event.toolName, from: clip(String(from)).slice(0, 500), content: excerpt(scrubText(responseText(event.toolResponse))) };
  }
  if (event.event === "prompt") return clip(event.prompt ?? "");
  if (event.event === "stop") return clip(event.lastMessage ?? "");
  return clip(JSON.stringify(event.raw ?? {}));
}

// What the decision was about, for the log: the command or the file.
function target(event) {
  if (event.tool === "shell") return scrubText(event.command ?? "").slice(0, 300);
  const input = event.toolInput ?? {};
  if (event.tool === "web") return scrubText(input.url ?? input.query ?? "").slice(0, 300);
  if (event.tool === "mcp") return event.toolName;
  const file = input.file_path ?? input.notebook_path ?? input.path;
  if (!file) return event.toolName ?? "";
  const root = event.projectDir || event.cwd;
  const relative = root ? path.relative(root, path.resolve(root, file)) : "";
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : tildify(file);
}

function read(answers, where) {
  const [name, field, option] = String(where).split(".");
  const answer = answers[name];
  if (!answer) return undefined;
  if (!field) return answer.value;
  if (field === "confidence") return answer.confidence;
  if (field === "p") return answer.p?.[option];
  return undefined;
}

function test(actual, op, expected) {
  switch (op) {
    case "is": case "==": return actual === expected;
    case "not": case "!=": return actual !== expected;
    case "in": return Array.isArray(expected) && expected.includes(actual);
    case ">=": return typeof actual === "number" && actual >= expected;
    case ">": return typeof actual === "number" && actual > expected;
    case "<=": return typeof actual === "number" && actual <= expected;
    case "<": return typeof actual === "number" && actual < expected;
    default: return false;
  }
}

export function decideRule(rule, answers, { canPrompt = true } = {}) {
  for (const row of rule.decide) {
    const when = Array.isArray(row.when) ? row.when : [];
    if (!when.every(([where, op, value]) => test(read(answers, where), op, value))) continue;
    let decision = row.then;
    if (decision === "ask" && !canPrompt) decision = row.unattended ?? "deny";
    if (!(decision in SEVERITY)) decision = "allow";
    return { decision, reason: row.reason ?? "" };
  }
  return { decision: "allow", reason: "" };
}

export function summarize(answers) {
  return Object.entries(answers)
    .filter(([, answer]) => answer)
    .map(([name, answer]) => {
      if (typeof answer.value !== "string") return `${name}=${Number(answer.value).toFixed(2)}`;
      // rules can read other options' probabilities, so show a close runner-up
      const runnerUp = Object.entries(answer.p ?? {})
        .filter(([option, p]) => option !== answer.value && p >= 0.2)
        .map(([option, p]) => `, ${option} p=${p.toFixed(2)}`)
        .join("");
      return `${name}=${answer.value} (${Math.round((answer.confidence ?? 0) * 100)}%${runnerUp})`;
    })
    .join(", ");
}

// Keep the strictest verdict; the first rule to decide sets the reason on a tie.
function record(result, id, verdict, summary = "") {
  result.rules.push({ id, ...verdict, summary });
  if (result.rule === null || SEVERITY[verdict.decision] > SEVERITY[result.decision]) {
    Object.assign(result, { decision: verdict.decision, reason: verdict.reason, rule: id, summary });
  }
}

export async function evaluate(event, { rules, apiKey, fetchImpl, onError = "allow", stateDir, useCache = true, log = true } = {}) {
  const result = { decision: "allow", reason: "", rule: null, summary: "", local: [], rules: [], cached: false, ms: 0, called: false };
  const canPrompt = event.canPrompt !== false;
  const decidedHere = [];
  const forJev = [];
  for (const rule of rules) {
    if (!applies(rule, event)) continue;
    let reasons = [];
    if (rule.prefilter) {
      const check = PREFILTERS[rule.prefilter];
      const verdict = check ? check(event) : { look: true, reasons: [] };
      result.local.push(...verdict.reasons);
      if (!verdict.look) continue;
      reasons = verdict.reasons;
    }
    if (Object.keys(rule.ask ?? {}).length === 0) decidedHere.push({ rule, reasons });
    else forJev.push(rule);
  }
  // rules that share a prefilter report the same reasons
  result.local = [...new Set(result.local)];

  // Rules without questions are decided here: no key, no network, no latency.
  for (const { rule, reasons } of decidedHere) {
    const verdict = decideRule(rule, {}, { canPrompt });
    record(result, rule.id, { ...verdict, reason: verdict.reason || reasons.join("; ") });
  }
  const done = async (extra = {}) => {
    if (log && (extra.jev || result.decision !== "allow")) {
      await logDecision(
        {
          event: event.event, tool: event.tool, target: target(event), state: stateFor(event),
          decision: result.decision, rule: result.rule, reason: result.reason, summary: result.summary,
          jev: Boolean(extra.jev), cached: result.cached, ms: result.ms, ...(extra.error ? { error: true } : {}),
        },
        stateDir,
      );
    }
    return result;
  };
  // Nothing Jev says can make a deny stricter.
  if (forJev.length === 0 || result.decision === "deny") return done();
  if (!apiKey) {
    if (result.rule === null) result.reason = "no TYPESAFE_API_KEY; skipped";
    return done();
  }

  if (result.local.length) event = { ...event, signals: result.local };
  const state = stateFor(event);
  const questions = {};
  forJev.forEach((rule, i) => {
    for (const [name, question] of Object.entries(rule.ask)) questions[`r${i}_${name}`] = question;
  });

  const key = cacheKey({ model: MODEL, state, questions });
  let raw = useCache ? await cacheGet(key, stateDir) : null;
  if (raw) {
    result.cached = true;
  } else {
    result.called = true;
    const response = await ask(state, questions, { apiKey, fetchImpl });
    if (!response) {
      // a local verdict stands; otherwise fall back to onError
      const fallback = onError === "ask" && canPrompt ? "ask" : "allow";
      if (result.rule === null || SEVERITY[fallback] > SEVERITY[result.decision]) {
        Object.assign(result, { decision: fallback, reason: "Jev unavailable" });
      }
      return done({ jev: true, error: true });
    }
    raw = response.answers;
    result.ms = Math.round(response.ms);
    if (useCache) await cachePut(key, raw, stateDir).catch(() => {});
  }

  forJev.forEach((rule, i) => {
    const answers = {};
    for (const name of Object.keys(rule.ask)) answers[name] = flatten(raw[`r${i}_${name}`]);
    record(result, rule.id, decideRule(rule, answers, { canPrompt }), summarize(answers));
  });
  return done({ jev: true });
}
