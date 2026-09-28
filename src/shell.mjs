// Local fast path for shell commands. Jev takes ~0.5–1s per call, so most
// commands are cleared here and only the ones that might do damage are sent on.
// This never blocks anything by itself: "risky" only means "ask Jev".

const SAFE_PROGRAMS = new Set([
  // reading and searching
  "ls", "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "ack", "fd",
  "wc", "sort", "uniq", "cut", "tr", "awk", "jq", "yq", "column", "paste", "diff", "cmp", "comm",
  "file", "stat", "du", "df", "tree", "realpath", "readlink", "basename", "dirname", "pwd", "which",
  "type", "command", "whoami", "id", "uname", "hostname", "date", "cal", "uptime", "ps", "lsof",
  "top", "htop", "man", "history", "echo", "printf", "true", "false", "test", "[", "sleep", "seq",
  "yes", "tee", "xxd", "od", "hexdump", "strings", "nl", "fold", "fmt", "rev", "tac", "md5",
  "md5sum", "shasum", "sha256sum", "base64", "open", "code", "pbcopy", "pbpaste", "clear",
  // shell builtins that only change the shell
  "cd", "pushd", "popd", "export", "unset", "set", "alias", "source", ".", "wait", "jobs",
  // creating things inside the project
  "mkdir", "touch", "sed", "patch", "tar", "zip", "unzip", "gzip", "gunzip", "xargs", "truncate",
  // build, test, lint, format
  "make", "just", "task", "tsc", "tsx", "ts-node", "node", "deno", "python", "python3", "pip",
  "pip3", "uv", "pytest", "ruby", "bundle", "rake", "go", "cargo", "rustc", "rustup", "java",
  "javac", "mvn", "gradle", "./gradlew", "dotnet", "swift", "xcodebuild", "jest", "vitest",
  "mocha", "playwright", "eslint", "prettier", "biome", "ruff", "black", "mypy", "pyright",
  "flake8", "isort", "rubocop", "golangci-lint", "shellcheck", "hadolint", "turbo", "nx", "vite",
  "webpack", "esbuild", "rollup", "next", "nuxt", "astro", "storybook", "kill", "pkill", "killall",
  // tools with their own subcommand rules below
  // (what npx, bunx, uvx and pipx fetch is checked by the supply-chain guard)
  "git", "npm", "npx", "pnpm", "yarn", "bun", "bunx", "uvx", "pipx", "poetry", "gem", "twine", "docker",
  "podman", "kubectl", "helm", "terraform", "tofu", "gh", "curl", "wget", "http", "https",
  "find", "rm", "rmdir", "mv", "cp", "ln", "chmod", "chown", "chgrp", "env", "psql", "mysql",
  "sqlite3", "mongosh", "mongo", "redis-cli",
]);

// Directories an agent may wipe freely because a build or install recreates them.
const REGENERABLE =
  /^(?:\.\/)?(?:[\w.-]+\/)*(?:node_modules|dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache|\.vite|target|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|venv|\.tox|tmp|\.tmp)\/?$/;

