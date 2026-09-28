// Supply chain: what an install or download-and-run command would bring in.
// Package names are checked against OSV (known malware, e.g. MAL-2026-17218)
// and the public registries (does it exist, how new, how used), plus a local
// typo-squat check. Lookups are cached and fail open.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { cacheGet, cachePut } from "./cache.mjs";
import { parse } from "./shell.mjs";

const LOOKUP_TTL = 12 * 60 * 60 * 1000;
const NEW_DAYS = 30;
const LOW_WEEKLY = 500;
const MAX_PACKAGES = 10;

// --- what a command installs -----------------------------------------------------

const NPM_INSTALL = new Set(["install", "i", "in", "add", "isntall"]);
const VALUE_FLAGS = new Set(["--registry", "--prefix", "--workspace", "-w", "--tag", "--filter", "-F", "--index-url", "-i", "--extra-index-url", "--python", "-p", "--package", "--with", "-C", "--dir", "--cwd"]);

function positional(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (VALUE_FLAGS.has(args[i])) {
      i += 1;
      continue;
    }
    if (!args[i].startsWith("-")) out.push(args[i]);
  }
  return out;
}

// "lodash@4", "@scope/pkg@^1" → name; git, URL, path and alias specs → null + url flag
function npmSpec(spec) {
  if (/^(?:\.|\/|~|file:|link:|workspace:)/.test(spec)) return null;
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:|https?:)/.test(spec) || /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(spec)) return { url: spec };
  if (spec.startsWith("npm:")) return npmSpec(spec.slice(4));
  const match = spec.match(/^(@[^/@\s]+\/[^@\s]+|[^@\s]+)(?:@.*)?$/);
  return match ? { name: match[1].toLowerCase() } : null;
}

// "requests==2.31", "Flask[async]>=3" → normalized name (PEP 503)
function pypiSpec(spec) {
  if (/^(?:\.|\/|~)/.test(spec) || /\.(?:whl|tar\.gz|zip)$/.test(spec)) return null;
  if (/^(?:git\+|https?:)/.test(spec) || spec.includes("@ ")) return { url: spec };
  const match = spec.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  return match ? { name: match[1].toLowerCase().replace(/[-_.]+/g, "-") } : null;
}

function npmNames(program, args) {
  const [sub, ...rest] = positional(args);
  const specs = [];
  if (program === "npx" || program === "bunx") {
    const flagged = args.flatMap((arg, i) => (["-p", "--package"].includes(args[i - 1]) ? [arg] : arg.startsWith("--package=") ? [arg.slice(10)] : []));
    specs.push(...(flagged.length ? flagged : [sub].filter(Boolean)));
  } else if (NPM_INSTALL.has(sub) || (program === "yarn" && sub === "global" && rest[0] === "add")) {
    specs.push(...(sub === "global" ? rest.slice(1) : rest));
  } else if (["exec", "x", "dlx"].includes(sub)) {
    specs.push(rest[0]);
  } else if (["create", "init"].includes(sub) && rest[0]) {
    // npm create vite → create-vite; npm create @scope/x → @scope/create-x
    const name = rest[0].replace(/@[^/]*$/, "");
    specs.push(name.startsWith("@") ? name.replace("/", "/create-") : `create-${name}`);
  }
  return specs.filter(Boolean).map((spec) => ({ ecosystem: "npm", spec, ...npmSpec(spec) }));
}

function pypiNames(program, args) {
  let rest = args;
  if (program === "python" || program === "python3") {
    if (!(args[0] === "-m" && args[1] === "pip")) return [];
    rest = args.slice(2);
  }
  if (program === "uv" && rest[0] === "pip") rest = rest.slice(1);
  if (program === "uv" && rest[0] === "tool") rest = rest.slice(1);
  const words = positional(rest);
  let specs = [];
  if (program === "uvx") specs = words.slice(0, 1);
  else if (program === "pipx" && ["install", "run"].includes(words[0])) specs = words.slice(1, 2);
  else if (["install", "add"].includes(words[0])) specs = words.slice(1);
  // -r requirements.txt and -e . are lock-style or local installs
  if (rest.some((arg) => ["-r", "--requirement", "-e", "--editable"].includes(arg))) {
    const skip = new Set(rest.filter((arg, i) => ["-r", "--requirement", "-e", "--editable"].includes(rest[i - 1])));
    specs = specs.filter((spec) => !skip.has(spec));
  }
  return specs.map((spec) => ({ ecosystem: "PyPI", spec, ...pypiSpec(spec) }));
}

