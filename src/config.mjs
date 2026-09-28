import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { BUILTIN_RULES } from "./rules/builtin.mjs";

export const CONFIG_FILE = path.join(".jevrail", "config.json");

function keyFromEnvFile(file) {
  try {
    const match = readFileSync(file, "utf8").match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*["']?([^"'\s#]+)/m);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

// The Claude plugin's own option first, then the environment, then the
// project's .env, then ~/.config/jevrail/.env.
export function loadKey(root) {
  if (process.env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY) return process.env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY;
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  return (
    keyFromEnvFile(path.join(root, ".env")) ||
    keyFromEnvFile(path.join(homedir(), ".config", "jevrail", ".env"))
  );
}

function validRule(rule) {
  return (
    rule &&
    typeof rule.id === "string" &&
    typeof rule.on === "string" &&
    // rules without questions are decided locally from their prefilter
    (rule.ask === undefined || (rule.ask && typeof rule.ask === "object")) &&
    Array.isArray(rule.decide)
  );
}

// .jevrail/config.json (optional, committed):
//   { "disable": ["command-guard"], "rules": [ ... ], "onError": "allow" | "ask" }
export function loadConfig(root) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(path.join(root, CONFIG_FILE), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") process.stderr.write(`jevrail: ignoring ${CONFIG_FILE}: ${error.message}\n`);
  }
  const disabled = new Set(Array.isArray(raw.disable) ? raw.disable : []);
  const custom = (Array.isArray(raw.rules) ? raw.rules : []).filter((rule) => {
    if (validRule(rule)) return true;
    process.stderr.write(`jevrail: skipping invalid rule ${JSON.stringify(rule?.id ?? rule)}\n`);
    return false;
  });
  const customIds = new Set(custom.map((rule) => rule.id));
  const rules = [
    ...BUILTIN_RULES.filter((rule) => !customIds.has(rule.id)),
    ...custom,
  ].filter((rule) => !disabled.has(rule.id));
  return {
    rules,
    onError: raw.onError === "ask" ? "ask" : "allow",
    memory: !disabled.has("memory"),
  };
}