const SECRET_PATH =
  /(?:^|[\/\s@="'])(?:\.env(?![\w.-]*\.(?:example|sample|template|dist)\b)(?:\.[\w-]+)?|\.ssh\/|id_(?:rsa|ed25519|ecdsa|dsa)\b|\.aws\/credentials|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|\.docker\/config\.json|\.kube\/config|credentials\.json|service-account[\w-]*\.json|[\w-]+\.pem\b|[\w-]+\.key\b|\.gnupg\/)/;

export const DESTRUCTIVE_SQL =
  /\b(?:drop|truncate|delete|update|alter|insert|grant|revoke|flushall|flushdb|dropdatabase|del)\b/i;

// $OPENAI_API_KEY, ${GITHUB_TOKEN}, $DB_PASSWORD ...
const SECRET_VAR = /\$\{?[A-Za-z_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)[A-Za-z0-9_]*\}?/i;

// Schema and data changes run through framework CLIs rather than a SQL client.
const DB_CHANGE = new RegExp(
  [
    "prisma\\s+(?:migrate\\s+(?:deploy|reset|resolve)|db\\s+(?:push|execute|seed))",
    "manage\\.py\\s+(?:migrate|flush|sqlflush|loaddata)",
    "\\bdb:(?:drop|reset|migrate|rollback|schema:load|seed|setup|wipe)",
    "artisan\\s+migrate",
    "alembic\\s+(?:upgrade|downgrade|stamp)",
    "knex\\s+migrate",
    "sequelize(?:-cli)?\\s+db:",
    "drizzle-kit\\s+(?:push|migrate|drop)",
    "typeorm\\s+(?:migration:run|migration:revert|schema:drop|schema:sync)",
    "flyway\\s+(?:migrate|clean|repair)",
    "liquibase\\s+(?:update|drop|rollback)",
    "supabase\\s+db\\s+(?:push|reset)",
  ].join("|"),
);

const INLINE_CODE_DANGER =
  /\b(?:rmtree|unlink|rmdir|rmSync|unlinkSync|os\.remove|os\.system|subprocess|child_process|execSync|spawnSync|shutil|requests\.(?:post|put|delete)|fetch\(|drop\s+table|rm\s+-)/i;

const REMOTE_PROGRAMS = new Set(["ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp"]);
const SYSTEM_PROGRAMS = new Set([
  "sudo", "doas", "su", "dd", "mkfs", "fdisk", "parted", "diskutil", "wipefs", "shred", "srm",
  "shutdown", "reboot", "halt", "poweroff", "launchctl", "systemctl", "service", "crontab",
  "eval", "exec", "sh", "bash", "zsh", "fish", "dash", "iptables", "ufw", "chattr", "mount", "umount",
]);
const CLOUD_PROGRAMS = new Set([
  "aws", "gcloud", "gsutil", "az", "doctl", "flyctl", "fly", "vercel", "netlify", "wrangler",
  "heroku", "firebase", "supabase", "railway", "render", "pulumi", "cdk", "serverless", "sls",
]);
const READ_VERBS = new Set([
  "describe", "list", "ls", "get", "show", "whoami", "logs", "status", "info", "version",
  "help", "--help", "-h", "--version", "view", "inspect", "validate", "plan", "preview",
]);

// Keywords that start a command without being one (`then rm x`), and loop or
// case headers that run nothing themselves (`for f in *.ts`).
const SHELL_PREFIX = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "}"]);
const SHELL_HEADER = new Set(["for", "case", "select", "in", "done", "fi", "esac", "function", "[[", "]]"]);

// Remove heredoc bodies so their contents are not read as commands.
function stripHeredocs(command) {
  const lines = command.split("\n");
  const out = [];
  let delimiter = null;
  for (const line of lines) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    out.push(line);
    const match = line.match(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/);
    if (match) delimiter = match[2];
  }
  return out.join("\n");
}

// Split into simple commands on ; && || | & and newlines, respecting quotes.
// Returns [{ words, redirects }] plus any $(...) or `...` bodies as extra text.
export function parse(command) {
  const text = stripHeredocs(command);
  const segments = [];
  const nested = [];
  let words = [];
  let redirects = [];
  let word = "";
  let quote = null;
  let pendingRedirect = false;
  let quoted = false;

  const endWord = () => {
    if (word === "" && !quoted) return;
    if (pendingRedirect) {
      redirects.push(word);
      pendingRedirect = false;
    } else {
      words.push(word);
    }
    word = "";
    quoted = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length || redirects.length) segments.push({ words, redirects });
    words = [];
    redirects = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      word += text[++i];
      continue;
    }
    if (ch === "$" && text[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "(") depth += 1;
        else if (text[j] === ")") depth -= 1;
        j += 1;
      }
      nested.push(text.slice(i + 2, j - 1));
      word += "$(…)";
      i = j - 1;
      continue;
    }
    if (ch === "`") {
      const j = text.indexOf("`", i + 1);
      const end = j === -1 ? text.length : j;
      nested.push(text.slice(i + 1, end));
      word += "$(…)";
      i = end;
      continue;
    }
    if (ch === "#" && word === "" && (i === 0 || /\s/.test(text[i - 1]))) {
      while (i < text.length && text[i] !== "\n") i += 1;
      endSegment();
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
      if (ch === "&" && text[i + 1] === ">") {
        endWord();
        i += text[i + 2] === ">" ? 2 : 1;
        pendingRedirect = true;
        continue;
      }
      endSegment();
      if ((ch === "&" || ch === "|") && text[i + 1] === ch) i += 1;
      continue;
    }
    if (ch === ">" || ch === "<") {
      const fd = /^\d$/.test(word) ? word : null;
      if (fd !== null) word = "";
      endWord();
      if (text[i + 1] === ">" || (ch === "<" && text[i + 1] === "<")) i += 1;
      if (text[i + 1] === "&") {
        // >&2, 2>&1: duplicating a descriptor, not writing a file
        i += 1;
        while (i + 1 < text.length && /[\d-]/.test(text[i + 1])) i += 1;
        continue;
      }
      if (ch === ">") pendingRedirect = true;
      else words.push("<");
      continue;
    }
    if (/\s/.test(ch)) {
      endWord();
      continue;
    }
    word += ch;
  }
  endSegment();
  return { segments, nested };
}

