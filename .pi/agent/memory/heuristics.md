---
name: heuristics
description: Design of the permission heuristics system (cwd-confinement) in pi-bash-sandbox.
category: design
---

# Heuristics System

Heuristics can grant a permission when **no explicit permission pattern matched** (`getPermissionMatch().matched === false`). They never override explicit pattern matches. Wired in `tools/bash.ts` after the pattern-based check.

## cwd-confinement heuristic (`sandbox/heuristics.ts`)

- Known commands registry (`KNOWN_COMMANDS`) holds per-command argument semantics (`CommandSpec`): `positionals` mode, `valueFlags` (value definitely NOT a path), `pathFlags`, `unsafeFlags` (e.g. find `-delete`/`-exec`, sort `--compress-program`), `patternBypassFlags` (grep `-e`/`-f`).
- Conservative by design: any unclassifiable arg is treated as a path and must resolve (lexically, via `path.resolve`) inside cwd; only `valueFlags` and grep's pattern skip bypass path-checking — so mis-curation of `valueFlags` is the only risky direction.
- `parseBash` keeps chain operators (`&&`, `|`, `;`, `&`) as args — `splitAtChainOperators` splits segments before per-command evaluation.
- Commands invoked by path (`./cat`, `/tmp/cat`) are never trusted (basename lookup would allow a malicious binary masquerading as a known command).
- Subshells/process substitutions (including redirection targets) recurse through `isConfined`.
- `/dev/null` etc. are allowlisted as special paths (sandbox devtmpfs).
- Config: `heuristics.cwdConfinement` = `{ enabled (default true), permission (default "allow:sandbox"), commands (allowlist over registry) }`; merged field-wise in `common/config.ts`.

## Known limitations (documented in docs/configuration.md)

- Lexical path resolution only — symlinks inside cwd pointing outside are not detected.
- PATH trust: known command names are assumed to be real system binaries.
- Sandbox does not isolate the network namespace.

Tests: `test/sandbox/heuristics.test.ts` (pass config object explicitly to avoid global config state).
