import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import sandboxConfig, { type SandboxConfigCwdConfinement } from "../common/config";
import { type Permission } from "./permissions";
import {
    parseBash,
    isHeredocOperator,
    isSubshell,
    isProcessSubstitution,
    getSubshellContent,
} from "./bash";

/**
 * Argument semantics for a known command, used by the cwd-confinement
 * heuristic to figure out which arguments may access the filesystem.
 *
 * Extraction is conservative: any argument that cannot be classified is
 * treated as a file path and must resolve inside the working directory.
 * Arguments are only skipped when consumed by a `valueFlag` (whose value
 * must definitely not be a path) or by the "first-pattern" positional mode
 * (e.g. grep's pattern argument).
 */
export interface CommandSpec {
    /**
     * How to treat positional (non-flag) arguments:
     * - "paths" (default): every positional is a file path
     * - "none": the command takes no positionals; any positional is ineligible
     * - "ignore": positionals are data, not paths (e.g. echo)
     * - "first-pattern": the first positional is a pattern (e.g. grep),
     *   unless a patternBypassFlag appears anywhere in the arguments
     */
    positionals?: "paths" | "none" | "ignore" | "first-pattern";
    /** Flags whose value (next arg or inline) is definitely NOT a path. */
    valueFlags?: string[];
    /** Flags whose value (next arg or inline) IS a path. */
    pathFlags?: string[];
    /** Flags that make the command ineligible for the heuristic. */
    unsafeFlags?: string[];
    /** For "first-pattern": flags that provide the pattern, making all positionals paths. */
    patternBypassFlags?: string[];
    /**
     * For commands that dispatch on a subcommand (e.g. git): the first
     * positional must be one of these names, otherwise the command is
     * ineligible. The remaining arguments are evaluated against the
     * subcommand's spec. The parent spec's unsafeFlags apply before the
     * subcommand only (after it they would collide with subcommand flags,
     * e.g. `git log -C` means detect-copies, not change directory).
     */
    subcommands?: Record<string, CommandSpec>;
}

/**
 * Registry of commands known to the cwd-confinement heuristic.
 *
 * Only commands that cannot modify files outside of explicitly given paths
 * (or execute other programs) should be listed here. Unknown commands fall
 * back to the permission system.
 */