function isOutsidePath(arg) {
  if (!arg) return false;
  if (arg === "/dev/null" || arg === "/dev/stdout" || arg === "/dev/stderr") return false;
  if (arg.startsWith("/tmp/") || arg.startsWith("/private/tmp/") || arg.startsWith("/var/folders/")) {
    return false;
  }
  return arg.startsWith("/") || arg.startsWith("~") || arg.startsWith("$HOME") || arg.split("/").includes("..");
}

function positional(args) {
  return args.filter((arg) => !arg.startsWith("-"));
}

function hasFlag(args, short, long = []) {
  return args.some(
    (arg) =>
      long.includes(arg) ||
      (arg.startsWith("-") && !arg.startsWith("--") && short.split("").some((c) => arg.slice(1).includes(c))),
  );
}

function firstSub(args, skipWithValue = []) {
  for (let i = 0; i < args.length; i += 1) {
    if (skipWithValue.includes(args[i])) {
      i += 1;
      continue;
    }
    if (!args[i].startsWith("-")) return { sub: args[i], rest: args.slice(i + 1) };
  }
  return { sub: "", rest: [] };
}

const GIT_SAFE = new Set([
  "status", "diff", "log", "show", "add", "commit", "fetch", "pull", "rev-parse", "blame", "grep",
  "ls-files", "ls-tree", "merge-base", "describe", "shortlog", "cherry-pick", "merge", "rebase",
  "init", "clone", "switch", "config", "remote", "worktree", "reflog", "bisect", "cat-file",
  "rev-list", "reset", "name-rev", "for-each-ref", "symbolic-ref", "check-ignore", "mv", "rm", "apply",
  "format-patch", "am", "notes", "submodule", "lfs", "restore", "checkout", "branch", "tag", "stash",
]);

function checkGit(args) {
  const { sub, rest } = firstSub(args, ["-C", "-c", "--git-dir", "--work-tree"]);
  if (!sub) return null;
  if (sub === "push") return "git push publishes to a remote";
  if (sub === "reset" && rest.includes("--hard")) return "git reset --hard discards work";
  if (sub === "clean") return "git clean deletes untracked files";
  if (sub === "filter-branch" || sub === "filter-repo") return "rewrites history";
  if (sub === "update-ref" && rest.includes("-d")) return "deletes a ref";
  if (sub === "gc" && rest.some((arg) => arg.startsWith("--prune"))) return "prunes objects";
  if (sub === "reflog" && rest[0] === "expire") return "expires the reflog";
  if (sub === "branch" && (hasFlag(rest, "D") || (hasFlag(rest, "d", ["--delete"]) && hasFlag(rest, "f", ["--force"])))) {
    return "force-deletes a branch";
  }
  if (sub === "rebase" && (hasFlag(rest, "i", ["--interactive"]) || rest.includes("--root"))) return "rewrites commit history";
  if (sub === "tag" && hasFlag(rest, "d", ["--delete"])) return "deletes a tag";
  if (sub === "stash" && ["drop", "clear"].includes(rest[0])) return "drops stashed work";
  if (sub === "checkout" && (rest.includes("--") || rest.includes(".") || hasFlag(rest, "f", ["--force"]))) {
    return "git checkout can discard local changes";
  }
  if (sub === "restore" && !rest.includes("--staged") && !rest.includes("-S")) {
    return "git restore discards local changes";
  }
  if (sub === "remote" && ["remove", "rm", "set-url"].includes(rest[0])) return "changes remotes";
  if (sub === "submodule" && rest[0] === "deinit") return "removes a submodule";
  if (!GIT_SAFE.has(sub)) return `git ${sub}`;
  return null;
}

