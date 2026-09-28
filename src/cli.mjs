import path from "node:path";
import { readLog } from "./cache.mjs";
import { loadConfig, loadKey } from "./config.mjs";
import { evaluate } from "./engine.mjs";
import { normalize } from "./harness/claude.mjs";
import { AGENTS, install, pluginEnabled, uninstall } from "./install.mjs";
import { applySave, readMemory, writeMemory } from "./memory.mjs";

function help() {
  return `jevrail: a second look before your coding agent does something it can't take back

  jevrail install <claude|codex|copilot|cursor|all> [--shared]
  jevrail uninstall <claude|codex|copilot>
  jevrail check [--unattended] <shell command>
  jevrail check [--unattended] --tool <ToolName> '<json input>'
                                     what the guard would do, and why
  jevrail log [n]                    recent guard decisions
  jevrail add <decision|constraint|bug> <text>
  jevrail list
  jevrail hook                       read a hook payload on stdin

Key: TYPESAFE_API_KEY from the environment, ./.env, or ~/.config/jevrail/.env.
Without a key the guard and memory saves are skipped; recall still works.
Claude Code: installing the plugin is the easiest way (see README).
--shared enables that plugin in the committed .claude/settings.json;
for codex and copilot it writes hooks that run \`npx -y jevrail hook\`.
`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function run(argv, { root = process.cwd(), stdout = process.stdout, fetchImpl, stateDir } = {}) {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const args = argv.filter((arg) => !arg.startsWith("--"));
  const [command, ...rest] = args;
  if (!command || (flags.has("--help") && command !== "check") || command === "-h") {
    stdout.write(help());
    return;
  }

  if (command === "install" || command === "uninstall") {
    const target = rest[0];
    const agents = target === "all" ? AGENTS : [target];
    if (!agents[0] || !AGENTS.includes(agents[0])) {
      throw new Error(`${command} needs one of: ${AGENTS.join(", ")}, all`);
    }
    for (const agent of agents) {
      if (command === "uninstall") {
        if (agent === "cursor") continue;
        const files = await uninstall(agent, root);
        stdout.write(`removed ${agent} hooks${files.length ? ` from ${files.map((f) => path.relative(root, f)).join(", ")}` : " (none found)"}\n`);
        continue;
      }
      const shared = flags.has("--shared");
      const file = await install(agent, root, { shared });
      stdout.write(`installed ${agent} → ${path.relative(root, file) || file}\n`);
      if (agent === "claude" && shared) {
        stdout.write("claude: commit .claude/settings.json; teammates get the plugin after trusting the folder, and enter their own API key\n");
      } else if (agent === "claude" && (await pluginEnabled(root))) {
        stdout.write("warning: the jevrail plugin is also enabled, so every hook would run twice; use one or the other\n");
      }
    }
    if (command === "install") {
      if (agents.includes("codex")) stdout.write("codex: set codex_hooks = true, then run /hooks and trust this file\n");
      if (!loadKey(root)) stdout.write("warning: no TYPESAFE_API_KEY found; the Jev checks stay off until one is set (local checks still run)\n");
    }
    return;
  }

  if (command === "check") {
    // Everything after "check" is the shell command, its --flags included
    // (`git push --force`). Only a leading --unattended and --tool are ours.
    let words = argv.slice(argv.indexOf("check") + 1);
    const unattended = words[0] === "--unattended";
    if (unattended) words = words.slice(1);
    let event;
    if (words[0] === "--tool") {
      // jevrail check --tool mcp__github__merge_pull_request '{"pullNumber": 12}'
      const [, toolName, json = "{}"] = words;
      if (!toolName) throw new Error("check --tool needs a tool name and its JSON input");
      let toolInput;
      try {
        toolInput = JSON.parse(json);
      } catch {
        throw new Error("check --tool: the input must be JSON");
      }
      event = normalize({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, cwd: root });
    } else {
      const text = words.join(" ");
      if (!text) throw new Error("check needs a shell command, or --tool <name> <json>");
      event = normalize({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: text }, cwd: root });
    }
    event = { ...event, projectDir: root, canPrompt: !unattended };
    const config = loadConfig(root);
    const result = await evaluate(event, { rules: config.rules, apiKey: loadKey(root), fetchImpl, stateDir, log: false });
    stdout.write(`local:    ${result.local.length ? `look (${result.local.join("; ")})` : "nothing flagged, Jev not called"}\n`);
    if (result.called || result.cached) {
      // with several rules, show every Jev rule's answers, not just the winner's
      const answers = result.rules.filter((rule) => rule.summary);
      const text = answers.length > 1 ? answers.map((rule) => `${rule.id}: ${rule.summary}`).join("; ") : answers[0]?.summary ?? "";
      stdout.write(`jev:      ${text}${result.cached ? " [cached]" : ` [${result.ms}ms]`}\n`);
    }
    const by = result.rules.length > 1 ? ` [${result.rule}]` : "";
    stdout.write(`decision: ${result.decision}${result.reason ? ` — ${result.reason}` : ""}${by}\n`);
    return;
  }

  if (command === "log") {
    const rows = await readLog(Number(rest[0]) || 20, stateDir);
    if (rows.length === 0) {
      stdout.write("(no decisions yet)\n");
      return;
    }
    for (const row of rows) {
      const what = row.target ?? (typeof row.state === "object" ? row.state.command ?? row.state.tool : row.state);
      // rows without a Jev call were decided by a local rule
      const local = row.jev === false || (row.jev === undefined && !row.ms && !row.cached && !row.error);
      const tag = row.error ? "error" : row.cached ? "cached" : local ? "local" : `${row.ms}ms`;
      const why = local ? row.reason : row.summary;
      stdout.write(`${row.t.slice(0, 19)} ${row.decision.padEnd(5)} ${String(what).replace(/\s+/g, " ").slice(0, 60).padEnd(60)} ${row.rule ?? ""}: ${why ?? ""} [${tag}]\n`);
    }
    return;
  }

  if (command === "add") {
    const kind = rest[0];
    const text = rest.slice(1).join(" ");
    if (!["decision", "constraint", "bug"].includes(kind) || !text) {
      throw new Error("add needs <decision|constraint|bug> and text");
    }
    const entries = await readMemory(root);
    const { entries: next } = applySave(entries, kind, text);
    await writeMemory(root, next);
    stdout.write(`saved ${kind}\n`);
    return;
  }

  if (command === "list") {
    const entries = await readMemory(root);
    if (entries.length === 0) {
      stdout.write("(empty)\n");
      return;
    }
    for (const entry of entries) stdout.write(`[${entry.kind}] ${entry.text}\n`);
    return;
  }

  if (command === "hook") {
    const { handleHook } = await import("./hook.mjs");
    let input = {};
    try {
      const raw = await readStdin();
      input = raw ? JSON.parse(raw) : {};
    } catch {
      return; // unreadable payload: stay out of the way
    }
    const output = await handleHook(input, {});
    if (output) stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}
