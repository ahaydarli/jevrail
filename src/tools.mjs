// Local checks for web fetches, MCP tools and the content they bring back.
import { findSecret, findSecretInUrl } from "./secrets.mjs";
import { DESTRUCTIVE_SQL, parse } from "./shell.mjs";

// --- outbound: credentials leaving through a URL or tool arguments ------------

export function classifyOutbound(event) {
  const input = event.toolInput ?? {};
  let found = null;
  if (event.tool === "web") {
    found = findSecretInUrl(input.url ?? "") ?? findSecret(JSON.stringify({ ...input, url: undefined }));
  } else if (event.tool === "mcp") {
    found = findSecret(JSON.stringify(input));
    if (!found) {
      for (const value of Object.values(input)) {
        if (typeof value === "string" && /^https?:\/\//.test(value)) found = findSecretInUrl(value);
        if (found) break;
      }
    }
  }
  if (!found) return { look: false, reasons: [] };
  const where = event.tool === "web" ? "a web request" : `the ${event.mcp?.server ?? "MCP"} server`;
  return { look: true, reasons: [`sends ${found} to ${where}`] };
}

// --- MCP: which calls change something ------------------------------------------

const READ_VERBS = new Set([
  "get", "list", "search", "read", "fetch", "find", "query", "describe", "view", "show", "lookup",
  "count", "check", "status", "retrieve", "browse", "inspect", "explain", "preview", "resolve",
  "download", "export", "whoami", "info", "diff", "compare", "analyze", "summarize", "validate",
  "lint", "test", "load", "open", "select", "wait", "think", "sequentialthinking", "ask",
]);
const BROWSER_SERVER = /playwright|puppeteer|browser|chrome|devtools/i;
const BROWSER_RISKY = /evaluate|run_code|file_upload|install/;

function words(action) {
  return action
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\-.\s]+/)
    .filter(Boolean);
}

export function classifyMcp(event) {
  const { server = "", action = "" } = event.mcp ?? {};
  const verbs = words(action);
  const argsText = JSON.stringify(event.toolInput ?? {});
  // clicking and typing in a test browser is everyday work; running code there is not
  if (BROWSER_SERVER.test(server) || verbs[0] === "browser") {
    return BROWSER_RISKY.test(action)
      ? { look: true, reasons: [`${server} ${action} runs code in the browser`] }
      : { look: false, reasons: [] };
  }
  const first = verbs.find((word) => word !== "mcp") ?? "";
  if (READ_VERBS.has(first)) {
    // a "query" tool can still run DROP TABLE
    if (DESTRUCTIVE_SQL.test(argsText) && /\b(?:sql|query|statement)\b/i.test(argsText)) {
      return { look: true, reasons: [`${server} ${action} runs SQL that changes data`] };
    }
    return { look: false, reasons: [] };
  }
  return { look: true, reasons: [`${server} ${action} changes something`] };
}

// --- untrusted content coming back from outside ------------------------------------

const FETCHERS = new Set(["curl", "wget", "http", "https", "lynx", "w3m"]);
const GH_READS = /^(?:issue|pr|release|repo|gist|discussion)$/;

function fetchesRemote(command) {
  const { segments, nested } = parse(command);
  return [...segments, ...nested.flatMap((text) => parse(text).segments)].some(({ words: [raw = "", ...args] }) => {
    const program = raw.split("/").pop();
    if (FETCHERS.has(program)) return true;
    if (program === "gh") return args[0] === "api" || (GH_READS.test(args[0] ?? "") && ["view", "list", "diff"].includes(args[1]));
    return false;
  });
}

// The text a tool returned, whatever its shape.
export function responseText(response) {
  if (response === null || response === undefined) return "";
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return response.map(responseText).join("\n");
  if (typeof response === "object") {
    if (response.type === "text" && typeof response.text === "string") return response.text;
    const parts = [];
    for (const key of ["stdout", "result", "body", "content", "text", "output", "results", "data"]) {
      if (key in response) parts.push(responseText(response[key]));
    }
    return parts.filter(Boolean).join("\n");
  }
  return "";
}

const MIN_CONTENT = 40;

export function classifyUntrusted(event) {
  const text = responseText(event.toolResponse);
  if (text.length < MIN_CONTENT) return { look: false, reasons: [] };
  if (event.tool === "web") return { look: true, reasons: ["content fetched from the web"] };
  if (event.tool === "mcp") {
    if (BROWSER_SERVER.test(event.mcp?.server ?? "")) return { look: false, reasons: [] };
    return { look: true, reasons: [`content returned by the ${event.mcp?.server} server`] };
  }
  if (event.tool === "shell" && fetchesRemote(event.command ?? "")) {
    return { look: true, reasons: ["output of a command that fetches remote content"] };
  }
  return { look: false, reasons: [] };
}