// Script and make targets whose name says they ship or destroy something.
const RISKY_SCRIPT = /(?:^|[:_\-])(?:deploy|release|publish|ship|destroy|teardown|nuke|purge|rollback)(?:$|[:_\-])/i;

function checkScript(program, name) {
  return name && RISKY_SCRIPT.test(name) ? `${program} runs the "${name}" script` : null;
}

const PUBLISH = new Set(["publish", "unpublish", "deprecate", "owner", "access", "token", "login", "adduser", "dist-tag", "logout"]);

const PM_COMMANDS = new Set(["install", "i", "ci", "add", "remove", "uninstall", "update", "upgrade", "test", "exec", "dlx", "create", "init", "link", "outdated", "audit", "why", "ls", "list", "view", "info", "pack", "config", "cache", "x"]);

function checkPackageManager(program, args) {
  const { sub, rest } = firstSub(args);
  if (PUBLISH.has(sub)) return `${program} ${sub} affects the registry`;
  if (sub === "run" || sub === "run-script") {
    const script = checkScript(program, positional(rest)[0]);
    if (script) return script;
  } else if (["yarn", "pnpm", "bun"].includes(program) && !PM_COMMANDS.has(sub)) {
    // `yarn deploy` runs the deploy script
    const script = checkScript(program, sub);
    if (script) return script;
  }
  if (hasFlag(args, "g", ["--global", "--location=global"]) || (program === "yarn" && sub === "global")) {
    return `${program} installs globally`;
  }
  if (program === "npx" || program === "bunx") {
    const tool = positional(args)[0] ?? "";
    if (/rimraf|del-cli|trash/.test(tool) && positional(args).slice(1).some(isOutsidePath)) {
      return "deletes outside the project";
    }
  }
  return null;
}

function checkDocker(args) {
  const words = positional(args);
  if (words.some((w) => ["rm", "rmi", "prune", "push", "kill"].includes(w))) return "removes or publishes containers/images";
  if (words.includes("down") && hasFlag(args, "v", ["--volumes"])) return "removes volumes";
  if (words.includes("volume") && words.includes("rm")) return "removes volumes";
  return null;
}

function checkReadOnlyTool(program, args, safe) {
  const { sub } = firstSub(args);
  if (!sub || safe.includes(sub)) return null;
  return `${program} ${sub}`;
}

function checkGh(args) {
  const words = positional(args);
  if (words[0] === "api") {
    const method = args.find((arg, i) => args[i - 1] === "-X" || args[i - 1] === "--method");
    if ((method && method.toUpperCase() !== "GET") || hasFlag(args, "fF", ["--field", "--raw-field", "--input"])) {
      return "gh api writes";
    }
    return null;
  }
  const action = words[1] ?? words[0] ?? "";
  const safe = ["view", "list", "status", "diff", "checkout", "checks", "browse", "search", "watch", "download", "clone", "login", "auth"];
  if (safe.includes(action) || (words[0] === "auth" && action === "status")) return null;
  if (words.length === 0) return null;
  return `gh ${words.slice(0, 2).join(" ")} acts on GitHub`;
}

function checkHttp(args) {
  if (hasFlag(args, "dFT", ["--data", "--data-raw", "--data-binary", "--data-urlencode", "--form", "--upload-file", "--json"])) {
    return "sends data";
  }
  if (args.some((arg) => arg.startsWith("--data") || arg.startsWith("--post-") || arg.startsWith("--body"))) {
    return "sends data";
  }
  const methodIndex = args.findIndex((arg) => arg === "-X" || arg === "--request" || arg === "--method");
  if (methodIndex !== -1 && !/^(GET|HEAD|OPTIONS)$/i.test(args[methodIndex + 1] ?? "")) return "non-GET request";
  if (args.some((arg) => arg.startsWith("-X") && arg.length > 2 && !/^-X(GET|HEAD)$/i.test(arg))) return "non-GET request";
  if (args.some((arg) => /^@/.test(arg))) return "uploads a file";
  return null;
}