export const KNOWN_COMMANDS: Record<string, CommandSpec> = {
    // file readers
    cat: {},
    head: { valueFlags: ["-n", "-c", "--lines", "--bytes"] },
    tail: {
        valueFlags: ["-n", "-c", "--lines", "--bytes", "-s", "--sleep-interval", "--pid"],
    },
    less: {},
    more: {},
    wc: { pathFlags: ["--files0-from"] },
    file: {
        valueFlags: ["-F", "--separator"],
        pathFlags: ["-f", "--files-from", "-m", "--magic-file"],
    },
    stat: { valueFlags: ["-c", "--format", "--printf"] },

    // binary and compressed readers
    zcat: {},
    strings: {
        valueFlags: ["-n", "--min-length", "--minimum-length", "-t", "--radix", "--bytes"],
    },
    od: {
        valueFlags: [
            "-A", "--address-radix",
            "-j", "--skip-bytes",
            "-N", "--read-bytes",
            "-S", "--seek",
            "-t", "--format",
        ],
    },
    hexdump: { valueFlags: ["-e", "--format", "-n", "--length", "-s", "--offset"] },
    xxd: {
        valueFlags: [
            "-l", "--length",
            "-s", "--offset",
            "-c", "--cols",
            "-g", "--group-size",
        ],
        // -r/-b write files; --post runs a program on the output
        unsafeFlags: ["-r", "--revert", "-b", "--bin", "--post"],
    },
    base64: {
        valueFlags: ["-w", "--wrap"],
        pathFlags: ["-o", "--output"],
    },

    // directory readers
    ls: {},
    dir: {},
    vdir: {},
    du: {
        valueFlags: ["-B", "--block-size", "-t", "--threshold", "--time-style"],
        pathFlags: ["--files0-from"],
        // -L follows symlinks during traversal
        unsafeFlags: ["-L", "--dereference-all"],
    },
    tree: {
        valueFlags: ["-L", "-P", "-I", "--filelimit", "--charset"],
        pathFlags: ["-o"],
        // -l follows symlinks to directories during traversal
        unsafeFlags: ["-l"],
    },
    // first positional is a search pattern, remaining positionals are paths
    fd: {
        positionals: "first-pattern",
        valueFlags: [
            "-d", "--max-depth",
            "-t", "--type",
            "-e", "--extension",
            "--size",
            "--owner",
            "--changed-within",
            "--changed-before",
            "--changed-after",
            "--change-newer-than",
            "--change-older-than",
            "--max-results",
            "--color",
        ],
        // -x/-X run a command on the results; -L descends into symlinks
        unsafeFlags: ["-x", "--exec", "-X", "--exec-batch", "-L", "--follow"],
    },
    // Debian/Ubuntu name for fd
    fdfind: {
        positionals: "first-pattern",
        valueFlags: [
            "-d", "--max-depth",
            "-t", "--type",
            "-e", "--extension",
            "--size",
            "--owner",
            "--changed-within",
            "--changed-before",
            "--changed-after",
            "--change-newer-than",
            "--change-older-than",
            "--max-results",
            "--color",
        ],
        unsafeFlags: ["-x", "--exec", "-X", "--exec-batch", "-L", "--follow"],
    },

    // path manipulation
    realpath: {},
    readlink: {},
    basename: { valueFlags: ["-s", "--suffix"] },
    dirname: {},
    cd: {},

    // text processing
    grep: {
        positionals: "first-pattern",
        patternBypassFlags: ["-e", "--regexp", "-f", "--file"],
        valueFlags: [
            "-e", "--regexp",
            "-m", "--max-count",
            "-A", "--after-context",
            "-B", "--before-context",
            "-C", "--context",
            "--label",
            "--include", "--exclude", "--exclude-dir",
            "--binary-files",
            "-D", "--directories",
            "-d", "--devices",
            "--group-separator",
            "--color", "--colour",
        ],
        pathFlags: ["-f", "--file", "--exclude-from"],
        // -R follows symlinks during recursive traversal
        unsafeFlags: ["-R", "--dereference-recursive"],
    },
    egrep: {
        positionals: "first-pattern",
        patternBypassFlags: ["-e", "--regexp", "-f", "--file"],
        valueFlags: [
            "-e", "--regexp",
            "-m", "--max-count",
            "-A", "--after-context",
            "-B", "--before-context",
            "-C", "--context",
            "--label",
            "--include", "--exclude", "--exclude-dir",
            "--binary-files",
            "-D", "--directories",
            "-d", "--devices",
            "--group-separator",
            "--color", "--colour",
        ],
        pathFlags: ["-f", "--file", "--exclude-from"],
        unsafeFlags: ["-R", "--dereference-recursive"],
    },
    fgrep: {
        positionals: "first-pattern",
        patternBypassFlags: ["-e", "--regexp", "-f", "--file"],
        valueFlags: [
            "-e", "--regexp",
            "-m", "--max-count",
            "-A", "--after-context",
            "-B", "--before-context",
            "-C", "--context",
            "--label",
            "--include", "--exclude", "--exclude-dir",
            "--binary-files",
            "-D", "--directories",
            "-d", "--devices",
            "--group-separator",
            "--color", "--colour",
        ],
        pathFlags: ["-f", "--file", "--exclude-from"],
        unsafeFlags: ["-R", "--dereference-recursive"],
    },
    // zgrep is a wrapper around grep on compressed files; same flag semantics
    zgrep: {
        positionals: "first-pattern",
        patternBypassFlags: ["-e", "--regexp", "-f", "--file"],
        valueFlags: [
            "-e", "--regexp",
            "-m", "--max-count",
            "-A", "--after-context",
            "-B", "--before-context",
            "-C", "--context",
            "--label",
            "--include", "--exclude", "--exclude-dir",
            "--binary-files",
            "-D", "--directories",
            "-d", "--devices",
            "--group-separator",
            "--color", "--colour",
        ],
        pathFlags: ["-f", "--file", "--exclude-from"],
        unsafeFlags: ["-R", "--dereference-recursive"],
    },
    rg: {
        positionals: "first-pattern",
        patternBypassFlags: ["-e", "--regexp", "-f", "--file"],
        valueFlags: [
            "-e", "--regexp",
            "-t", "--type",
            "-g", "--glob", "--iglob",
            "-A", "--after-context",
            "-B", "--before-context",
            "-C", "--context",
            "-m", "--max-count",
            "-M", "--max-count-per-file",
            "--max-depth",
            "--max-columns",
            "--max-filesize",
            "-j", "--threads",
            "--engine",
            "--sort", "--sortr",
            "--color",
            "--context-separator",
            "--field-context-separator",
            "--pre-glob",
        ],
        pathFlags: ["-f", "--file"],
        // --pre runs an external program; --follow descends into symlinks
        unsafeFlags: ["--pre", "--follow"],
    },
    sort: {
        valueFlags: [
            "-k", "--key",
            "-t", "--field-separator",
            "-S", "--buffer-size",
            "--parallel",
            "--batch-size",
        ],
        pathFlags: ["-o", "--output", "-T", "--temporary-dir", "--files0-from"],
        // executes an external program
        unsafeFlags: ["--compress-program"],
    },
    uniq: {
        valueFlags: ["-s", "--skip-chars", "-w", "--check-chars", "-f", "--skip-fields"],
    },
    cut: {
        valueFlags: ["-d", "--delimiter", "-f", "--fields", "-c", "--characters", "-b", "--bytes"],
    },
    paste: { valueFlags: ["-d", "--delimiters"] },
    comm: {},
    join: { valueFlags: ["-t", "-e", "-1", "-2", "-j", "-o", "-a", "-v"] },
    tr: { positionals: "ignore" },

    find: {
        // flags that write files or execute commands
        unsafeFlags: [
            "-delete",
            "-exec", "-execdir",
            "-ok", "-okdir",
            "-fls", "-fprint", "-fprint0", "-fprintf",
            // follows symlinks during traversal
            "-L",
        ],
    },
    // first positional is the jq filter, remaining positionals are input files
    jq: {
        positionals: "first-pattern",
        // -f/--from-file supplies the filter, so all positionals are files
        patternBypassFlags: ["-f", "--from-file"],
        valueFlags: ["--arg", "--argjson", "--indent"],
        pathFlags: ["-f", "--from-file"],
        // -L loads jq/C modules from arbitrary directories;
        // --slurpfile/--rawfile/--argfile take a name AND a file, which the
        // single-value model would not path-check, so fall back instead
        unsafeFlags: ["-L", "--library-path", "--slurpfile", "--rawfile", "--argfile"],
    },

    // file comparison
    diff: {
        valueFlags: [
            "-C", "--context",
            "-U", "--unified",
            "--label",
            "-I", "--ignore-matching-lines",
            "-x", "--exclude",
            "-S", "--starting-file",
        ],
        pathFlags: ["-X", "--exclude-from"],
    },
    diff3: {
        valueFlags: [
            "-C", "--context",
            "-U", "--unified",
            "--label",
            "-I", "--ignore-matching-lines",
            "-x", "--exclude",
            "-S", "--starting-file",
        ],
        pathFlags: ["-X", "--exclude-from"],
    },
    cmp: { valueFlags: ["-i", "--ignore-initial", "-n", "--bytes"] },

    // checksums (all flags are booleans; -c reads a checksums file positional)
    cksum: {},
    md5sum: {},
    sha1sum: {},
    sha224sum: {},
    sha256sum: {},
    sha384sum: {},
    sha512sum: {},
    // macOS aliases of the coreutils checksum tools
    shasum: {},
    md5: {},

    // archives (list/inspect only; modes that write or run programs are unsafe)
    tar: {
        valueFlags: ["--transform", "--exclude"],
        pathFlags: ["-f", "--file", "--exclude-file"],
        // create/extract/modify write files; -I/--to-command/--checkpoint-action
        // run external programs
        unsafeFlags: [
            "-c", "--create",
            "-x", "--extract",
            "-d", "--delete",
            "-r", "--append", "-A",
            "-u", "--update",
            "-I", "--use-compress-program",
            "--to-command",
            "--checkpoint-action",
        ],
    },
    zipinfo: { valueFlags: ["-T"] },

    // version control (read-only inspection of the repo in cwd).
    // Excluded subcommands: diff/show/cat-file print file CONTENTS from the
    // worktree or history (a sensitive file's content can reach the output
    // with no sensitive path argument), remote/config can print credentials
    // stored in .git/config, and fetch/pull/push/checkout/... write or use
    // the network. Those need explicit allow rules or output protections.
    // Note: `git status` refreshes .git/index stat caches, which is normal
    // git behavior (it happens outside the sandbox too).
    git: {
        // global flags, valid before the subcommand: -c can select external
        // programs (diff.external, core.sshCommand, gpg.program, ...),
        // -C/--git-dir/--work-tree relocate the repo, --exec-path changes
        // which helpers git runs
        unsafeFlags: ["-c", "-C", "--git-dir", "--work-tree", "--exec-path"],
        subcommands: {
            // positionals are pathspecs
            status: {},
            log: {
                valueFlags: [
                    "-n", "--max-count",
                    "--since", "--until", "--after", "--before",
                    "--author", "--grep",
                    "-S", "-G",
                    "--format", "--pretty",
                    "--diff-filter",
                ],
                // patch output prints file contents from history
                unsafeFlags: ["-p", "--patch", "-U", "--unified"],
            },
            "ls-files": {
                valueFlags: ["--exclude", "--with-tree"],
            },
            describe: {
                valueFlags: ["--abbrev", "--candidates", "--matches", "--exclude"],
            },
            // positionals are revisions, not paths
            "rev-parse": {
                positionals: "ignore",
                valueFlags: ["--short", "--abbrev", "--abbrev-ref", "--git-path", "--verify"],
            },
            shortlog: {
                valueFlags: [
                    "-n", "--max-count",
                    "--since", "--until", "--after", "--before",
                    "--author", "--grep",
                    "--format", "--pretty",
                ],
                unsafeFlags: ["-p", "--patch"],
            },
            // alias of log
            whatchanged: {
                valueFlags: [
                    "-n", "--max-count",
                    "--since", "--until", "--after", "--before",
                    "--author", "--grep",
                    "-S", "-G",
                    "--format", "--pretty",
                    "--diff-filter",
                ],
                unsafeFlags: ["-p", "--patch", "-U", "--unified"],
            },
            // list mode only: a ref name as positional means create/delete
            branch: { positionals: "none" },
            tag: { positionals: "none" },
        },
    },

    // no filesystem arguments
    pwd: { positionals: "none" },
    true: { positionals: "none" },
    false: { positionals: "none" },
    echo: { positionals: "ignore" },
    printf: { positionals: "ignore" },

    // system utilities (no file access, or program names instead of paths)
    date: {
        valueFlags: ["-d", "--date"],
        pathFlags: ["-f", "--file"],
    },
    sleep: { positionals: "ignore" },
    which: { positionals: "ignore" },
    whereis: { positionals: "ignore" },
    type: { positionals: "ignore" },
    uname: { positionals: "none" },
    hostname: {
        positionals: "ignore",
        pathFlags: ["-F", "--file"],
    },
    nproc: { positionals: "none", valueFlags: ["--ignore"] },
    free: { positionals: "none", valueFlags: ["-c"] },
    id: { positionals: "none" },
    df: { valueFlags: ["-B", "--block-size", "--output"] },
};