export function parseInstalls(command) {
  const { segments, nested } = parse(String(command ?? ""));
  const found = [];
  for (const { words } of [...segments, ...nested.flatMap((text) => parse(text).segments)]) {
    let args = [...words];
    while (args.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0]) || ["sudo", "time", "nohup", "command"].includes(args[0]))) args.shift();
    const [raw = "", ...rest] = args;
    const program = raw.split("/").pop();
    if (["npm", "pnpm", "yarn", "bun", "npx", "bunx"].includes(program)) found.push(...npmNames(program, rest));
    else if (["pip", "pip3", "uv", "uvx", "pipx", "poetry", "python", "python3"].includes(program)) found.push(...pypiNames(program, rest));
  }
  const seen = new Set();
  return found.filter((pkg) => {
    const key = `${pkg.ecosystem}:${pkg.name ?? pkg.url}`;
    if (!pkg.name && !pkg.url) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- download and run ------------------------------------------------------------

const RUNNERS = "(?:ba|z|da|k|fi)?sh|python3?|node|perl|ruby|php|pwsh|deno";
const REMOTE = [
  // curl … | sh, wget -qO- … | sudo bash, curl … | python3 -
  new RegExp(`\\b(?:curl|wget|iwr|Invoke-WebRequest)\\b[^|;&\\n]*\\|\\s*(?:sudo\\s+(?:-\\S+\\s+)*)?(?:env\\s+(?:\\S+=\\S+\\s+)*)?(?:${RUNNERS})\\b`, "i"),
  // bash <(curl …), source <(curl …)
  /(?:\b(?:ba|z)?sh|\bsource|(?:^|\s)\.)\s+<\(\s*(?:curl|wget)\b/,
  // sh -c "$(curl …)", eval "$(wget -O- …)", python -c "$(curl …)"
  new RegExp(`\\b(?:(?:${RUNNERS})\\s+-c|eval)\\s+["']?\\$\\(\\s*(?:curl|wget)\\b`),
  // iex (iwr …) in PowerShell
  /\b(?:iex|Invoke-Expression)\b[^\n]*\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString)\b/i,
];

// curl -o x.sh URL && bash x.sh / chmod +x x && ./x
function downloadsThenRuns(command) {
  const saved = [...command.matchAll(/\b(?:curl|wget)\b[^;&|\n]*?\s(?:-o|-O|--output|--output-document)[=\s]\s*([^\s;&|]+)/g)].map((m) => m[1]);
  return saved.some((file) => {
    const name = file.replace(/^\.\//, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:\\b(?:${RUNNERS})\\s+(?:\\./)?${name}\\b|chmod\\s+[+0-7a-z]*x[^;&|\\n]*\\b${name}\\b|(?:^|[\\s;&|])\\./${name}\\b)`).test(command);
  });
}

// Quoted text is data (a commit message, an echo into docs) unless it's what
// `sh -c` runs or contains a $(…) that the shell will execute.
function unquoted(command) {
  return command
    .replace(/(?<!-c\s)'[^']*'/g, "''")
    .replace(/(?<!-c\s)"(?:[^"\\]|\\.)*"/g, (quoted) => (quoted.includes("$(") ? quoted : '""'));
}

export function runsRemoteCode(command) {
  const text = unquoted(String(command ?? ""));
  return REMOTE.some((pattern) => pattern.test(text)) || downloadsThenRuns(text);
}

// --- typo-squats ----------------------------------------------------------------

const POPULAR = {
  npm: "react react-dom next vue svelte angular express fastify koa lodash underscore axios node-fetch got request chalk commander yargs inquirer ora debug dotenv uuid nanoid moment dayjs date-fns luxon typescript ts-node tsx esbuild vite webpack rollup parcel babel-core @babel/core eslint prettier jest vitest mocha chai sinon cypress playwright puppeteer jquery bootstrap tailwindcss postcss autoprefixer sass less styled-components emotion redux zustand mobx rxjs immer zod yup joi ajv graphql apollo-server prisma mongoose sequelize typeorm knex pg mysql mysql2 sqlite3 redis ioredis socket.io ws cors helmet morgan body-parser cookie-parser jsonwebtoken bcrypt bcryptjs passport multer sharp jimp nodemailer winston pino bunyan cheerio jsdom marked markdown-it highlight.js classnames clsx cross-env rimraf glob fs-extra chokidar nodemon concurrently pm2 semver minimist execa shelljs async bluebird p-limit colors yaml js-yaml xml2js csv-parse papaparse form-data qs body cookie mime ms openai @anthropic-ai/sdk langchain electron three d3 chart.js lucide-react framer-motion react-router react-router-dom @tanstack/react-query swr formik react-hook-form",
  PyPI: "requests urllib3 httpx aiohttp flask django fastapi uvicorn gunicorn starlette pydantic numpy pandas scipy matplotlib seaborn plotly scikit-learn tensorflow torch keras transformers datasets tokenizers openai anthropic langchain boto3 botocore awscli google-cloud-storage azure-storage-blob sqlalchemy psycopg2 psycopg2-binary pymysql redis celery pytest pytest-cov tox black ruff flake8 mypy pylint isort click typer rich tqdm colorama pyyaml toml tomli jinja2 markupsafe beautifulsoup4 lxml selenium playwright scrapy pillow opencv-python cryptography pyjwt bcrypt paramiko fabric python-dotenv setuptools wheel pip virtualenv poetry six attrs dataclasses-json marshmallow jsonschema protobuf grpcio websockets pyzmq docker kubernetes ansible jupyter notebook ipython streamlit gradio",
};
const POPULAR_SETS = Object.fromEntries(Object.entries(POPULAR).map(([eco, names]) => [eco, new Set(names.split(" "))]));

// one edit apart: substitution, insertion, deletion or swapped neighbours
function oneEditApart(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff = [...a].map((ch, i) => (ch !== b[i] ? i : -1)).filter((i) => i >= 0);
    if (diff.length === 1) return true;
    return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < long.length; i += 1) {
    if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  }
  return false;
}

export function typoOf(ecosystem, name) {
  const popular = POPULAR_SETS[ecosystem];
  if (!popular || popular.has(name) || name.length < 4) return null;
  const bare = name.replace(/^@[^/]+\//, "");
  for (const known of popular) {
    const knownBare = known.replace(/^@[^/]+\//, "");
    if (oneEditApart(name, known) || (bare !== name && bare === knownBare)) return known;
  }
  return null;
}

// --- private registries ----------------------------------------------------------

// Names served by a private npm registry aren't on the public one; don't call them missing.
function privateNpm(root) {
  const scopes = new Set();
  let all = false;
  for (const file of [path.join(root, ".npmrc"), path.join(homedir(), ".npmrc")]) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const scoped = line.match(/^\s*(@[^:]+):registry\s*=/);
      if (scoped) scopes.add(scoped[1]);
      else if (/^\s*registry\s*=\s*(?!https?:\/\/registry\.(?:npmjs\.org|yarnpkg\.com))/.test(line)) all = true;
    }
  }
  return (name) => all || scopes.has(name.split("/")[0]);
}

function allowed(name, patterns = []) {
  return patterns.some((pattern) => (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern));
}

// --- lookups ---------------------------------------------------------------------

async function getJson(fetchImpl, url, signal, init = {}) {
  const res = await fetchImpl(url, { ...init, signal });
  if (res.status === 404) return { missing: true };
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function malware(fetchImpl, packages, signal) {
  const body = { queries: packages.map(({ ecosystem, name }) => ({ package: { name, ecosystem } })) };
  const data = await getJson(fetchImpl, "https://api.osv.dev/v1/querybatch", signal, { method: "POST", body: JSON.stringify(body) });
  return (data.results ?? []).map((result) => (result.vulns ?? []).map((v) => v.id).filter((id) => id.startsWith("MAL-")));
}

const days = (iso) => (Date.now() - Date.parse(iso)) / 86_400_000;

async function npmFacts(fetchImpl, name, signal) {
  const stats = await getJson(fetchImpl, `https://api.npmjs.org/downloads/point/last-week/${name}`, signal);
  if (stats.missing || stats.error) {
    const doc = await getJson(fetchImpl, `https://registry.npmjs.org/${name.replace("/", "%2f")}`, signal);
    if (doc.missing) return { missing: true };
    return { weekly: 0, ageDays: doc.time?.created ? days(doc.time.created) : null };
  }
  if (stats.downloads >= LOW_WEEKLY) return { weekly: stats.downloads };
  // unpopular: the full document is small, and says how old the package is
  const doc = await getJson(fetchImpl, `https://registry.npmjs.org/${name.replace("/", "%2f")}`, signal);
  return { weekly: stats.downloads, ageDays: doc.time?.created ? days(doc.time.created) : null };
}

async function pypiFacts(fetchImpl, name, signal) {
  const doc = await getJson(fetchImpl, `https://pypi.org/pypi/${name}/json`, signal);
  if (doc.missing) return { missing: true };
  const uploads = Object.values(doc.releases ?? {}).flat().map((file) => file.upload_time_iso_8601).filter(Boolean).sort();
  const ageDays = uploads.length ? days(uploads[0]) : null;
  if (ageDays !== null && ageDays > 365) return { ageDays };
  const stats = await getJson(fetchImpl, `https://pypistats.org/api/packages/${name}/recent`, signal).catch(() => ({}));
  return { ageDays, weekly: stats.data?.last_week };
}

// Facts per package: { malware: [ids], missing, weekly, ageDays }. Failed lookups are left out.
export async function lookup(packages, { fetchImpl = fetch, stateDir, timeoutMs = 3000, root = process.cwd() } = {}) {
  const isPrivate = privateNpm(root);
  const out = new Map();
  const todo = [];
  for (const pkg of packages) {
    const key = `${pkg.ecosystem}:${pkg.name}`;
    const hit = await cacheGet(key, stateDir, { file: "packages.json", ttl: LOOKUP_TTL }).catch(() => null);
    if (hit) out.set(key, hit);
    else todo.push(pkg);
  }
  if (todo.length === 0) return out;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const [osv, registry] = await Promise.all([
      malware(fetchImpl, todo, controller.signal).catch(() => null),
      Promise.all(todo.map((pkg) => {
        if (pkg.ecosystem === "npm" && isPrivate(pkg.name)) return Promise.resolve({ private: true });
        const facts = pkg.ecosystem === "npm" ? npmFacts : pypiFacts;
        return facts(fetchImpl, pkg.name, controller.signal).catch(() => null);
      })),
    ]);
    for (const [i, pkg] of todo.entries()) {
      const key = `${pkg.ecosystem}:${pkg.name}`;
      if (!osv && !registry[i]) continue;
      const facts = { ...(registry[i] ?? {}), malware: osv?.[i] ?? [] };
      out.set(key, facts);
      // only complete answers are worth remembering
      if (osv && registry[i]) await cachePut(key, facts, stateDir, { file: "packages.json" }).catch(() => {});
    }
  } finally {
    clearTimeout(timer);
  }
  return out;
}

// --- the prefilter ---------------------------------------------------------------

export async function classifySupplyChain(event, { fetchImpl, stateDir, allowPackages = [] } = {}) {
  if (event.tool !== "shell") return { look: false, reasons: [] };
  const command = event.command ?? "";
  const reasons = [];
  const facts = { malicious: false, suspicious: false, remote_code: false };

  if (runsRemoteCode(command)) {
    facts.remote_code = true;
    reasons.push("downloads code from the internet and runs it");
  }

  const installs = parseInstalls(command).filter((pkg) => !allowed(pkg.name ?? pkg.url, allowPackages));
  for (const pkg of installs.filter((p) => p.url)) {
    facts.suspicious = true;
    reasons.push(`installs straight from ${pkg.url}, not from the registry`);
  }
  const named = installs.filter((p) => p.name).slice(0, MAX_PACKAGES);
  if (named.length) {
    const found = await lookup(named, { fetchImpl, stateDir, root: event.projectDir || event.cwd || process.cwd() });
    for (const pkg of named) {
      const label = `${pkg.name} (${pkg.ecosystem})`;
      const info = found.get(`${pkg.ecosystem}:${pkg.name}`);
      if (info?.malware?.length) {
        facts.malicious = true;
        reasons.push(`${label} is known malware (${info.malware.slice(0, 2).join(", ")})`);
        continue;
      }
      const typo = typoOf(pkg.ecosystem, pkg.name);
      if (info?.missing) {
        facts.suspicious = true;
        reasons.push(`${label} doesn't exist on the public registry${typo ? `; did you mean ${typo}?` : ", so the name may be made up"}`);
        continue;
      }
      // a name alone isn't evidence (preact is one letter from react); needs registry data
      if (typo && info && !info.private && !(info.weekly >= 100_000)) {
        facts.suspicious = true;
        reasons.push(`${label} is one letter away from ${typo}; possible typo-squat`);
        continue;
      }
      if (info && !info.private) {
        if (info.ageDays !== null && info.ageDays !== undefined && info.ageDays < NEW_DAYS) {
          facts.suspicious = true;
          reasons.push(`${label} was first published ${Math.max(0, Math.round(info.ageDays))} days ago`);
        } else if (typeof info.weekly === "number" && info.weekly < LOW_WEEKLY && (info.ageDays ?? 0) < 365) {
          facts.suspicious = true;
          reasons.push(`${label} has only ${info.weekly} downloads a week`);
        }
      }
    }
  }
  const look = facts.malicious || facts.suspicious || facts.remote_code;
  return { look, reasons, facts };
}
