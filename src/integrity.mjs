// Notice when jevrail gets switched off by something the tool checks can't see,
// such as a script run through Bash. SessionStart records how jevrail is set up
// and asks Claude Code to watch the settings files; FileChanged compares.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { stateDir as defaultStateDir } from "./cache.mjs";
import { CONFIG_FILE } from "./config.mjs";

export function watchedFiles(root) {
  return [
    path.join(root, ".claude", "settings.json"),
    path.join(root, ".claude", "settings.local.json"),
    path.join(homedir(), ".claude", "settings.json"),
    path.join(homedir(), ".claude", "settings.local.json"),
    path.join(root, CONFIG_FILE),
  ];
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// What in one file matters to jevrail.
function describe(file, root) {
  if (file === path.join(root, CONFIG_FILE)) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {}
    return { rules: text ? createHash("sha256").update(text).digest("hex").slice(0, 16) : null };
  }
  const json = readJson(file) ?? {};
  const plugins = json.enabledPlugins ?? {};
  const ours = Object.keys(plugins).filter((id) => id.startsWith("jevrail@"));
  return {
    hooks: /jevrail/.test(JSON.stringify(json.hooks ?? {})),
    pluginOff: ours.some((id) => plugins[id] === false),
    allHooksOff: json.disableAllHooks === true,
  };
}

export function snapshot(root) {
  return Object.fromEntries(watchedFiles(root).map((file) => [file, describe(file, root)]));
}

function snapshotFile(session, dir) {
  const id = createHash("sha256").update(session || "none").digest("hex").slice(0, 16);
  return path.join(dir, "integrity", `${id}.json`);
}

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export async function saveSnapshot(session, value, dir = defaultStateDir()) {
  const file = snapshotFile(session, dir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

// One small file per session; drop the ones from sessions long gone.
export async function pruneSnapshots(dir = defaultStateDir()) {
  const folder = path.join(dir, "integrity");
  const now = Date.now();
  for (const name of await readdir(folder).catch(() => [])) {
    const file = path.join(folder, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > KEEP_MS) await rm(file, { force: true }).catch(() => {});
  }
}

export async function loadSnapshot(session, dir = defaultStateDir()) {
  try {
    return JSON.parse(await readFile(snapshotFile(session, dir), "utf8"));
  } catch {
    return null;
  }
}

// Compare one changed file with what SessionStart saw. Returns a warning or null.
export function compare(file, before, after, root) {
  const shown = file.startsWith(root) ? path.relative(root, file) : file.replace(homedir(), "~");
  if (!before || !after) return null;
  if ("rules" in after) {
    return before.rules !== after.rules ? `jevrail: its rules in ${shown} changed. If you didn't change them, check the diff.` : null;
  }
  const problems = [];
  if (before.hooks && !after.hooks) problems.push("jevrail's hooks were removed");
  if (!before.pluginOff && after.pluginOff) problems.push("the jevrail plugin was disabled");
  if (!before.allHooksOff && after.allHooksOff) problems.push("all hooks were turned off (disableAllHooks)");
  if (problems.length === 0) return null;
  return `jevrail: ${shown} changed and ${problems.join(", ")}. If you didn't do this, the agent may have switched off its guard.`;
}
