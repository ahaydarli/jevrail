import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { logDecision, putPending, takePending } from "./cache.mjs";
import { loadConfig, loadKey } from "./config.mjs";
import { evaluate } from "./engine.mjs";
import { format, normalize } from "./harness/claude.mjs";
import { compare, loadSnapshot, pruneSnapshots, saveSnapshot, snapshot, watchedFiles } from "./integrity.mjs";
import { askMemory, classify } from "./jev.mjs";
import {
  activeEntries,
  applySave,
  injection,
  readMemory,
  scrub,
  selectLines,
  writeMemory,
} from "./memory.mjs";

const NO_KEY =
  "jevrail: no TYPESAFE_API_KEY found, so the guard is off. Set it in the plugin's options (/plugin), export it, or add it to .env or ~/.config/jevrail/.env.";

// Never throws: a broken hook must not stop the agent.
export async function handleHook(input, { root, apiKey, fetchImpl, stateDir } = {}) {
  try {
    const event = normalize(input);
    const cwd = root ?? (event.projectDir || event.cwd || process.cwd());
    const config = loadConfig(cwd);
    const key = apiKey ?? loadKey(cwd);

    if (event.event === "session_start") {
      // Watch the settings files, so turning jevrail off by any route is noticed.
      await saveSnapshot(event.session, snapshot(cwd), stateDir).catch(() => {});
      if (event.source === "startup") await pruneSnapshots(stateDir).catch(() => {});
      const result = { watchPaths: watchedFiles(cwd) };
      // jevrail fails open, so without a key the Jev rules would be silently off.
      const needsKey = config.rules.some((rule) => Object.keys(rule.ask ?? {}).length > 0);
      if (!key && needsKey && ["startup", "resume", ""].includes(event.source)) result.message = NO_KEY;
      return format(event, result);
    }
    if (event.event === "file_changed") {
      return format(event, { message: await checkIntegrity(event, cwd, stateDir) });
    }
    if (event.event === "pre_tool" || event.event === "post_tool") {
      // Before a tool runs the agent is waiting, so give up on Jev after 4s and
      // fail open. After a fetch nothing is waiting on us; allow more, within
      // the hook's 10s limit.
      const timeoutMs = event.event === "post_tool" ? 8000 : 4000;
      const result = await evaluate(event, { rules: config.rules, apiKey: key, fetchImpl, onError: config.onError, stateDir, timeoutMs });
      return format(event, result);
    }
    if (event.event === "prompt" && config.memory) {
      const clean = scrub(event.prompt);
      if (clean) await putPending(event.session, clean, stateDir).catch(() => {});
      const picked = selectLines(event.prompt, await readMemory(cwd));
      return format(event, { context: injection(picked) });
    }
    if (event.event === "stop" && config.memory) {
      await captureMemory(event, { cwd, apiKey: key, fetchImpl, stateDir });
    }
    return null;
  } catch (error) {
    process.stderr.write(`jevrail: ${error.message}\n`);
    return null;
  }
}

async function checkIntegrity(event, cwd, stateDir) {
  const file = path.resolve(event.filePath);
  if (!watchedFiles(cwd).includes(file)) return null;
  const before = await loadSnapshot(event.session, stateDir);
  if (!before) return null;
  const now = snapshot(cwd);
  const message = compare(file, before[file], now[file], cwd);
  // remember the new state so one change is reported once
  await saveSnapshot(event.session, { ...before, [file]: now[file] }, stateDir).catch(() => {});
  if (message) {
    const target = file.startsWith(`${cwd}${path.sep}`) ? path.relative(cwd, file) : file;
    await logDecision({ event: "file_changed", tool: "settings", target, decision: "warn", rule: "tamper-guard", reason: message, jev: false }, stateDir).catch(() => {});
  }
  return message;
}

// Classify what the user said this turn (captured at prompt time), not the
// assistant's reply. Scrubbed before it is sent.
async function captureMemory(event, { cwd, apiKey, fetchImpl, stateDir }) {
  const said = await takePending(event.session, stateDir);
  if (!said) return;
  const answers = await askMemory(said, { apiKey, fetchImpl });
  if (!answers) return;
  const kind = classify(answers);
  if (!kind) return;
  const { entries: next, saved } = applySave(await readMemory(cwd), kind, said);
  if (!saved) return;
  await writeMemory(cwd, next);
  // only refresh Cursor's rule if `jevrail install cursor` created it
  if (existsSync(path.join(cwd, CURSOR_RULE))) await writeCursorRule(cwd, next);
}

export const CURSOR_RULE = path.join(".cursor", "rules", "jevrail.mdc");

export async function writeCursorRule(root, entries) {
  const body = injection(activeEntries(entries).slice(-12)) || "Project memory (Jevrail) is empty.";
  const dir = path.join(root, ".cursor", "rules");
  await mkdir(dir, { recursive: true });
  const file = [
    "---",
    "alwaysApply: true",
    "description: Jevrail project memory",
    "---",
    "",
    body,
    "",
  ].join("\n");
  await writeFile(path.join(dir, "jevrail.mdc"), file);
}
