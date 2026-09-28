import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const MEMORY_FILE = "JEVRAIL.md";

const LINE =
  /^- \[(decision|constraint|bug|superseded)\] (.+?)(?: <!-- id:([a-z0-9]+) -->)?\s*$/;

const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /(?<=:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/g,
  /\b(?:api[_-]?key|token|password|passwd|secret)\s*[:=]\s*\S+/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(?:\d[ -]*?){13,19}\b/g,
];

// Redact secrets but keep the text's shape (newlines, spacing).
export function scrubText(text) {
  let out = String(text ?? "");
  for (const pattern of SECRET) out = out.replace(pattern, "[redacted]");
  return out;
}

export function scrub(text) {
  return scrubText(text).replace(/\s+/g, " ").trim();
}

export function parseMemory(markdown) {
  const entries = [];
  for (const raw of markdown.split("\n")) {
    const match = raw.match(LINE);
    if (!match) continue;
    entries.push({
      kind: match[1],
      text: match[2].trim(),
      id: match[3] ?? "",
    });
  }
  return entries;
}

export function activeEntries(entries) {
  return entries.filter((entry) => entry.kind !== "superseded");
}

const STOP_WORDS = new Set(
  ("the and for use are but not you all any can had her was one our out has his how its may new now " +
    "see way who did get let say she too with that this from have will your what when which they them " +
    "then than there their would should could about into does just like make some only over also more " +
    "most very been were being here why where while after before because instead using used")
    .split(" "),
);

function tokens(text) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

export function selectLines(prompt, entries, limit = 5) {
  const wanted = tokens(prompt);
  const ranked = activeEntries(entries)
    .map((entry) => {
      const words = tokens(entry.text);
      let hits = 0;
      for (const word of words) if (wanted.has(word)) hits += 1;
      const score = words.size === 0 ? 0 : hits / words.size;
      return { entry, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.text.localeCompare(b.entry.text));
  return ranked.slice(0, limit).map((row) => row.entry);
}

export function injection(entries) {
  if (entries.length === 0) return "";
  const lines = entries.map((entry) => `- [${entry.kind}] ${entry.text}`);
  return ["Project memory (Jevrail). Use these. Do not re-ask them.", ...lines].join("\n");
}

function overlap(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let hits = 0;
  for (const word of left) if (right.has(word)) hits += 1;
  return hits / Math.min(left.size, right.size);
}

export function render(entries) {
  const header = [
    "# Jevrail",
    "",
    "Decisions saved by the Jevrail hook. Review this file like code.",
    "",
  ];
  const body = entries.map((entry) => {
    const id = entry.id ? ` <!-- id:${entry.id} -->` : "";
    return `- [${entry.kind}] ${entry.text}${id}`;
  });
  return `${header.join("\n")}${body.join("\n")}${body.length ? "\n" : ""}`;
}

export async function readMemory(root) {
  try {
    const text = await readFile(path.join(root, MEMORY_FILE), "utf8");
    return parseMemory(text);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function writeMemory(root, entries) {
  await writeFile(path.join(root, MEMORY_FILE), render(entries));
}

export function applySave(entries, kind, text) {
  const clean = scrub(text).slice(0, 200);
  if (!clean) return { entries, saved: null };
  const next = entries.map((entry) => ({ ...entry }));
  for (const entry of next) {
    if (entry.kind !== kind) continue;
    if (overlap(entry.text, clean) < 0.6) continue;
    entry.kind = "superseded";
  }
  const saved = { kind, text: clean, id: randomBytes(3).toString("hex") };
  next.push(saved);
  return { entries: next, saved };
}