// pseudo-files available inside the sandbox's devtmpfs
const SPECIAL_ALLOWED_PATHS = new Set([
    "/dev/null",
    "/dev/zero",
    "/dev/full",
    "/dev/random",
    "/dev/urandom",
    "/dev/stdin",
    "/dev/stdout",
    "/dev/stderr",
]);

/**
 * Sensitive path segments that always make the heuristic ineligible
 * (glob-matched against every segment of the resolved path).
 */
const DEFAULT_SENSITIVE_PATTERNS = [
    // environment files
    ".env", ".env.*",
    // VCS internals (e.g. .git/config may embed tokens in remote URLs)
    ".git",
    // credential directories
    ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".gcloud",
    // credential files
    ".netrc", ".npmrc", ".pypirc", ".pgpass", ".my.cnf", ".htpasswd",
    // private keys
    "id_rsa*", "id_ed25519*", "id_ecdsa*", "id_dsa*",
    "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore", "*.jks",
    // infra secrets
    "*.tfvars",
    "credentials",
];

function segmentGlobToRegex(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", ".*")
        .replaceAll("?", ".");
    return new RegExp("^" + escaped + "$");
}

const DEFAULT_SENSITIVE_REGEXES = DEFAULT_SENSITIVE_PATTERNS.map(segmentGlobToRegex);

