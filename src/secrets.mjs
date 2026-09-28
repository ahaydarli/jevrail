// Finding real credentials in text an agent is about to write or send.
// Precision matters more than recall here: a hit turns into a prompt.

// Formats specific enough that a match is almost surely a real credential.
const LIVE_SECRETS = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ["OpenAI or Anthropic key", /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}\b/],
  ["Stripe key", /\b[sr]k_live_[A-Za-z0-9]{20,}\b/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}\b/],
];
const PLACEHOLDER = /example|placeholder|dummy|fake|sample|changeme|your[_-]|x{6,}|\.{3}|<[^>]*>|\{\{/i;

// password = "…", apiKey: '…', "client_secret": "…" with a literal value
const ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer)[A-Za-z0-9_]*)["']?\s*[:=]\s*(["'`])([^"'`\s]{16,200})\2/gi;

function entropy(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

// Random-looking: high entropy and at least three kinds of character.
function looksRandom(value) {
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  return kinds >= 3 && entropy(value) >= 3.5;
}

// Returns a short description of the first credential found, or null.
export function findSecret(text) {
  const body = String(text ?? "");
  if (!body) return null;
  for (const [name, pattern] of LIVE_SECRETS) {
    const match = body.match(pattern);
    if (match && !PLACEHOLDER.test(match[0])) return `a live ${name}`;
  }
  for (const [, name, , value] of body.matchAll(ASSIGNMENT)) {
    // env lookups and template references are how it should be done
    if (/^(?:process\.env|os\.environ|env\.|\$)/.test(value) || PLACEHOLDER.test(value)) continue;
    if (looksRandom(value)) return `a hard-coded secret in ${name}`;
  }
  return null;
}

const SECRET_PARAM = /secret|password|passwd|token|api[_-]?key|access[_-]?key|credential/i;
// presigned cloud URLs carry signatures by design
const SIGNED_URL_PARAM = /^x-(?:amz|goog)-/i;

// Credentials in a URL: user:password@host, or a secret-looking query value.
export function findSecretInUrl(text) {
  const found = findSecret(text);
  if (found) return found;
  let url;
  try {
    url = new URL(String(text ?? ""));
  } catch {
    return null;
  }
  if (url.password) return "a password in the URL";
  for (const [name, value] of url.searchParams) {
    if (SECRET_PARAM.test(name) && !SIGNED_URL_PARAM.test(name) && value.length >= 16 && !PLACEHOLDER.test(value) && looksRandom(value)) {
      return `a secret in the URL parameter ${name}`;
    }
  }
  return null;
}
