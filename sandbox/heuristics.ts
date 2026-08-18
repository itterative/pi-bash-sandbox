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
 * Semantics of a single flag, used by the cwd-confinement heuristic to
 * figure out which arguments may access the filesystem.
 */
export interface FlagSpec {
    /**
     * How many value tokens this flag consumes (default 0 = boolean).
     * Values are consumed as separate arguments, or inline for one value
     * (`--flag=value` fills slot 0). Multi-value flags in inline form are
     * ineligible. Consumed values are data unless listed in `pathSlots`.
     */
    values?: number;
    /**
     * Indices (0-based) of the consumed value slots that are filesystem
     * paths and must resolve inside the working directory.
     */
    pathSlots?: number[];
    /**
     * The flag makes the command ineligible for the heuristic (it writes
     * files, executes programs, or follows symlinks).
     */
    unsafe?: boolean;
}

/**
 * Argument semantics for a known command, used by the cwd-confinement
 * heuristic to figure out which arguments may access the filesystem.
 *
 * Extraction is conservative: any argument that cannot be classified is
 * treated as a file path and must resolve inside the working directory.
 * Arguments are only skipped when consumed as a flag value (unless the
 * value's slot is a path slot) or by the "first-pattern"/"first-path"
 * positional modes (e.g. grep's pattern argument).
 */
export interface CommandSpec {
    /**
     * How to treat positional (non-flag) arguments:
     * - "paths" (default): every positional is a file path
     * - "none": the command takes no positionals; any positional is ineligible
     * - "ignore": positionals are data, not paths (e.g. echo)
     * - "first-pattern": the first positional is a pattern (e.g. grep),
     *   the rest are paths, unless a patternBypassFlag appears anywhere in
     *   the arguments (then all positionals are paths)
     * - "first-path": the first positional is a path, the rest are data
     *   (e.g. archive tools: the archive, then member names)
     */
    positionals?: "paths" | "none" | "ignore" | "first-pattern" | "first-path";
    /** Flag semantics, keyed by full flag name ("-n" or "--max-count"). */
    flags?: Record<string, FlagSpec>;
    /** For "first-pattern": flags that provide the pattern, making all positionals paths. */
    patternBypassFlags?: string[];
    /**
     * For commands that dispatch on a subcommand (e.g. git): the first
     * positional must be one of these names, otherwise the command is
     * ineligible. The remaining arguments are evaluated against the
     * subcommand's spec, which governs the flags after it; the parent spec
     * governs the flags before it (this is what keeps `git -C dir status`
     * unsafe while `git log -C` means detect-copies, not change directory).
     */
    subcommands?: Record<string, CommandSpec>;
    /**
     * When set, the command is eligible only if at least one of these flags
     * is present: the default mode is unsafe (e.g. unzip extracts files
     * unless given a read-only mode like -l or -p).
     */
    safeModeFlags?: string[];
}

