---
name: heuristics
description: Design of the permission heuristics system (cwd-confinement) in pi-bash-sandbox.
category: design
---

# Heuristics System

Orchestration lives in `sandbox/resolve.ts` (`resolvePermission`), used by `tools/bash.ts`. Resolution is per line (parseBash splits newlines), most-restrictive wins across lines/segments. Per line:
1. Whole-line pattern match (chain-aware patterns like `"cd * && npx vitest | tail *"` work here) always wins → heuristic skipped.
2. Else per-segment (split at chain operators via `splitAtChainOperators`): each segment tries patterns (`getArgsPermissionMatch`), then — only if the segment would prompt (ask default) — the cwd-confinement heuristic (`getArgsConfinementPermission`). A non-ask `**` default stands as-is: heuristics neither relax a `deny` default nor downgrade an `allow` default.

Consequence: a rule like `"npx *": "allow"` covers `npx vitest` inside chains and DOMINATES heuristic grants — combination rule: heuristic grants only rescue would-prompt segments, never downgrade policy (explicit/default) results. deny dominates, then unresolved → ask, then policy most-restrictive, then heuristic-only chains → heuristic permission ("allow:sandbox"). So an explicit `allow` rule makes chained heuristic segments run UNSANDBOXED.

Note: `parseBash` keeps chain operators as args — whole-line patterns must include them explicitly. Integration tests: `test/sandbox/resolve.test.ts` (pass `permissions` + `cwdConfinement` explicitly to stay hermetic).

## cwd-confinement heuristic (`sandbox/heuristics.ts`)

- Known commands registry (`KNOWN_COMMANDS`) holds per-command argument semantics (`CommandSpec`): `positionals` mode, `valueFlags` (value definitely NOT a path), `pathFlags`, `unsafeFlags` (e.g. find `-delete`/`-exec`, sort `--compress-program`), `patternBypassFlags` (grep `-e`/`-f`).
- Conservative by design: any unclassifiable arg is treated as a path and must resolve (lexically, via `path.resolve`) inside cwd; only `valueFlags` and grep's pattern skip bypass path-checking — so mis-curation of `valueFlags` is the only risky direction.
- `parseBash` keeps chain operators (`&&`, `|`, `;`, `&`) as args — `splitAtChainOperators` splits segments before per-command evaluation.
- Commands invoked by path (`./cat`, `/tmp/cat`) are never trusted (basename lookup would allow a malicious binary masquerading as a known command).
- Leading env assignments (`FOO=bar cmd`): dangerous names are rejected outright (`LD_*` prefix, PATH, IFS, CDPATH, BASH_ENV, ENV, SHELLOPTS, BASHOPTS, PROMPT_COMMAND, GCONV_PATH); other assignment VALUES are path-checked like any other path (so `FOO=/etc/passwd cat x` falls back).
- Sensitive-path check also runs against the CANONICAL (realpath'd) path — a symlink named `notes.txt` pointing at `.env` is rejected.
- Subshells/process substitutions (including redirection targets) recurse through `isConfined`.
- `/dev/null` etc. are allowlisted as special paths (sandbox devtmpfs).
- Config: `heuristics.cwdConfinement` = `{ enabled (default true), permission (default "allow:sandbox"), commands (allowlist over registry), denyPaths (extra sensitive segment globs), blockDotfiles (paranoid mode), resolveSymlinks (default true) }`; merged field-wise in `common/config.ts` (denyPaths concatenated + deduped).
- Registry curation principle: commands that can EXECUTE code are never added (awk `system()`, sed `e` command, node/python, env-with-command) — those belong in explicit allow rules, which are the deliberate opt-in that dominates the heuristic. unsafeFlags also covers value-taking flags (e.g. `tar -I prog`, `sort --compress-program`). Two-value flags whose second value is a file (jq `--slurpfile name file`) are unsafeFlags, because the single-value model would leave the file unchecked (it would land in the first-pattern slot). Long valueFlags with separate values do NOT skip the value token (only short-cluster/inline forms do) — the value is positionally path-checked, which is conservative and fine for numeric/relative values.

## Symlink hardening (resolveSymlinks)

- Path args are canonicalized with `fs.realpathSync` against `realpathSync(cwd)` (stored as `options.realCwd`; null = check disabled, e.g. nonexistent cwd in tests).
- Kernel resolves full chains (link→link→outside caught); intermediate dir components too.
- Non-existent write targets: canonicalize nearest existing ancestor. Dangling symlinks (realpath throws while lstat succeeds) are REJECTED — writing through them would create the file at the target.
- Symlinks *inside* directory args are NOT walked; instead follow-symlink traversal flags are unsafeFlags: find `-L`, grep `-R`/`--dereference-recursive`, du `-L`/`--dereference-all`, tree `-l`. Default traversal modes of find/grep -r/du/ls -R/tree don't follow symlinks.
- Remaining caveat: TOCTOU (path swapped between check and exec) — accepted risk.

## Sensitive paths (secrets protection, "layer 1")

- `DEFAULT_SENSITIVE_PATTERNS` in heuristics.ts: glob per resolved-path segment — `.env*`, `.git`, credential dirs (`.ssh`/`.aws`/`.gnupg`/`.kube`/`.docker`/`.gcloud`), credential files (`.netrc`/`.npmrc`/`.pgpass`/`.my.cnf`/`.htpasswd`), private keys (`id_rsa*`, `*.pem`, `*.key`, `*.p12`, ...), `*.tfvars`, `credentials`. Always applies; `denyPaths` extends it.
- Known hole (documented): path-based checks don't cover traversal reads — `grep -r token .` reads `.env` content while the path arg is `.`. Discussed but not implemented: sandbox masking via `--ro-bind /dev/null <secret>` (layer 2), tool_result output redaction (layer 3).

## Known limitations (documented in docs/configuration.md)

- PATH trust: known command names are assumed to be real system binaries.
- Sandbox does not isolate the network namespace.
- Symlink check is time-of-check (TOCTOU accepted risk); see symlink hardening section.

Tests: `test/sandbox/heuristics.test.ts` (pass config object explicitly; fake cwd like "/project" disables realpath via fail-open — symlink tests use a real temp dir + fixtures). Property fuzz tests: `test/sandbox/fuzz.test.ts` — seeded PRNG (mulberry32, seed 42, override via FUZZ_SEED env), asserts invariants over structured chains: token soup never crashes, unsafe segment ⇒ ask, all-safe ⇒ allow:sandbox, deny dominance, explicit-allow dominance.
