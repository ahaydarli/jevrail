// How well does the injection guard tell injected instructions from ordinary content?
//
//   node bench/eval-injection.mjs            score bench/injection.mjs at the rule's threshold
//   node bench/eval-injection.mjs --verbose  also print every score
//
// Sends each sample as a WebFetch result, the way the PostToolUse hook would.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "../src/engine.mjs";
import { normalize } from "../src/harness/claude.mjs";
import { INJECTION_GUARD } from "../src/rules/builtin.mjs";
import { SAMPLES } from "./injection.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const verbose = process.argv.includes("--verbose");
const strict = process.argv.includes("--strict"); // exit 1 on any mistake (CI)

function loadKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    const match = readFileSync(path.join(here, "..", ".env"), "utf8").match(/^TYPESAFE_API_KEY\s*=\s*"?([^"\n]+)"?/m);
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

async function main() {
  const apiKey = loadKey();
  if (!apiKey) throw new Error("no TYPESAFE_API_KEY");
  const stateDir = mkdtempSync(path.join(tmpdir(), "jevrail-eval-"));
  const rows = await Promise.all(SAMPLES.map(async ([label, name, text, tag]) => {
    const event = normalize({
      hook_event_name: "PostToolUse",
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com/page", prompt: "summarize" },
      tool_response: text,
      cwd: "/tmp/app",
    });
    const result = await evaluate(event, { rules: [INJECTION_GUARD], apiKey, stateDir, useCache: false, log: false });
    const score = Number(result.rules[0]?.summary?.match(/injection=([\d.]+)/)?.[1] ?? NaN);
    return { label, name, tricky: tag === "tricky", added: tag === "added", warned: result.decision === "warn", score, ms: result.ms };
  }));

  const threshold = INJECTION_GUARD.decide[0].when[0][2];
  const group = (label) => rows.filter((r) => r.label === label);
  const benign = group("benign");
  const injected = group("injection");
  console.log(`${rows.length} samples, threshold ${threshold}\n`);
  console.log(`  injections warned about   ${injected.filter((r) => r.warned).length}/${injected.length}`);
  console.log(`  benign left alone         ${benign.filter((r) => !r.warned).length}/${benign.length}`);
  const added = rows.filter((r) => r.added);
  if (added.length) console.log(`  added after tuning        ${added.filter((r) => r.warned === (r.label === "injection")).length}/${added.length} right`);
  // samples too short to be checked have no score
  const scored = (list) => list.map((r) => r.score).filter((n) => !Number.isNaN(n));
  const max = (list) => Math.max(...scored(list));
  const min = (list) => Math.min(...scored(list));
  const skipped = rows.filter((r) => Number.isNaN(r.score));
  if (skipped.length) console.log(`  too short to check        ${skipped.map((r) => r.name).join(", ")}`);
  console.log(`\n  benign scores     max ${max(benign).toFixed(2)}`);
  console.log(`  injection scores  min ${min(injected).toFixed(2)}`);
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`\nJev latency  p50 ${ms[Math.floor(ms.length / 2)]}ms  p95 ${ms[Math.floor(ms.length * 0.95)]}ms`);

  console.log("\nscores (✗ = wrong at this threshold)");
  let mistakes = 0;
  for (const r of [...rows].sort((a, b) => (b.score || 0) - (a.score || 0))) {
    const bad = r.warned !== (r.label === "injection");
    if (bad) mistakes += 1;
    if (!bad && !verbose) continue;
    console.log(`  ${bad ? "✗" : " "} ${Number.isNaN(r.score) ? "  -  " : r.score.toFixed(2)}  ${r.label.padEnd(9)} ${r.name}${r.tricky ? " (tricky)" : ""}`);
  }
  if (strict && mistakes > 0) process.exitCode = 1;
}

await main();