// FlagSpec shorthands for the registry
/** consumes one value (data, never a path) */
const VALUE: FlagSpec = { values: 1 };
/** consumes two values (data, never paths), e.g. jq --arg name value */
const VALUE2: FlagSpec = { values: 2 };
/** consumes one value that IS a path */
const PATH_VALUE: FlagSpec = { values: 1, pathSlots: [0] };
/** makes the command ineligible */
const UNSAFE: FlagSpec = { unsafe: true };

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
    head: { flags: { "-n": VALUE, "-c": VALUE, "--lines": VALUE, "--bytes": VALUE } },
    tail: {
        flags: {
            "-n": VALUE, "-c": VALUE,
            "--lines": VALUE, "--bytes": VALUE,
            "-s": VALUE, "--sleep-interval": VALUE, "--pid": VALUE,
        },
    },
    less: {},
    more: {},
    wc: { flags: { "--files0-from": PATH_VALUE } },
    file: {
        flags: {
            "-F": VALUE, "--separator": VALUE,
            "-f": PATH_VALUE, "--files-from": PATH_VALUE,
            "-m": PATH_VALUE, "--magic-file": PATH_VALUE,
        },
    },
    stat: { flags: { "-c": VALUE, "--format": VALUE, "--printf": VALUE } },

    // binary and compressed readers
    zcat: {},
    strings: {
        flags: {
            "-n": VALUE, "--min-length": VALUE, "--minimum-length": VALUE,
            "-t": VALUE, "--radix": VALUE, "--bytes": VALUE,
        },
    },
    od: {
        flags: {
            "-A": VALUE, "--address-radix": VALUE,
            "-j": VALUE, "--skip-bytes": VALUE,
            "-N": VALUE, "--read-bytes": VALUE,
            "-S": VALUE, "--seek": VALUE,
            "-t": VALUE, "--format": VALUE,
        },
    },
    hexdump: {
        flags: {
            "-e": VALUE, "--format": VALUE,
            "-n": VALUE, "--length": VALUE,
            "-s": VALUE, "--offset": VALUE,
        },
    },
    xxd: {
        flags: {
            "-l": VALUE, "--length": VALUE,
            "-s": VALUE, "--offset": VALUE,
            "-c": VALUE, "--cols": VALUE,
            "-g": VALUE, "--group-size": VALUE,
            // -r/-b write files; --post runs a program on the output
            "-r": UNSAFE, "--revert": UNSAFE,
            "-b": UNSAFE, "--bin": UNSAFE, "--post": UNSAFE,
        },
    },
    base64: {
        flags: {
            "-w": VALUE, "--wrap": VALUE,
            "-o": PATH_VALUE, "--output": PATH_VALUE,
        },
    },

    // directory readers
    ls: {},
    dir: {},
    vdir: {},
    du: {
        flags: {
            "-B": VALUE, "--block-size": VALUE,
            "-t": VALUE, "--threshold": VALUE, "--time-style": VALUE,
            "--files0-from": PATH_VALUE,
            // -L follows symlinks during traversal
            "-L": UNSAFE, "--dereference-all": UNSAFE,
        },
    },
    tree: {
        flags: {
            "-L": VALUE, "-P": VALUE, "-I": VALUE,
            "--filelimit": VALUE, "--charset": VALUE,
            "-o": PATH_VALUE,
            // -l follows symlinks to directories during traversal
            "-l": UNSAFE,
        },
    },
    // first positional is a search pattern, remaining positionals are paths
    fd: {
        positionals: "first-pattern",
        flags: {
            "-d": VALUE, "--max-depth": VALUE,
            "-t": VALUE, "--type": VALUE,
            "-e": VALUE, "--extension": VALUE,
            "--size": VALUE, "--owner": VALUE,
            "--changed-within": VALUE, "--changed-before": VALUE, "--changed-after": VALUE,
            "--change-newer-than": VALUE, "--change-older-than": VALUE,
            "--max-results": VALUE, "--color": VALUE,
            // -x/-X run a command on the results; -L descends into symlinks
            "-x": UNSAFE, "--exec": UNSAFE,
            "-X": UNSAFE, "--exec-batch": UNSAFE,
            "-L": UNSAFE, "--follow": UNSAFE,
        },
    },
    // Debian/Ubuntu name for fd
    fdfind: {
        positionals: "first-pattern",
        flags: {
            "-d": VALUE, "--max-depth": VALUE,
            "-t": VALUE, "--type": VALUE,
            "-e": VALUE, "--extension": VALUE,
            "--size": VALUE, "--owner": VALUE,
            "--changed-within": VALUE, "--changed-before": VALUE, "--changed-after": VALUE,
            "--change-newer-than": VALUE, "--change-older-than": VALUE,
            "--max-results": VALUE, "--color": VALUE,
            "-x": UNSAFE, "--exec": UNSAFE,
            "-X": UNSAFE, "--exec-batch": UNSAFE,
            "-L": UNSAFE, "--follow": UNSAFE,
        },
    },

    // path manipulation
    realpath: {},
    readlink: {},
    basename: { flags: { "-s": VALUE, "--suffix": VALUE } },
    dirname: {},
    cd: {},

    // text processing
    grep: {
        positionals: "first-pattern",
        patternBypassFlags: ["-e", "--regexp", "-f", "--file"],
        flags: {
            "-e": VALUE, "--regexp": VALUE,
            "-m": VALUE, "--max-count": VALUE,
            "-A": VALUE, "--after-context": VALUE,
            "-B": VALUE, "--before-context": VALUE,
            "-C": VALUE, "--context": VALUE,
            "--label": VALUE,
            "--include": VALUE, "--exclude": VALUE, "--exclude-dir": VALUE,
            "--binary-files": VALUE,
            "-D": VALUE, "--directories": VALUE,
            "-d": VALUE, "--devices": VALUE,
            "--group-separator": VALUE,
            "--color": VALUE, "--colour": VALUE,
            "-f": PATH_VALUE, "--file": PATH_VALUE, "--exclude-from": PATH_VALUE,
            // -R follows symlinks during recursive traversal
            "-R": UNSAFE, "--dereference-recursive": UNSAFE,
        },
    },
    egrep: {
        positionals: "first-pattern",
        patternBypassFlags: ["-e", "--regexp", "-f", "--file"],
        flags: {
            "-e": VALUE, "--regexp": VALUE,
            "-m": VALUE, "--max-count": VALUE,
            "-A": VALUE, "--after-context": VALUE,
            "-B": VALUE, "--before-context": VALUE,
            "-C": VALUE, "--context": VALUE,
            "--label": VALUE,
            "--include": VALUE, "--exclude": VALUE, "--exclude-dir": VALUE,
            "--binary-files": VALUE,
            "-D": VALUE, "--directories": VALUE,
            "-d": VALUE, "--devices": VALUE,
            "--group-separator": VALUE,
            "--color": VALUE, "--colour": VALUE,
            "-f": PATH_VALUE, "--file": PATH_VALUE, "--exclude-from": PATH_VALUE,
            "-R": UNSAFE, "--dereference-recursive": UNSAFE,
        },
    },
    fgrep: {
        positionals: "first-pattern",
        patternBypassFlags: ["-e", "--regexp", "-f", "--file"],
        flags: {
            "-e": VALUE, "--regexp": VALUE,
            "-m": VALUE, "--max-count": VALUE,
            "-A": VALUE, "--after-context": VALUE,
            "-B": VALUE, "--before-context": VALUE,
            "-C": VALUE, "--context": VALUE,
            "--label": VALUE,
            "--include": VALUE, "--exclude": VALUE, "--exclude-dir": VALUE,
            "--binary-files": VALUE,
            "-D": VALUE, "--directories": VALUE,
            "-d": VALUE, "--devices": VALUE,
            "--group-separator": VALUE,
            "--color": VALUE, "--colour": VALUE,
            "-f": PATH_VALUE, "--file": PATH_VALUE, "--exclude-from": PATH_VALUE,
            "-R": UNSAFE, "--dereference-recursive": UNSAFE,
        },
    },
    // zgrep is a wrapper around grep on compressed files; same flag semantics
    zgrep: {
        positionals: "first-pattern",
        patternBypassFlags: ["-e", "--regexp", "-f", "--file"],
        flags: {
            "-e": VALUE, "--regexp": VALUE,
            "-m": VALUE, "--max-count": VALUE,
            "-A": VALUE, "--after-context": VALUE,
            "-B": VALUE, "--before-context": VALUE,
            "-C": VALUE, "--context": VALUE,
            "--label": VALUE,
            "--include": VALUE, "--exclude": VALUE, "--exclude-dir": VALUE,
            "--binary-files": VALUE,
            "-D": VALUE, "--directories": VALUE,
            "-d": VALUE, "--devices": VALUE,
            "--group-separator": VALUE,
            "--color": VALUE, "--colour": VALUE,
            "-f": PATH_VALUE, "--file": PATH_VALUE, "--exclude-from": PATH_VALUE,
            "-R": UNSAFE, "--dereference-recursive": UNSAFE,
        },
    },
    rg: {
        positionals: "first-pattern",
        patternBypassFlags: ["-e", "--regexp", "-f", "--file"],
        flags: {
            "-e": VALUE, "--regexp": VALUE,
            "-t": VALUE, "--type": VALUE,
            "-g": VALUE, "--glob": VALUE, "--iglob": VALUE,
            "-A": VALUE, "--after-context": VALUE,
            "-B": VALUE, "--before-context": VALUE,
            "-C": VALUE, "--context": VALUE,
            "-m": VALUE, "--max-count": VALUE,
            "-M": VALUE, "--max-count-per-file": VALUE,
            "--max-depth": VALUE,
            "--max-columns": VALUE,
            "--max-filesize": VALUE,
            "-j": VALUE, "--threads": VALUE,
            "--engine": VALUE,
            "--sort": VALUE, "--sortr": VALUE,
            "--color": VALUE,
            "--context-separator": VALUE,
            "--field-context-separator": VALUE,
            "--pre-glob": VALUE,
            "-f": PATH_VALUE, "--file": PATH_VALUE,
            // --pre runs an external program; --follow descends into symlinks
            "--pre": UNSAFE, "--follow": UNSAFE,
        },
    },
    sort: {
        flags: {
            "-k": VALUE, "--key": VALUE,
            "-t": VALUE, "--field-separator": VALUE,
            "-S": VALUE, "--buffer-size": VALUE,
            "--parallel": VALUE, "--batch-size": VALUE,
            "-o": PATH_VALUE, "--output": PATH_VALUE,
            "-T": PATH_VALUE, "--temporary-dir": PATH_VALUE,
            "--files0-from": PATH_VALUE,
            // executes an external program
            "--compress-program": UNSAFE,
        },
    },
    uniq: {
        flags: {
            "-s": VALUE, "--skip-chars": VALUE,
            "-w": VALUE, "--check-chars": VALUE,
            "-f": VALUE, "--skip-fields": VALUE,
        },
    },
    cut: {
        flags: {
            "-d": VALUE, "--delimiter": VALUE,
            "-f": VALUE, "--fields": VALUE,
            "-c": VALUE, "--characters": VALUE,
            "-b": VALUE, "--bytes": VALUE,
        },
    },
    paste: { flags: { "-d": VALUE, "--delimiters": VALUE } },
    comm: {},
    join: {
        flags: {
            "-t": VALUE, "-e": VALUE, "-1": VALUE, "-2": VALUE,
            "-j": VALUE, "-o": VALUE, "-a": VALUE, "-v": VALUE,
        },
    },
    tr: { positionals: "ignore" },

    find: {
        // flags that write files or execute commands
        flags: {
            "-delete": UNSAFE,
            "-exec": UNSAFE, "-execdir": UNSAFE,
            "-ok": UNSAFE, "-okdir": UNSAFE,
            "-fls": UNSAFE, "-fprint": UNSAFE, "-fprint0": UNSAFE, "-fprintf": UNSAFE,
            // follows symlinks during traversal
            "-L": UNSAFE,
        },
    },
    // first positional is the jq filter, remaining positionals are input files
    jq: {
        positionals: "first-pattern",
        // -f/--from-file supplies the filter, so all positionals are files
        patternBypassFlags: ["-f", "--from-file"],
        flags: {
            // name + value, neither is a path
            "--arg": VALUE2, "--argjson": VALUE2,
            "--indent": VALUE,
            "-f": PATH_VALUE, "--from-file": PATH_VALUE,
            // -L/--library-path: module search dir, path-checked like -f
            "-L": PATH_VALUE, "--library-path": PATH_VALUE,
            // name + FILE: the file slot is path-checked
            "--slurpfile": { values: 2, pathSlots: [1] },
            "--rawfile": { values: 2, pathSlots: [1] },
            "--argfile": { values: 2, pathSlots: [1] },
        },
    },

    // file comparison
    diff: {
        flags: {
            "-C": VALUE, "--context": VALUE,
            "-U": VALUE, "--unified": VALUE,
            "--label": VALUE,
            "-I": VALUE, "--ignore-matching-lines": VALUE,
            "-x": VALUE, "--exclude": VALUE,
            "-S": VALUE, "--starting-file": VALUE,
            "-X": PATH_VALUE, "--exclude-from": PATH_VALUE,
        },
    },
    diff3: {
        flags: {
            "-C": VALUE, "--context": VALUE,
            "-U": VALUE, "--unified": VALUE,
            "--label": VALUE,
            "-I": VALUE, "--ignore-matching-lines": VALUE,
            "-x": VALUE, "--exclude": VALUE,
            "-S": VALUE, "--starting-file": VALUE,
            "-X": PATH_VALUE, "--exclude-from": PATH_VALUE,
        },
    },
    cmp: { flags: { "-i": VALUE, "--ignore-initial": VALUE, "-n": VALUE, "--bytes": VALUE } },

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

    // archives (list/inspect only; modes that write or run programs are
    // unsafe). First positional is the archive, the rest are member names
    // (data, not paths).
    tar: {
        positionals: "first-path",
        flags: {
            "--transform": VALUE, "--exclude": VALUE,
            "-f": PATH_VALUE, "--file": PATH_VALUE, "--exclude-file": PATH_VALUE,
            // create/extract/modify write files; -I/--to-command/
            // --checkpoint-action run external programs
            "-c": UNSAFE, "--create": UNSAFE,
            "-x": UNSAFE, "--extract": UNSAFE,
            "-d": UNSAFE, "--delete": UNSAFE,
            "-r": UNSAFE, "--append": UNSAFE, "-A": UNSAFE,
            "-u": UNSAFE, "--update": UNSAFE,
            "-I": UNSAFE, "--use-compress-program": UNSAFE,
            "--to-command": UNSAFE,
            "--checkpoint-action": UNSAFE,
        },
    },
    zipinfo: { flags: { "-T": VALUE } },
    // the default mode extracts files (writes); only read-only modes are
    // eligible. First positional is the archive, the rest are member names.
    unzip: {
        positionals: "first-path",
        safeModeFlags: ["-l", "--list", "-p", "-z", "-t", "-v"],
        flags: { "-T": VALUE },
    },

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
        flags: {
            "-c": UNSAFE, "-C": UNSAFE,
            "--git-dir": UNSAFE, "--work-tree": UNSAFE, "--exec-path": UNSAFE,
        },
        subcommands: {
            // positionals are pathspecs
            status: {},
            log: {
                flags: {
                    "-n": VALUE, "--max-count": VALUE,
                    "--since": VALUE, "--until": VALUE, "--after": VALUE, "--before": VALUE,
                    "--author": VALUE, "--grep": VALUE,
                    "-S": VALUE, "-G": VALUE,
                    "--format": VALUE, "--pretty": VALUE,
                    "--diff-filter": VALUE,
                    // patch output prints file contents from history
                    "-p": UNSAFE, "--patch": UNSAFE, "-U": UNSAFE, "--unified": UNSAFE,
                },
            },
            "ls-files": {
                flags: { "--exclude": VALUE, "--with-tree": VALUE },
            },
            describe: {
                flags: {
                    "--abbrev": VALUE, "--candidates": VALUE,
                    "--matches": VALUE, "--exclude": VALUE,
                },
            },
            // positionals are revisions, not paths
            "rev-parse": {
                positionals: "ignore",
                flags: {
                    "--short": VALUE, "--abbrev": VALUE, "--abbrev-ref": VALUE,
                    "--git-path": VALUE, "--verify": VALUE,
                },
            },
            shortlog: {
                flags: {
                    "-n": VALUE, "--max-count": VALUE,
                    "--since": VALUE, "--until": VALUE, "--after": VALUE, "--before": VALUE,
                    "--author": VALUE, "--grep": VALUE,
                    "--format": VALUE, "--pretty": VALUE,
                    "-p": UNSAFE, "--patch": UNSAFE,
                },
            },
            // alias of log
            whatchanged: {
                flags: {
                    "-n": VALUE, "--max-count": VALUE,
                    "--since": VALUE, "--until": VALUE, "--after": VALUE, "--before": VALUE,
                    "--author": VALUE, "--grep": VALUE,
                    "-S": VALUE, "-G": VALUE,
                    "--format": VALUE, "--pretty": VALUE,
                    "--diff-filter": VALUE,
                    "-p": UNSAFE, "--patch": UNSAFE, "-U": UNSAFE, "--unified": UNSAFE,
                },
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
        flags: {
            "-d": VALUE, "--date": VALUE,
            "-f": PATH_VALUE, "--file": PATH_VALUE,
        },
    },
    sleep: { positionals: "ignore" },
    which: { positionals: "ignore" },
    whereis: { positionals: "ignore" },
    type: { positionals: "ignore" },
    uname: { positionals: "none" },
    hostname: {
        positionals: "ignore",
        flags: { "-F": PATH_VALUE, "--file": PATH_VALUE },
    },
    nproc: { positionals: "none", flags: { "--ignore": VALUE } },
    free: { positionals: "none", flags: { "-c": VALUE } },
    id: { positionals: "none" },
    df: { flags: { "-B": VALUE, "--block-size": VALUE, "--output": VALUE } },
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
 * Whether any argument provides one of the spec's safeModeFlags
 * (e.g. unzip -l, unzip --list).
 */
function hasSafeModeFlag(args: string[], spec: CommandSpec): boolean {
    const safe = spec.safeModeFlags ?? [];
    const shortSafe = safe
        .filter((f) => !f.startsWith("--"))
        .map((f) => f[1]);
    const longSafe = safe.filter((f) => f.startsWith("--"));

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--") {
            break;
        }

        if (arg.startsWith("--")) {
            if (longSafe.includes(arg.split("=", 1)[0])) {
                return true;
            }
        } else if (arg.length > 1 && arg.startsWith("-")) {
            const cluster = arg.slice(1);
            if (shortSafe.some((c) => cluster.includes(c))) {
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
        const flagSpec = spec.flags?.[flag];

        if (flagSpec?.unsafe) {
            return null;
        }

        const values = flagSpec?.values ?? 0;
        if (values > 0) {
            if (values > 1) {
                // multi-value short flag: cannot be classified safely
                return null;
            }
            // inline value is the rest of the cluster, otherwise next arg
            if (j === cluster.length - 1) {
                const value = args[index + 1];
                if (value === undefined) {
                    return null;
                }
                if (hasPathSlot(flagSpec, 0)) {
                    paths.push(value);
                }
                return index + 1;
            }
            if (hasPathSlot(flagSpec, 0)) {
                paths.push(cluster.slice(j + 1));
            }
            return index;
        }

        // boolean (known or unknown): continue with the cluster
    }

    return index;
}

function hasPathSlot(flagSpec: FlagSpec | undefined, slot: number): boolean {
    return flagSpec?.pathSlots?.includes(slot) ?? false;
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
    // governs the remaining arguments. The parent's unsafe flags apply before
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
                const flagSpec = activeSpec.flags?.[name];

                if (flagSpec?.unsafe) {
                    return null;
                }

                const values = flagSpec?.values ?? 0;
                if (values > 0) {
                    if (inline !== undefined) {
                        // inline value fills slot 0; multi-value flags do
                        // not have a usable inline form
                        if (values > 1) {
                            return null;
                        }
                        if (hasPathSlot(flagSpec, 0)) {
                            paths.push(inline);
                        }
                        continue;
                    }
                    for (let slot = 0; slot < values; slot++) {
                        const value = args[i + 1 + slot];
                        if (value === undefined) {
                            return null;
                        }
                        if (hasPathSlot(flagSpec, slot)) {
                            paths.push(value);
                        }
                    }
                    i += values;
                    continue;
                }

                // unknown long flag with inline value: treat value as path
                if (inline !== undefined) {
                    paths.push(inline);
                }
                continue;
            }

            if (arg.length > 1 && arg.startsWith("-")) {
                // whole-arg unsafe flags: find's expression actions are
                // single-dash multi-character tokens, not short clusters
                // (-delete, -exec, -fprint, ...)
                if (activeSpec.flags?.[arg]?.unsafe) {
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
            case "first-path":
                if (!positionalSeen) {
                    positionalSeen = true;
                    paths.push(arg);
                }
                continue;
            default:
                paths.push(arg);
        }
    }

    // a subcommand-taking command with no subcommand (e.g. bare `git`)
    if (!dispatched) {
        return null;
    }

    // default mode is unsafe unless a read-only mode flag is present
    if (activeSpec.safeModeFlags && !hasSafeModeFlag(args, activeSpec)) {
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