const REDIRECTION_OPERATORS = new Set([">", ">>", "<", "2>", "2>>"]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Environment variable names that can alter how the (trusted) command itself
 * behaves — code injection or PATH shadowing — so any assignment to them
 * makes the heuristic ineligible.
 */
const DANGEROUS_ENV_NAMES = new Set([
    "PATH", "IFS", "CDPATH",
    "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PROMPT_COMMAND",
    "GCONV_PATH",
]);

function isDangerousEnvName(name: string): boolean {
    return name.startsWith("LD_") || DANGEROUS_ENV_NAMES.has(name);
}

interface ConfinementOptions {
    allowedCommands: Set<string> | null;
    sensitivePatterns: RegExp[];
    blockDotfiles: boolean;
    /** canonical cwd for symlink resolution; null disables the realpath check */
    realCwd: string | null;
}

function resolvePath(p: string, cwd: string, home: string): string {
    let expanded = p;
    if (p === "~" || p.startsWith("~/")) {
        expanded = home + p.slice(1);
    }
    return path.resolve(cwd, expanded);
}

/**
 * Check whether a resolved path touches a sensitive segment.
 */
function hasSensitiveSegment(resolved: string, options: ConfinementOptions): boolean {
    const segments = resolved
        .split(path.sep)
        .filter((s) => s !== "" && s !== "." && s !== "..");

    for (const segment of segments) {
        if (options.blockDotfiles && segment.startsWith(".")) {
            return true;
        }

        if (DEFAULT_SENSITIVE_REGEXES.some((r) => r.test(segment))) {
            return true;
        }

        if (options.sensitivePatterns.some((r) => r.test(segment))) {
            return true;
        }
    }

    return false;
}

/**
 * Check whether a path touches a sensitive segment. Checked against every
 * segment of the resolved path, so e.g. "src/.env" and "keys/server.pem"
 * are caught.
 */
function isSensitivePath(
    p: string,
    cwd: string,
    home: string,
    options: ConfinementOptions,
): boolean {
    return hasSensitiveSegment(resolvePath(p, cwd, home), options);
}

/**
 * Check whether a path stays within the working directory, using lexical
 * resolution only (symlinks are not followed).
 */
function isAllowedPath(p: string, cwd: string, home: string): boolean {
    if (p === "") {
        return true;
    }

    if (SPECIAL_ALLOWED_PATHS.has(p)) {
        return true;
    }

    const resolved = resolvePath(p, cwd, home);
    return resolved === cwd || resolved.startsWith(cwd + path.sep);
}

/**
 * Check that a path stays within the canonical working directory after
 * resolving symlinks. The kernel resolves full symlink chains (including
 * intermediate directory components and loops), so a single realpath call
 * catches e.g. `link1 -> link2 -> /etc/passwd`.
 *
 * Non-existent trailing components (e.g. write targets) are handled by
 * canonicalizing the nearest existing ancestor — anything below it does not
 * exist, so it cannot contain symlinks. Dangling symlinks (unresolvable
 * target) are rejected: writing through them would create the file at the
 * target location.
 */
function isRealPathConfined(
    p: string,
    cwd: string,
    home: string,
    options: ConfinementOptions,
): boolean {
    if (p === "" || SPECIAL_ALLOWED_PATHS.has(p)) {
        return true;
    }

    const realCwd = options.realCwd;
    if (realCwd === null) {
        return true;
    }

    let current = resolvePath(p, cwd, home);

    while (true) {
        let stat: fs.Stats | undefined;
        try {
            stat = fs.lstatSync(current);
        } catch {
            stat = undefined;
        }

        if (stat) {
            let real: string;
            try {
                real = fs.realpathSync(current);
            } catch {
                // dangling symlink or otherwise unresolvable path
                return false;
            }
            if (real !== realCwd && !real.startsWith(realCwd + path.sep)) {
                return false;
            }
            // a symlink can hide a sensitive target behind an innocent name
            // (e.g. notes.txt -> .env), so check the canonical path too
            return !hasSensitiveSegment(real, options);
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return false;
        }
        current = parent;
    }
}

/**
 * Check if any argument provides the pattern for a "first-pattern" command
 * (e.g. grep -e foo, grep -ffoo, grep --regexp=foo). When present, all
 * positional arguments are paths.
 *
 * False positives are safe: they only turn pattern arguments into
 * path-checked arguments.
 */
function hasPatternBypass(args: string[], spec: CommandSpec): boolean {
    const bypass = spec.patternBypassFlags ?? [];
    const shortBypass = bypass
        .filter((f) => !f.startsWith("--"))
        .map((f) => f[1]);
    const longBypass = bypass.filter((f) => f.startsWith("--"));

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--") {
            break;
        }

        if (arg.startsWith("--")) {
            const name = arg.split("=", 1)[0];
            if (longBypass.includes(name)) {
                return true;
            }
        } else if (arg.length > 1 && arg.startsWith("-")) {
            const cluster = arg.slice(1);
            if (shortBypass.some((c) => cluster.includes(c))) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Handle a short-flag cluster (e.g. -la, -n5, -efoo).
 * Returns the new argument index, or null if the command is ineligible.
 */
function handleShortCluster(
    args: string[],
    index: number,
    spec: CommandSpec,
    paths: string[],
): number | null {
    const cluster = args[index].slice(1);

    for (let j = 0; j < cluster.length; j++) {
        const flag = "-" + cluster[j];

        if (spec.unsafeFlags?.includes(flag)) {
            return null;
        }

        if (spec.valueFlags?.includes(flag)) {
            // inline value is the rest of the cluster, otherwise next arg
            return j === cluster.length - 1 ? index + 1 : index;
        }

        if (spec.pathFlags?.includes(flag)) {
            if (j === cluster.length - 1) {
                const value = args[index + 1];
                if (value === undefined) {
                    return null;
                }
                paths.push(value);
                return index + 1;
            }
            paths.push(cluster.slice(j + 1));
            return index;
        }

        // unknown short flag: assume boolean, continue with the cluster
    }

    return index;
}

/**
 * Extract all filesystem paths accessed by a single known command.
 * Returns null if the command usage cannot be classified safely.
 * args[0] is the command name.
 */
function extractCommandPaths(
    args: string[],
    spec: CommandSpec,
    cwd: string,
    options: ConfinementOptions,
): string[] | null {
    const paths: string[] = [];
    let afterDoubleDash = false;
    let positionalSeen = false;

    // Commands with subcommands (e.g. git) dispatch on the first positional:
    // it must name a known subcommand, after which the subcommand's spec
    // governs the remaining arguments. The parent's unsafeFlags apply before
    // dispatch only (after it they would collide with subcommand flags,
    // e.g. `git log -C` means detect-copies, not change directory).
    const subcommands = spec.subcommands;
    let activeSpec = spec;
    let dispatched = subcommands === undefined;
    let positionals = activeSpec.positionals ?? "paths";
    let patternProvided =
        positionals !== "first-pattern" || hasPatternBypass(args, activeSpec);

    const adoptSpec = (s: CommandSpec) => {
        activeSpec = s;
        positionals = s.positionals ?? "paths";
        patternProvided =
            positionals !== "first-pattern" || hasPatternBypass(args, s);
    };

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];

        if (!afterDoubleDash) {
            if (arg === "--") {
                afterDoubleDash = true;
                continue;
            }

            if (isHeredocOperator(arg)) {
                // skip the delimiter
                i++;
                continue;
            }

            if (REDIRECTION_OPERATORS.has(arg)) {
                const target = args[++i];
                if (target === undefined) {
                    return null;
                }

                if (isSubshell(target) || isProcessSubstitution(target)) {
                    if (!isConfined(getSubshellContent(target), cwd, options)) {
                        return null;
                    }
                } else {
                    paths.push(target);
                }
                continue;
            }

            if (isSubshell(arg) || isProcessSubstitution(arg)) {
                if (!isConfined(getSubshellContent(arg), cwd, options)) {
                    return null;
                }
                continue;
            }

            if (arg.startsWith("--")) {
                const eq = arg.indexOf("=");
                const name = eq === -1 ? arg : arg.slice(0, eq);
                const inline = eq === -1 ? undefined : arg.slice(eq + 1);

                if (!dispatched && spec.unsafeFlags?.includes(name)) {
                    return null;
                }

                if (activeSpec.unsafeFlags?.includes(name)) {
                    return null;
                }

                if (activeSpec.valueFlags?.includes(name)) {
                    continue;
                }

                if (activeSpec.pathFlags?.includes(name)) {
                    const value = inline ?? args[++i];
                    if (value === undefined) {
                        return null;
                    }
                    paths.push(value);
                    continue;
                }

                // unknown long flag with inline value: treat value as path
                if (inline !== undefined) {
                    paths.push(inline);
                }
                continue;
            }

            if (arg.length > 1 && arg.startsWith("-")) {
                // whole-arg unsafe flags (e.g. find -delete, find -exec)
                if (!dispatched && spec.unsafeFlags?.includes(arg)) {
                    return null;
                }

                if (activeSpec.unsafeFlags?.includes(arg)) {
                    return null;
                }

                const next = handleShortCluster(args, i, activeSpec, paths);
                if (next === null) {
                    return null;
                }
                i = next;
                continue;
            }
        }

        // positional argument
        if (!dispatched) {
            const sub = subcommands![arg];
            if (sub === undefined) {
                return null;
            }
            adoptSpec(sub);
            dispatched = true;
            continue;
        }

        switch (positionals) {
            case "none":
                return null;
            case "ignore":
                continue;
            case "first-pattern":
                if (!positionalSeen && !patternProvided) {
                    positionalSeen = true;
                    continue;
                }
                paths.push(arg);
                continue;
            default:
                paths.push(arg);
        }
    }

    // a subcommand-taking command with no subcommand (e.g. bare `git`)
    if (!dispatched) {
        return null;
    }

    return paths;
}