const BODY_FLAGS = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form", "--json", "--post-data", "--body-data"]);

function secretInBody(args) {
  return args.some((arg, i) => {
    const inline = arg.match(/^(--[\w-]+)=(.*)$/);
    if (inline && BODY_FLAGS.has(inline[1])) return SECRET_VAR.test(inline[2]);
    return BODY_FLAGS.has(args[i - 1]) && SECRET_VAR.test(arg);
  });
}

function checkSql(args, redirectedInput) {
  if (redirectedInput) return "runs a SQL file";
  if (hasFlag(args, "f", ["--file"])) return "runs a SQL file";
  const text = args.join(" ");
  if (DESTRUCTIVE_SQL.test(text)) return "writes to a database";
  return null;
}

function checkPaths(program, args) {
  const paths = positional(args);
  if (paths.some(isOutsidePath)) return `${program} outside the project`;
  return null;
}

function checkRm(args) {
  const targets = positional(args);
  const recursive = hasFlag(args, "rR", ["--recursive"]);
  for (const target of targets) {
    if (isOutsidePath(target)) return "deletes outside the project";
    if (target === "." || target === "*" || target === "./*" || /(^|\/)\*$/.test(target)) return "deletes everything here";
    if (/[*?]/.test(target)) return "deletes by wildcard";
    if (recursive && !REGENERABLE.test(target)) return "deletes a directory";
  }
  return null;
}

function checkFind(args) {
  if (args.includes("-delete")) return "find -delete";
  if (args.some((arg) => arg === "-exec" || arg === "-execdir" || arg === "-ok")) return "find -exec";
  return null;
}

function checkInlineCode(program, args) {
  const index = args.findIndex((arg) => arg === "-c" || arg === "-e" || arg === "--eval" || arg === "-p");
  if (index === -1) return null;
  const code = args.slice(index + 1).join(" ");
  if (INLINE_CODE_DANGER.test(code)) return `${program} inline code touches files, processes, or network`;
  return null;
}

