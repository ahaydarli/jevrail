// Per-user state: Jev answer cache, decision log, pending prompts.
// Lives outside the project so nothing here gets committed.
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1000;

export function stateDir() {
  if (process.env.JEVRAIL_STATE_DIR) return process.env.JEVRAIL_STATE_DIR;
  const base = process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache");
  return path.join(base, "jevrail");
}

export function cacheKey(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}

export async function cacheGet(key, dir = stateDir()) {
  const store = await readJson(path.join(dir, "answers.json"));
  const hit = store[key];
  if (!hit || Date.now() - hit.t > TTL_MS) return null;
  return hit.answers;
}

export async function cachePut(key, answers, dir = stateDir()) {
  const file = path.join(dir, "answers.json");
  const store = await readJson(file);
  store[key] = { t: Date.now(), answers };
  const keys = Object.keys(store);
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => store[a].t - store[b].t)
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => delete store[k]);
  }
  await writeJsonAtomic(file, store);
}

export async function logDecision(entry, dir = stateDir()) {
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, "decisions.jsonl"), `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // logging must never break a hook
  }
}

export async function readLog(limit = 20, dir = stateDir()) {
  try {
    const raw = await readFile(path.join(dir, "decisions.jsonl"), "utf8");
    return raw
      .trim()
      .split("\n")
      .slice(-limit)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// The user's prompt is captured at prompt-submit and classified at Stop.
function pendingFile(session, dir) {
  return path.join(dir, "pending", `${cacheKey(session || "default")}.txt`);
}

export async function putPending(session, text, dir = stateDir()) {
  const file = pendingFile(session, dir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

export async function takePending(session, dir = stateDir()) {
  const file = pendingFile(session, dir);
  try {
    const text = await readFile(file, "utf8");
    await rm(file, { force: true });
    return text;
  } catch {
    return "";
  }
}