const CHAIN_OPERATORS = new Set(["&&", "||", "|", ";", "&"]);

/**
 * Split a parsed command at chain operators. parseBash keeps operators like
 * && and | as arguments of a single command, so each segment between them
 * must be evaluated as its own command.
 */
export function splitAtChainOperators(args: string[]): string[][] {
    const segments: string[][] = [];
    let current: string[] = [];

    for (const arg of args) {
        if (CHAIN_OPERATORS.has(arg)) {
            if (current.length > 0) {
                segments.push(current);
                current = [];
            }
        } else {
            current.push(arg);
        }
    }

    if (current.length > 0) {
        segments.push(current);
    }

    return segments;
}

/**
 * Check whether a single parsed command is a known command whose file
 * accesses all stay within the working directory.
 */
function isCommandConfined(
    args: string[],
    cwd: string,
    options: ConfinementOptions,
): boolean {
    // skip leading environment assignments (FOO=bar cmd ...), but reject
    // assignments that can alter the command's behavior (LD_PRELOAD, PATH,
    // ...) and path-check the values of the rest
    let idx = 0;
    const envValues: string[] = [];
    while (idx < args.length && ENV_ASSIGNMENT.test(args[idx])) {
        const eq = args[idx].indexOf("=");
        const name = args[idx].slice(0, eq);
        if (isDangerousEnvName(name)) {
            return false;
        }
        envValues.push(args[idx].slice(eq + 1));
        idx++;
    }

    if (idx >= args.length) {
        return false;
    }

    const commandName = args[idx];

    // commands invoked by path are not trusted to be the real binary
    if (commandName.includes("/") || commandName.includes("\\")) {
        return false;
    }

    const spec = KNOWN_COMMANDS[commandName];
    if (!spec) {
        return false;
    }

    if (options.allowedCommands !== null && !options.allowedCommands.has(commandName)) {
        return false;
    }

    const paths = extractCommandPaths(args.slice(idx), spec, cwd, options);
    if (paths === null) {
        return false;
    }

    const home = os.homedir();
    const allPaths = [...envValues, ...paths];
    return allPaths.every((p) => {
        if (!isAllowedPath(p, cwd, home)) {
            return false;
        }
        if (isSensitivePath(p, cwd, home, options)) {
            return false;
        }
        if (!isRealPathConfined(p, cwd, home, options)) {
            return false;
        }
        return true;
    });
}

