// Local checks for file edits and for changes to jevrail itself. These decide
// without Jev: they are exact, instant, and still work with no key or network.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findSecret } from "./secrets.mjs";
import { parse } from "./shell.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Files where a credential belongs, and which are normally never committed.
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\.[\w-]+)?|\.npmrc|\.pypirc|\.netrc|credentials(?:\.json)?|[\w-]+\.(?:pem|key))$/;

// Programs that only read the files they are given.
const READERS = new Set([
  "cat", "less", "more", "head", "tail", "grep", "egrep", "rg", "ag", "jq", "yq", "ls", "stat",
  "wc", "diff", "cmp", "file", "bat", "code", "open", "echo", "printf",
]);
const GIT_READS = new Set(["diff", "log", "show", "status", "blame", "ls-files", "check-ignore", "add", "commit"]);

function projectRoot(event) {
  return path.resolve(event.projectDir || event.cwd || process.cwd());
}

function expand(file, root) {
  const text = String(file ?? "");
  if (text === "~" || text.startsWith("~/")) return path.join(homedir(), text.slice(1));
  return path.resolve(root, text);
}

function inside(file, dir) {
  const relative = path.relative(dir, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isTemp(file) {
  return ["/tmp", "/private/tmp", "/var/folders", tmpdir()].some((dir) => inside(file, dir));
}

function filePath(input) {
  return input?.file_path ?? input?.notebook_path ?? input?.path ?? "";
}

// The text an edit adds to the file.
function addedText(input) {
  if (typeof input?.content === "string") return input.content;
  if (typeof input?.new_string === "string") return input.new_string;
  if (typeof input?.new_source === "string") return input.new_source;
  if (Array.isArray(input?.edits)) return input.edits.map((edit) => edit?.new_string ?? "").join("\n");
  return "";
}

function removedText(input) {
  if (typeof input?.old_string === "string") return input.old_string;
  if (Array.isArray(input?.edits)) return input.edits.map((edit) => edit?.old_string ?? "").join("\n");
  return "";
}

function readSafe(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function gitIgnored(file, root) {
  const run = spawnSync("git", ["check-ignore", "-q", file], { cwd: root, timeout: 2000 });
  return run.status === 0;
}

// --- tamper: changes that would turn jevrail off -----------------------------

function settingsFiles(root) {
  return [
    path.join(root, ".claude", "settings.json"),
    path.join(root, ".claude", "settings.local.json"),
    path.join(homedir(), ".claude", "settings.json"),
    path.join(homedir(), ".claude", "settings.local.json"),
  ];
}

// jevrail's own code, unless this is a checkout inside the project being worked on.
function guardDirs(root) {
  const dirs = [path.join(root, ".jevrail"), path.join(homedir(), ".claude", "plugins")];
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ? path.resolve(process.env.CLAUDE_PLUGIN_ROOT) : PACKAGE_ROOT;
  if (!inside(pluginRoot, root)) dirs.push(pluginRoot);
  return dirs;
}

const DISABLES = /"disableAllHooks"\s*:\s*true|"jevrail@[\w-]+"\s*:\s*false/;

// A settings edit only matters when it removes jevrail or turns hooks off.
function settingsTamper(file, input) {
  const added = addedText(input);
  if (DISABLES.test(added)) return "turns off hooks or the jevrail plugin";
  const removed = typeof input?.content === "string" ? readSafe(file) : removedText(input);
  if (/jevrail/.test(removed) && !/jevrail/.test(added)) return "removes jevrail from Claude Code settings";
  return null;
}

function fileTamper(event, root) {
  const file = expand(filePath(event.toolInput), root);
  if (settingsFiles(root).includes(file)) return settingsTamper(file, event.toolInput);
  if (guardDirs(root).some((dir) => inside(file, dir))) return "edits jevrail's own rules or code";
  return null;
}

const PROTECTED_WORD = /\.claude\/settings(?:\.local)?\.json|(?:^|[\s\/'"=])\.claude\/?(?=$|[\s'"])|\.jevrail\b|\.claude\/plugins|disableAllHooks/;

function shellTamper(command) {
  if (/\bjevrail(?:\.mjs)?["']?\s+uninstall\b/.test(command)) return "uninstalls jevrail";
  if (/\bclaude\s+plugins?\s+(?:disable|uninstall|remove|rm)\b[^|;&]*jevrail/.test(command)) return "disables the jevrail plugin";
  if (/\bclaude\s+plugins?\s+marketplace\s+(?:remove|rm)\b[^|;&]*jevrail/.test(command)) return "removes the jevrail marketplace";
  const { segments, nested } = parse(command);
  const all = [...segments, ...nested.flatMap((text) => parse(text).segments)];
  for (const { words, redirects } of all) {
    if (redirects.some((target) => PROTECTED_WORD.test(target))) return "overwrites Claude Code or jevrail settings";
    if (!words.some((word) => PROTECTED_WORD.test(word))) continue;
    const program = (words[0] ?? "").split("/").pop();
    if (READERS.has(program)) continue;
    if (program === "git" && GIT_READS.has(words[1])) continue;
    return "changes Claude Code or jevrail settings";
  }
  return null;
}

export function classifyTamper(event) {
  const root = projectRoot(event);
  let reason = null;
  if (event.tool === "shell") reason = shellTamper(event.command ?? "");
  else if (event.tool === "edit" || event.tool === "write") reason = fileTamper(event, root);
  return { look: Boolean(reason), reasons: reason ? [reason] : [] };
}

// --- file edits ----------------------------------------------------------------

export function classifyFile(event) {
  const root = projectRoot(event);
  const raw = filePath(event.toolInput);
  if (!raw) return { look: false, reasons: [] };
  const file = expand(raw, root);
  const shown = inside(file, root) ? path.relative(root, file) : file.replace(homedir(), "~");
  const reasons = [];

  // Claude Code keeps its own memory and plans under ~/.claude; that's expected.
  const ownFiles = inside(file, path.join(homedir(), ".claude")) && !settingsFiles(root).includes(file);
  if (!inside(file, root) && !isTemp(file) && !ownFiles) reasons.push(`writes outside the project: ${shown}`);
  if (inside(file, path.join(root, ".git"))) reasons.push(`edits git internals: ${shown}`);

  const added = addedText(event.toolInput);
  if (added && !SECRET_FILE.test(file)) {
    const found = findSecret(added);
    if (found && !gitIgnored(file, root)) {
      reasons.push(`writes what looks like ${found} into ${shown}; use an environment variable instead`);
    }
  }
  return { look: reasons.length > 0, reasons };
}
