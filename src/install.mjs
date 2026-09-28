import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "jevrail.mjs");

// Local installs point at this package and go in files that are not committed.
// `node` is found on PATH when the hook runs, like the plugin's hooks, so a
// Node upgrade doesn't leave a dead path behind. Shared installs use a command
// that works on every teammate's machine.
function command(shared) {
  return shared ? "npx -y jevrail hook" : `node "${path.resolve(bin)}" hook`;
}

// Must match the matchers in hooks/hooks.json.
const CLAUDE_TOOLS = "Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch|WebSearch|mcp__.*";
const CLAUDE_RESULTS = "Bash|WebFetch|WebSearch|mcp__.*";

// The Claude plugin: this repo is its own marketplace.
export const PLUGIN_ID = "jevrail@jevrail";
const MARKETPLACE = { source: { source: "github", repo: "ahaydarli/jevrail" } };

function isOurs(item) {
  const text = String(item.command ?? "");
  return /jevrail(\.mjs"?)?\s+hook\b/.test(text) || text.includes("hook-entry.mjs");
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`${file} is not valid JSON; fix it before installing`);
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Replace any earlier jevrail entry for this event, keep everything else.
function upsert(config, event, { matcher, shared, timeout = 10 }) {
  const hooks = config.hooks ?? {};
  const list = Array.isArray(hooks[event]) ? hooks[event] : [];
  const kept = list
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((item) => !isOurs(item)) }))
    .filter((group) => group.hooks.length > 0);
  const group = { hooks: [{ type: "command", command: command(shared), timeout }] };
  if (matcher) group.matcher = matcher;
  kept.push(group);
  return { ...config, hooks: { ...hooks, [event]: kept } };
}

function enablePlugin(config) {
  return {
    ...config,
    extraKnownMarketplaces: { ...(config.extraKnownMarketplaces ?? {}), jevrail: MARKETPLACE },
    enabledPlugins: { ...(config.enabledPlugins ?? {}), [PLUGIN_ID]: true },
  };
}

function removePlugin(config) {
  const next = { ...config };
  if (next.enabledPlugins?.[PLUGIN_ID] !== undefined) {
    const { [PLUGIN_ID]: _, ...rest } = next.enabledPlugins;
    next.enabledPlugins = rest;
  }
  if (next.extraKnownMarketplaces?.jevrail) {
    const { jevrail: _, ...rest } = next.extraKnownMarketplaces;
    next.extraKnownMarketplaces = rest;
  }
  return next;
}

// Is the plugin turned on in user or project settings? Then hooks in
// settings files would make every event run twice.
export async function pluginEnabled(root, home = homedir()) {
  const files = [
    path.join(home, ".claude", "settings.json"),
    path.join(root, ".claude", "settings.json"),
    path.join(root, ".claude", "settings.local.json"),
  ];
  for (const file of files) {
    const config = await readJson(file).catch(() => ({}));
    if (config.enabledPlugins?.[PLUGIN_ID] === true) return true;
  }
  return false;
}

function removeFrom(config) {
  const hooks = { ...(config.hooks ?? {}) };
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = list
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((item) => !isOurs(item)) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  // don't leave an empty "hooks": {} behind
  const { hooks: _, ...rest } = config;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

const TARGETS = {
  claude: (root, shared) => path.join(root, ".claude", shared ? "settings.json" : "settings.local.json"),
  codex: (root) => path.join(root, ".codex", "hooks.json"),
  copilot: (root) => path.join(root, ".copilot", "hooks.json"),
};

export async function install(agent, root, { shared = false } = {}) {
  // Shared Claude installs enable the plugin for everyone who opens the
  // project, and drop hooks an older --shared install wrote.
  if (agent === "claude" && shared) {
    const file = TARGETS.claude(root, true);
    await writeJson(file, enablePlugin(removeFrom(await readJson(file))));
    return file;
  }
  if (agent === "claude" || agent === "codex") {
    const file = TARGETS[agent](root, shared);
    let config = await readJson(file);
    // Claude can filter by tool, so node only starts for the tools jevrail checks.
    if (agent === "claude") config = upsert(config, "SessionStart", { shared });
    config = upsert(config, "PreToolUse", { matcher: agent === "claude" ? CLAUDE_TOOLS : undefined, shared });
    if (agent === "claude") {
      config = upsert(config, "PostToolUse", { matcher: CLAUDE_RESULTS, shared });
      config = upsert(config, "FileChanged", { shared });
    }
    config = upsert(config, "UserPromptSubmit", { shared });
    config = upsert(config, "Stop", { shared });
    await writeJson(file, config);
    return file;
  }
  if (agent === "copilot") {
    const file = TARGETS.copilot(root);
    let config = await readJson(file);
    config = upsert(config, "userPromptSubmitted", { shared });
    config = upsert(config, "Stop", { shared });
    await writeJson(file, config);
    return file;
  }
  if (agent === "cursor") {
    const { writeCursorRule, CURSOR_RULE } = await import("./hook.mjs");
    const { readMemory } = await import("./memory.mjs");
    await writeCursorRule(root, await readMemory(root));
    return path.join(root, CURSOR_RULE);
  }
  throw new Error(`unknown agent: ${agent}`);
}

export async function uninstall(agent, root) {
  const files = agent === "claude"
    ? [TARGETS.claude(root, false), TARGETS.claude(root, true)]
    : TARGETS[agent] ? [TARGETS[agent](root)] : [];
  const touched = [];
  for (const file of files) {
    const config = await readJson(file);
    const next = agent === "claude" ? removePlugin(removeFrom(config)) : removeFrom(config);
    if (JSON.stringify(next) === JSON.stringify(config)) continue;
    await writeJson(file, next);
    touched.push(file);
  }
  return touched;
}

export const AGENTS = ["claude", "codex", "copilot", "cursor"];