/**
 * Check whether every command in a (possibly multi-line or chained) command
 * string is known and confined to the working directory.
 */
function isConfined(
    command: string,
    cwd: string,
    options: ConfinementOptions,
): boolean {
    let parsed: string[][];
    try {
        parsed = parseBash(command);
    } catch {
        return false;
    }

    if (parsed.length === 0) {
        return false;
    }

    return parsed.every((cmdArgs) => {
        const segments = splitAtChainOperators(cmdArgs);
        return (
            segments.length > 0 &&
            segments.every((segment) => isCommandConfined(segment, cwd, options))
        );
    });
}

function buildConfinementOptions(
    confinement: SandboxConfigCwdConfinement | undefined,
    cwd: string,
): ConfinementOptions {
    let realCwd: string | null = null;
    if (confinement?.resolveSymlinks ?? true) {
        try {
            realCwd = fs.realpathSync(cwd);
        } catch {
            realCwd = null;
        }
    }

    return {
        allowedCommands: confinement?.commands ? new Set(confinement.commands) : null,
        sensitivePatterns: (confinement?.denyPaths ?? []).map(segmentGlobToRegex),
        blockDotfiles: confinement?.blockDotfiles ?? false,
        realCwd,
    };
}

function resolveConfinementConfig(
    config?: SandboxConfigCwdConfinement | null,
): SandboxConfigCwdConfinement | undefined {
    return config === undefined
        ? sandboxConfig.current?.heuristics?.cwdConfinement
        : (config ?? undefined);
}

