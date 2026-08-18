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

- Layout: `sandbox/heuristics.ts` = engine (parsing, path checks, config, public API; re-exports `KNOWN_COMMANDS`/`CommandSpec`/`FlagSpec`/`splitAtChainOperators`/`getCwdConfinementPermission`/`getArgsConfinementPermission` so imports stay stable). `sandbox/commands/` = data: `spec.ts` (FlagSpec/CommandSpec + VALUE/VALUE2/PATH_VALUE/UNSAFE shorthands), one file per registry group (readers, directories, paths, text, comparison, checksums, archives, vcs, system), `index.ts` merges them into `KNOWN_COMMANDS` via spreads — NOTE: spread-merge silently shadows duplicate keys across groups (the old single literal would have errored); 72 commands, no duplicates. Identical specs are shared objects, not copies (grep/egrep/fgrep/zgrep, fd/fdfind, diff/diff3, git log/whatchanged).
- Known commands registry (`KNOWN_COMMANDS`) holds per-command argument semantics. Flag model (2025 redesign, hard cutover of the old valueFlags/pathFlags/unsafeFlags arrays): `flags: Record<string, FlagSpec>` keyed by full flag name ("-n"/"--max-count"); `FlagSpec = { values?: n (0 = boolean), pathSlots?: number[] (which consumed value slots are paths), unsafe?: boolean }`. Values are consumed in ALL forms (`-x v`, `-xv`, `--x v`, `--x=v`; inline fills slot 0, multi-value inline is ineligible). Unknown flags: long w/ inline value → value path-checked, else boolean; short clusters per-char; single-dash MULTI-char tokens (find `-exec`/`-delete`/`-fprint`) are whole-arg flag lookups, NOT clusters — the whole-arg unsafe check is load-bearing. `positionals` modes: paths (default) / none / ignore / first-pattern (pattern slot, rest paths; patternBypassFlags force all-paths) / first-path (first positional a path, rest data — tar/unzip archives + member names). `safeModeFlags` = eligible only when one is present (unzip default mode extracts; -l/-p/-t/-v/-z are safe modes). `subcommands` (git): first positional selects the sub spec; the parent spec governs pre-dispatch args, the sub spec governs the rest (keeps `git log -C` = detect-copies while `git -C <dir>` is unsafe). FlagSpec shorthands in the registry: VALUE, VALUE2, PATH_VALUE, UNSAFE.
- git v1 (read-only inspection): status, log, ls-files, describe, rev-parse, shortlog, whatchanged, branch/tag (list mode via `positionals: "none"`). KEY DECISION: `diff`/`show`/`cat-file` are EXCLUDED even though read-only, because they print file CONTENTS from worktree/history — a sensitive file (.env) can reach the output with no sensitive path argument (also the `git show HEAD:.env` rev:path hole). This is the output-channel blind spot; revisiting diff/show requires the planned output protections (secret masking / redaction) or a safe-mode spec entry (like `git diff --stat` = metadata-only mode; `safeModeFlags` now exists in the spec, used by unzip). `remote`/`config` excluded (print credentials from .git/config). Global `-c` is unsafe pre-dispatch (diff.external/core.sshCommand/gpg.program/aliases).
- Conservative by design: any unclassifiable arg is treated as a path and must resolve (lexically, via `path.resolve`) inside cwd; only flag values (non-path slots) and the pattern slot bypass path-checking — so a `FlagSpec` mis-curation (a path wrongly declared a value slot) is the only dangerous direction; the planned conformance audit (Stage 3: run commands in real bwrap + trace openat, assert touched ⊆ extracted) is the defense against it.
- `parseBash` keeps chain operators (`&&`, `|`, `;`, `&`) as args — `splitAtChainOperators` splits segments before per-command evaluation.
- Commands invoked by path (`./cat`, `/tmp/cat`) are never trusted (basename lookup would allow a malicious binary masquerading as a known command).
- Leading env assignments (`FOO=bar cmd`): dangerous names are rejected outright (`LD_*` prefix, PATH, IFS, CDPATH, BASH_ENV, ENV, SHELLOPTS, BASHOPTS, PROMPT_COMMAND, GCONV_PATH); other assignment VALUES are path-checked like any other path (so `FOO=/etc/passwd cat x` falls back).
- Sensitive-path check also runs against the CANONICAL (realpath'd) path — a symlink named `notes.txt` pointing at `.env` is rejected.
- Subshells/process substitutions (including redirection targets) recurse through `isConfined`.
- `/dev/null` etc. are allowlisted as special paths (sandbox devtmpfs).
- Config: `heuristics.cwdConfinement` = `{ enabled (default true), permission (default "allow:sandbox"), commands (allowlist over registry), denyPaths (extra sensitive segment globs), blockDotfiles (paranoid mode), resolveSymlinks (default true) }`; merged field-wise in `common/config.ts` (denyPaths concatenated + deduped).
- Registry curation principle: commands that can EXECUTE code are never added (awk `system()`, sed `e` command, node/python, env-with-command) — those belong in explicit allow rules, which are the deliberate opt-in that dominates the heuristic. Value-taking exec flags are `unsafe` (e.g. `tar -I prog`, `sort --compress-program`, `rg --pre`). Multi-slot flags with a file in a non-zero slot are expressible and USED: jq `--slurpfile`/`--rawfile`/`--argfile` = `{ values: 2, pathSlots: [1] }` (name slot data, file slot checked); jq `-L` dir is path-checked like `-f` (in-cwd program files are trusted, sandbox contains the rest). Behavior change from the cutover: long flags with separate values now CONSUME the value (previously it was positionally path-checked by accident) — intentional relaxation for values that look like paths (e.g. `date --date /tmp/x` now allowed).
- Considered and DROPPED: `implicitPaths` (always-read files, e.g. git → .git) in the planned CommandSpec redesign. No real users: git's .git is a sensitive segment so the check is counterproductive (and git's actual risk is the output channel, not access); out-of-cwd implicit reads (rg → ~/.config/ripgrep) are contained by sandbox mounts, not the heuristic; make/npm have implicit reads but are code-execution engines excluded from the whitelist. Division of labor: whitelist/curation verifies the command's invariant default behavior, the heuristic verifies per-invocation argument access, sandbox mounts contain the rest.

