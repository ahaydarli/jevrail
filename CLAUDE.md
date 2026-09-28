# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

jevrail is a hook runtime that guards a coding agent. It covers shell commands, file edits, web fetches and MCP tool calls. It warns about prompt injection in fetched content and notices when its own settings are tampered with. Judgement calls go to Jev (Typesafe's classifier, `https://api.typesafe.ai/v1/systemone`); clear-cut cases are decided locally. Focus is Claude Code first, shipped as a plugin from this repo. Other harnesses (Codex, Copilot, Cursor, Gemini) come later.

## Commands

Plain ESM on Node ≥ 20, managed with pnpm. There are no dependencies and no build or lint step.

```bash
pnpm test                                                      # node --test, all offline (Jev is faked)
node --test --test-name-pattern "MCP" test/jevrail.test.mjs    # single test by name regex
node bin/jevrail.mjs check "git push --force origin main"      # real guard on a shell command
node bin/jevrail.mjs check --tool mcp__github__merge_pull_request '{"pullNumber":1}'   # any tool call
node bin/jevrail.mjs check --unattended ...                    # as if nobody can answer a prompt
node bin/jevrail.mjs log                                       # recent decisions ([local] = no Jev call)
node bench/eval.mjs            # command guard vs bench/commands.mjs
node bench/eval-mcp.mjs        # MCP + outbound guards vs bench/mcp.mjs
node bench/eval-injection.mjs  # injection guard vs bench/injection.mjs
pnpm bench                     # Jev latency (warm + cold spawns)
claude plugin validate .       # validate .claude-plugin/ manifests
```

`check`, the `eval*` scripts and `bench` call the real Jev API. They need `TYPESAFE_API_KEY`, either in the environment or in `./.env` (gitignored; start from `cp .env.example .env`).

To try the plugin end to end without touching real state, run a headless session in a scratch directory. Pre-approve only the tool under test, so jevrail is the only thing that can stop it.

```bash
JEVRAIL_STATE_DIR=/tmp/x claude -p --plugin-dir /path/to/jevrail --allowedTools "Bash(rm:*)" "run: rm -rf src" < /dev/null
```

To exercise MCP, add `--mcp-config` pointing at a tiny stdio server. In headless mode, `systemMessage` isn't printed, so check `jevrail log` instead.

## Architecture

Every entry point, whether plugin hooks, `install`-written hooks or the CLI, ends up in `bin/jevrail.mjs` → `src/cli.mjs run()`. `jevrail hook` reads the payload from stdin and calls `handleHook` in `src/hook.mjs`, which dispatches on the normalized event:

- **`session_start`:**
  - Snapshots how jevrail is set up (`src/integrity.mjs`).
  - Returns `watchPaths`: the settings files and `.jevrail/config.json`.
  - Warns when there's no key and some rule needs Jev.
- **`file_changed`:** compares the changed file with the snapshot. If jevrail was removed, the plugin disabled, `disableAllHooks` set, or the rules changed, it returns a `systemMessage` and logs it. FileChanged can't block anything.
- **`pre_tool`, `post_tool`:** `evaluate` then `format`.
- **`prompt`, `stop`:** the memory path (below).

Normalization (`src/harness/claude.mjs normalize`) gives each event these fields:
- `event`
- `tool`: `shell`, `edit`, `write`, `web`, `mcp` and others
- `command`
- `toolInput`
- `toolResponse`
- `mcp: {server, action}`
- `canPrompt`: false in `bypassPermissions` and `dontAsk`
- `projectDir`: `CLAUDE_PROJECT_DIR`, else `cwd`. File checks resolve paths against it.

This adapter is also used for Codex and Copilot payloads for now.

**`evaluate` (`src/engine.mjs`):**
1. Pick rules by `on` and `tools`.
2. Run each rule's `prefilter` from `PREFILTERS`:
   - `risky-shell`: `src/shell.mjs`
   - `risky-file`, `tamper`: `src/files.mjs`
   - `outbound`, `risky-mcp`, `untrusted`: `src/tools.mjs`
3. Rules with no `ask` questions are **decided locally**, with no key or network needed. The reason defaults to the prefilter's reasons.
4. The rest share **one** Jev call, keyed `r<index>_<name>`, with a 7-day cache in `src/cache.mjs`.
5. `decideRule` takes the first matching row. The strictest verdict wins: `deny` > `ask` > `warn` > `allow`.

A local `deny` skips Jev, and a Jev failure never weakens a local verdict. `stateFor` builds what Jev sees:
- for shell: the scrubbed command plus `noticed` signals
- for MCP: the tool, server, action and scrubbed input
- for post-tool: `excerpt()` of the scrubbed response, which keeps lines addressed to an AI from the middle of long content

**`format`** maps results to Claude's JSON:
- **PreToolUse:** `permissionDecision` ask/deny. `warn` becomes `additionalContext`.
- **PostToolUse:** `additionalContext` for Claude plus a `systemMessage` for the user.
- **SessionStart:** `watchPaths` and `systemMessage`.
- **FileChanged:** `systemMessage`.

Built-in rules live in `src/rules/builtin.mjs`, and the rule format is documented at its top:

| Rule | Decided by | Covers |
|---|---|---|
| `tamper-guard` | local | shell, edit, write |
| `command-guard` | Jev | shell |
| `file-guard` | local | edit, write |
| `outbound-guard` | local | web, mcp |
| `mcp-guard` | Jev | mcp; reads `risk.p.block` and `risk.p.safe`, not the top pick |
| `injection-guard` | Jev | post_tool on web, mcp, shell; `warn` only |

Custom rules come from `.jevrail/config.json` (`src/config.mjs loadConfig`). A custom rule with a built-in's `id` replaces that built-in, and `disable` removes rules or `memory`.

Credential detection is in `src/secrets.mjs`. It covers known token formats, plus random-looking values assigned to secret-ish names, plus URL parameters. It aims for precision, since every hit becomes a prompt. Placeholders, env lookups and presigned-URL signature parameters are excluded.

The memory path in `hook.mjs` works like this:
- On `prompt`, it injects the matching lines from `JEVRAIL.md` (`src/memory.mjs`, no Jev call) and stores the prompt as pending in the state dir.
- On `stop`, it asks Jev's `MEMORY_QUESTIONS` (`src/jev.mjs`) about that prompt and may append or supersede a line.

## Invariants to preserve

- **Fail open, never crash the agent.** `handleHook` catches everything and returns null. `bin/jevrail.mjs` exits 0 for `hook` even on errors.
- **Never emit "allow".** `format` returns null for `allow`, so the user's permission settings decide. jevrail only adds friction.
- **Scrub before sending.** Everything sent to Jev goes through `stateFor` and `scrubText` (`src/memory.mjs`). File edit contents are never sent.
- **Unattended:** a row's `unattended` replaces `ask` when `canPrompt` is false. If it is missing, the result is `deny`.
- **State lives outside the project.** The cache, `decisions.jsonl`, pending prompts and `integrity/` snapshots go to `JEVRAIL_STATE_DIR`, or `$XDG_CACHE_HOME/jevrail`, or `~/.cache/jevrail`.
- **API key lookup order** (`config.mjs loadKey`):
  1. `CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY` (the plugin's sensitive `userConfig`).
  2. `TYPESAFE_API_KEY`.
  3. `<project>/.env`.
  4. `~/.config/jevrail/.env`.
- **Don't trip on developing jevrail itself.** `tamper-guard` skips jevrail's own code when that checkout is inside the project.

## Two ways hooks get installed; keep them in sync

- **Plugin:** `.claude-plugin/plugin.json` and `marketplace.json` (the install id is `jevrail@jevrail`), plus `hooks/hooks.json`.
- **`src/install.mjs`:**
  - `install claude` writes the same events and matchers into `.claude/settings.local.json`. The matchers are `CLAUDE_TOOLS` and `CLAUDE_RESULTS`.
  - `--shared` enables the plugin in `.claude/settings.json` instead.
  - `uninstall` removes both.

The events and matchers:
- SessionStart: all sources.
- PreToolUse: `Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch|WebSearch|mcp__.*`.
- PostToolUse: `Bash|WebFetch|WebSearch|mcp__.*`.
- FileChanged: no matcher; `watchPaths` come from SessionStart.
- UserPromptSubmit and Stop.

The test "plugin hooks match what install writes" fails if the two drift apart. Every hook call costs about 55ms of Node startup, so widen matchers only deliberately.

## Changing the guards

Every Jev threshold was tuned on a labelled set. The tuning notes are in comments next to each `decide`.

| Rule | Labelled set | Eval |
|---|---|---|
| `command-guard` and the `src/shell.mjs` fast path | `bench/commands.mjs` | `bench/eval.mjs` |
| `mcp-guard`, `outbound-guard` and `classifyMcp` | `bench/mcp.mjs` | `bench/eval-mcp.mjs` |
| `injection-guard` and `classifyUntrusted` | `bench/injection.mjs` | `bench/eval-injection.mjs` |

After changing a rule, a prefilter or a question's wording:
1. Rerun the matching eval.
2. Update the numbers in README's "How well it works" section.
3. Add a few items tagged `"added"` that you haven't tuned on, as a check.

The local checks must pass every risky item on to Jev.

README's `$ jevrail check …` examples are real outputs. After changing output formats or thresholds, re-run them rather than hand-editing.

In tests, `fakeJev()` answers by question-key suffix: `_risk` (with optional `probabilities`), `_leaks_secret` and `_injection`. A new built-in question needs a matching branch there.

## CI and releases

- **`.github/workflows/ci.yml`** runs on pushes to main and on PRs:
  - `pnpm test` on Node 20, 22 and 24 on Linux, plus Node 24 on macOS
  - `claude plugin validate .`
  - `npm pack --dry-run`
- **`.github/workflows/eval.yml`** runs by hand and every Monday. It runs the three evals with `--strict`, which exits 1 on any mistake, against the real Jev API. It needs a `TYPESAFE_API_KEY` repository secret.
- **`.github/workflows/release.yml`** runs on a `v*` tag. It checks that the tag equals `package.json`'s version, runs the tests, does `npm publish` with npm trusted publishing (OIDC, no token, provenance included), then creates a GitHub release.

Releasing a version:
1. Bump `version` in `package.json`.
2. Commit.
3. Run `git tag v<version> && git push --follow-tags`.

`files` in `package.json` decides what ships. Tests and `bench/` stay out. `.claude-plugin/`, `hooks/` and `commands/` ship, so the plugin can later be sourced from npm.

**The very first publish can't use trusted publishing**, because npm configures a trusted publisher on a package that already exists. So:
1. Publish 0.1.0 by hand with `npm login && npm publish --access public`.
2. On npmjs.com, go to the package's Settings → Trusted publishing, and add GitHub Actions with user `ahaydarli`, repo `jevrail` and workflow `release.yml`. Allow `npm publish`: configurations created after 2026-09-03 default to `npm stage publish` only.
3. Optionally, turn off token publishing for the package.