/**
 * Cwd-confinement heuristic: known, safe commands whose file accesses all
 * resolve inside the working directory are granted the configured permission
 * (default "allow:sandbox").
 *
 * Returns undefined when the heuristic does not apply — unknown commands,
 * paths outside the working directory, or unclassifiable usage — in which
 * case the caller should fall back to the permission system.
 */
export function getCwdConfinementPermission(
    command: string,
    cwd: string,
    config?: SandboxConfigCwdConfinement | null,
): Permission | undefined {
    const confinement = resolveConfinementConfig(config);

    if (confinement?.enabled === false) {
        return undefined;
    }

    if (command.trim() === "") {
        return undefined;
    }

    const resolvedCwd = path.resolve(cwd);

    if (!isConfined(command, resolvedCwd, buildConfinementOptions(confinement, resolvedCwd))) {
        return undefined;
    }

    return confinement?.permission ?? "allow:sandbox";
}

/**
 * Segment-level variant of the cwd-confinement heuristic: evaluates a single
 * already-parsed command (list of arguments, no chain operators).
 *
 * Returns undefined when the heuristic does not apply.
 */
export function getArgsConfinementPermission(
    args: string[],
    cwd: string,
    config?: SandboxConfigCwdConfinement | null,
): Permission | undefined {
    const confinement = resolveConfinementConfig(config);

    if (confinement?.enabled === false || args.length === 0) {
        return undefined;
    }

    const resolvedCwd = path.resolve(cwd);

    if (!isCommandConfined(args, resolvedCwd, buildConfinementOptions(confinement, resolvedCwd))) {
        return undefined;
    }

    return confinement?.permission ?? "allow:sandbox";
}