// Decide one simple command. Returns a reason string when Jev should look.
function checkSegment({ words, redirects }) {
  for (const target of redirects) {
    if (isOutsidePath(target)) return `writes to ${target}`;
    if (SECRET_PATH.test(` ${target}`)) return `writes to a secrets file`;
  }
  let args = [...words];
  // strip shell keywords, VAR=value prefixes and harmless wrappers
  for (;;) {
    if (SHELL_PREFIX.has(args[0])) args.shift();
    else if (args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) args.shift();
    else if (["time", "nice", "nohup", "command", "builtin", "caffeinate"].includes(args[0])) args.shift();
    else if (args[0] === "timeout") args.splice(0, 2);
    else break;
  }
  if (args.length === 0 || SHELL_HEADER.has(args[0])) return null;

  const redirectedInput = args.includes("<");
  args = args.filter((arg) => arg !== "<");
  const [raw, ...rest] = args;
  const program = raw.includes("/") && raw !== "./gradlew" ? raw.split("/").pop() : raw;

  if (words.some((arg) => SECRET_PATH.test(` ${arg}`))) return "reads or touches a secrets file";
  if (words.some((arg) => SECRET_VAR.test(arg))) {
    // a secret in the request body, not an auth header, is how tokens get exfiltrated
    if (["curl", "wget", "http", "https"].includes(program) && secretInBody(rest)) {
      return "sends a secret environment variable in the request body";
    }
    return "uses a secret environment variable";
  }
  if (DB_CHANGE.test(words.join(" "))) return "changes a database schema or data";
  if (SYSTEM_PROGRAMS.has(program) || /^mkfs/.test(program)) return `${program} runs with system-level effect`;
  if (REMOTE_PROGRAMS.has(program)) return `${program} talks to another machine`;
  if (CLOUD_PROGRAMS.has(program)) {
    const verbs = positional(rest);
    const readOnly = verbs.some((v) => READ_VERBS.has(v)) &&
      !verbs.some((v) => /^(delete|rm|remove|destroy|terminate|purge|deploy|publish|put|cp|sync|create|update|set|apply|up|down|scale|rollback)$/.test(v));
    return readOnly ? null : `${program} changes cloud resources`;
  }
  if (program === "xargs") {
    const inner = rest.filter((arg, i) => !arg.startsWith("-") || i > rest.findIndex((a) => !a.startsWith("-")));
    // targets arrive on stdin, so path checks can't see them
    if (["rm", "shred", "mv", "chmod", "chown", "truncate"].includes(inner[0])) return `xargs ${inner[0]} on piped input`;
    return inner.length ? checkSegment({ words: inner, redirects: [] }) : null;
  }
  if (program === "env") {
    const inner = rest.filter((arg) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) && !arg.startsWith("-"));
    return inner.length ? checkSegment({ words: inner, redirects: [] }) : "prints environment variables";
  }
  if (program === "printenv") return "prints environment variables";
  if (!SAFE_PROGRAMS.has(program) && !SAFE_PROGRAMS.has(raw)) return `unknown program ${program}`;

  switch (program) {
    case "git": return checkGit(rest);
    case "npm": case "pnpm": case "yarn": case "bun": case "npx": case "bunx": case "poetry":
      return checkPackageManager(program, rest);
    case "cargo": case "gem": return ["publish", "yank", "push", "owner"].includes(rest[0]) ? `${program} ${rest[0]} affects the registry` : null;
    case "twine": return rest[0] === "upload" ? "uploads a package" : null;
    case "docker": case "podman": return checkDocker(rest);
    case "kubectl": return checkReadOnlyTool(program, rest, ["get", "describe", "logs", "explain", "version", "top", "diff", "config", "api-resources", "auth", "cluster-info", "port-forward"]);
    case "helm": return checkReadOnlyTool(program, rest, ["list", "ls", "template", "lint", "status", "get", "show", "search", "version", "repo", "dependency", "history"]);
    case "terraform": case "tofu":
      if (rest[0] === "state" && ["rm", "mv", "push", "replace-provider"].includes(rest[1])) return "changes terraform state";
      return checkReadOnlyTool(program, rest, ["plan", "validate", "fmt", "init", "show", "output", "providers", "version", "graph", "state", "workspace", "console"]);
    case "gh": return checkGh(rest);
    case "curl": case "wget": case "http": case "https": return checkHttp(rest);
    case "psql": case "mysql": case "sqlite3": case "mongosh": case "mongo": case "redis-cli":
      return checkSql(rest, redirectedInput);
    case "rm": case "rmdir": return program === "rmdir" ? checkPaths(program, rest) : checkRm(rest);
    case "mv": case "tee": case "touch": case "mkdir": case "truncate":
      return checkPaths(program, rest);
    case "cp": case "ln":
      // only the destination matters; reading from elsewhere is fine
      return checkPaths(program, positional(rest).slice(-1));
    case "sed": {
      if (!hasFlag(rest, "i", ["--in-place"])) return null;
      const operands = positional(rest).filter(Boolean);
      const scripted = rest.includes("-e") || rest.some((arg) => arg.startsWith("--expression"));
      return checkPaths(program, scripted ? operands : operands.slice(1));
    }
    case "chmod": case "chown": case "chgrp":
      return hasFlag(rest, "R", ["--recursive"]) ? `${program} -R` : checkPaths(program, rest);
    case "find": return checkFind(rest);
    case "make": case "just": case "task":
      return positional(rest).map((target) => checkScript(program, target)).find(Boolean) ?? null;
    case "python": case "python3": case "node": case "deno": case "ruby": case "perl":
      return checkInlineCode(program, rest);
    default: return null;
  }
}

export function classifyShell(command) {
  const text = String(command ?? "").trim();
  if (!text) return { risky: false, reasons: [] };
  if (text.length > 4000) return { risky: true, reasons: ["very long command"] };
  const reasons = [];
  const pending = [text];
  let depth = 0;
  while (pending.length && depth < 5) {
    const { segments, nested } = parse(pending.shift());
    for (const segment of segments) {
      const reason = checkSegment(segment);
      if (reason) reasons.push(reason);
    }
    pending.push(...nested);
    depth += 1;
  }
  return { risky: reasons.length > 0, reasons };
}