## Symlink hardening (resolveSymlinks)

- Path args are canonicalized with `fs.realpathSync` against `realpathSync(cwd)` (stored as `options.realCwd`; null = check disabled, e.g. nonexistent cwd in tests).
- Kernel resolves full chains (link→link→outside caught); intermediate dir components too.
- Non-existent write targets: canonicalize nearest existing ancestor. Dangling symlinks (realpath throws while lstat succeeds) are REJECTED — writing through them would create the file at the target.
- Symlinks *inside* directory args are NOT walked; instead follow-symlink traversal flags are `unsafe`: find `-L`, grep `-R`/`--dereference-recursive`, du `-L`/`--dereference-all`, tree `-l`, rg `--follow`, fd `-L`. Default traversal modes of find/grep -r/du/ls -R/tree don't follow symlinks.
- Remaining caveat: TOCTOU (path swapped between check and exec) — accepted risk.

## Sensitive paths (secrets protection, "layer 1")

- `DEFAULT_SENSITIVE_PATTERNS` in heuristics.ts: glob per resolved-path segment — `.env*`, `.git`, credential dirs (`.ssh`/`.aws`/`.gnupg`/`.kube`/`.docker`/`.gcloud`), credential files (`.netrc`/`.npmrc`/`.pgpass`/`.my.cnf`/`.htpasswd`), private keys (`id_rsa*`, `*.pem`, `*.key`, `*.p12`, ...), `*.tfvars`, `credentials`. Always applies; `denyPaths` extends it.
- Known hole (documented): path-based checks don't cover traversal reads — `grep -r token .` reads `.env` content while the path arg is `.`. Discussed but not implemented: sandbox masking via `--ro-bind /dev/null <secret>` (layer 2), tool_result output redaction (layer 3).

## Known limitations (documented in docs/configuration.md)

- PATH trust: known command names are assumed to be real system binaries.
- Sandbox does not isolate the network namespace.
- Symlink check is time-of-check (TOCTOU accepted risk); see symlink hardening section.

Tests: `test/sandbox/heuristics.test.ts` (pass config object explicitly; fake cwd like "/project" disables realpath via fail-open — symlink tests use a real temp dir + fixtures). Property fuzz tests: `test/sandbox/fuzz.test.ts` — seeded PRNG (mulberry32, seed 42, override via FUZZ_SEED env), asserts invariants over structured chains: token soup never crashes, unsafe segment ⇒ ask, all-safe ⇒ allow:sandbox, deny dominance, explicit-allow dominance.
