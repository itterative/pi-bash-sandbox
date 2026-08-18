/**
 * Curation conformance audit for the cwd-confinement heuristic.
 *
 * Verifies empirically — by observing syscalls with strace, inside the real
 * bubblewrap sandbox — that every whitelisted command, when run with
 * representative arguments, only touches paths the sandbox (and thus the
 * heuristic's contract) permits, performs no network I/O, and only execs
 * itself (or a documented helper).
 *
 * Per invocation, for every traced path syscall:
 *   - path inside a sandbox mount dest  -> OK
 *   - path outside, syscall failed      -> INFO (the sandbox hid it; safe,
 *     but logged — a failed read of a sensitive path is fine, a SUCCESSFUL
 *     one is a violation)
 *   - path outside, syscall succeeded   -> VIOLATION
 *
 * Additionally:
 *   - any successful connect()          -> VIOLATION
 *   - any execve target not in {the command itself} ∪ its documented
 *     helpers                           -> VIOLATION
 *   - any successful write outside cwd ∪ /tmp ∪ /dev -> VIOLATION
 *
 * Safety: every audited command runs inside the sandbox built by
 * sandbox/bubblewrap.ts (the exact same builder the extension uses). The
 * only host-side effects are creating a fixture tree under
 * /tmp/pi-curation-audit and writing trace files there. Refuses to run
 * without bwrap or strace (skips with exit 0).
 *
 * Usage: npm run audit:curation   (Linux with bwrap + strace required)
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import sandboxConfig from "../common/config";
import sandbox from "../sandbox/bubblewrap";
import { getArgsConfinementPermission } from "../sandbox/heuristics";

// ---------------------------------------------------------------------------
// environment gates
// ---------------------------------------------------------------------------

function toolVersion(cmd: string, args: string[]): string | null {
    const res = spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000 });
    if (res.status !== 0) {
        return null;
    }
    return (res.stdout || res.stderr).split("\n")[0].trim();
}

const bwrapVersion = process.platform === "linux" ? toolVersion("bwrap", ["--version"]) : null;
if (!bwrapVersion) {
    console.log("SKIP: curation audit requires Linux with bubblewrap installed. (exit 0)");
    process.exit(0);
}
const straceVersion = toolVersion("strace", ["--version"]);
if (!straceVersion) {
    console.log("SKIP: curation audit requires strace installed (e.g. `sudo dnf install strace`). (exit 0)");
    process.exit(0);
}

const BWRAP = "/usr/bin/bwrap";
if (!fs.existsSync(BWRAP)) {
    console.log("SKIP: bwrap not found at /usr/bin/bwrap. (exit 0)");
    process.exit(0);
}

console.log(`curation conformance audit`);
console.log(`  ${bwrapVersion}`);
console.log(`  ${straceVersion}`);

// ---------------------------------------------------------------------------
// fixture tree (host-side, confined to /tmp/pi-curation-audit)
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = "/tmp/pi-curation-audit";
const TRACE_DIR = path.join(FIXTURE_ROOT, "traces");

function sh(cmd: string, args: string[], cwd?: string): void {
    const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
    if (res.status !== 0) {
        throw new Error(`fixture setup failed: ${cmd} ${args.join(" ")} (cwd=${cwd ?? "."}):\n${res.stderr}`);
    }
}

function buildFixture(): void {
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TRACE_DIR, { recursive: true });

    const w = (rel: string, data: string | Buffer): void => {
        const p = path.join(FIXTURE_ROOT, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, data);
    };

    w("file.txt", "hello world\nsecond line\nneedle in file.txt\nthird entry\n");
    w("sub/nested.txt", "nested needle\n");
    w("data.json", JSON.stringify({ name: "audit", values: [1, 2, 3], tags: ["a", "b"] }, null, 2) + "\n");
    const bin = Buffer.alloc(64);
    for (let i = 0; i < 64; i++) bin[i] = i;
    w("binary.bin", Buffer.concat([bin, Buffer.from("\x00needle\x00\x00end")]));
    w("pattern.txt", "needle\n");
    w("jqfilter.jq", ".name\n");
    w("dates.txt", "2024-01-01\n2024-06-15\n");
    w("pairs.txt", "a 1\nb 2\n");
    w("sorted.txt", "hello world\nneedle in file.txt\nsecond line\nthird entry\n");
    fs.symlinkSync("file.txt", path.join(FIXTURE_ROOT, "link.txt"));

    // compressed + archive + checksum fixtures
    sh("gzip", ["-k", "file.txt"], FIXTURE_ROOT);
    sh("tar", ["cf", "archive.tar", "file.txt", "sub"], FIXTURE_ROOT);
    sh("zip", ["-q", "archive.zip", "file.txt", "sub/nested.txt"], FIXTURE_ROOT);
    const md5 = spawnSync("md5sum", ["file.txt"], { cwd: FIXTURE_ROOT, encoding: "utf8" }).stdout.trim();
    w("checksums.md5", md5 + "\n");
    const sha = spawnSync("sha256sum", ["file.txt"], { cwd: FIXTURE_ROOT, encoding: "utf8" }).stdout.trim();
    w("checksums.sha256", sha + "\n");

    // minimal git repo (committed file + tag, for git describe)
    const repo = path.join(FIXTURE_ROOT, "repo");
    fs.mkdirSync(repo);
    sh("git", ["init", "-q"], repo);
    sh("git", ["config", "user.email", "audit@example.com"], repo);
    sh("git", ["config", "user.name", "Audit"], repo);
    sh("git", ["config", "commit.gpgsign", "false"], repo);
    fs.writeFileSync(path.join(repo, "file.txt"), "repo file\nneedle in repo\n");
    sh("git", ["add", "file.txt"], repo);
    sh("git", ["commit", "-q", "-m", "initial"], repo);
    sh("git", ["tag", "v1.0"], repo);
}

// ---------------------------------------------------------------------------
// corpus: representative invocations per whitelisted command
// ---------------------------------------------------------------------------

interface CorpusEntry {
    /** direct argv, no shell syntax (default) */
    argv?: string[];
    /** raw shell snippet, traced via bash -c (only when argv syntax is insufficient) */
    shell?: string;
    /** argv used for the heuristic pre-check when `shell` is set */
    precheck?: string[];
    /** run with cwd = fixture/repo (default: fixture root) */
    repo?: boolean;
    /** feed this string to stdin (default: empty/closed) */
    stdin?: string;
    /** execve basenames allowed besides the command itself (documented helpers) */
    helpers?: string[];
    note?: string;
}

const CORPUS: Record<string, CorpusEntry[]> = {
    // file readers
    cat: [
        { argv: ["cat", "file.txt"] },
        { argv: ["cat", "sub/nested.txt", "link.txt"], note: "relative + symlink inside cwd" },
    ],
    head: [
        { argv: ["head", "-n", "1", "file.txt"], note: "value flag" },
        { argv: ["head", "-c", "10", "file.txt"] },
    ],
    tail: [{ argv: ["tail", "-n", "1", "file.txt"] }],
    // less/more: see NEGATIVE_CORPUS (removed from the whitelist — LESSOPEN)
    wc: [{ argv: ["wc", "file.txt", "sub/nested.txt"] }],
    file: [{ argv: ["file", "file.txt", "binary.bin"] }],
    stat: [
        { argv: ["stat", "file.txt"] },
        { argv: ["stat", "-c", "%n %s", "file.txt"], note: "value flag" },
    ],

    // binary and compressed readers
    // zcat is a symlink to gzip; the kernel loads the gzip binary
    zcat: [{ argv: ["zcat", "file.txt.gz"], helpers: ["gzip"] }],
    strings: [
        { argv: ["strings", "binary.bin"] },
        { argv: ["strings", "-n", "4", "binary.bin"], note: "value flag" },
    ],
    od: [{ argv: ["od", "-c", "-N", "32", "file.txt"] }],
    hexdump: [{ argv: ["hexdump", "-C", "file.txt"] }],
    xxd: [{ argv: ["xxd", "file.txt"] }],
    base64: [
        { argv: ["base64", "file.txt"] },
        { argv: ["base64", "-o", "out.b64", "file.txt"], note: "path-value flag (write inside cwd)" },
    ],

    // directory readers
    ls: [
        { argv: ["ls"], note: "no args: whole cwd" },
        { argv: ["ls", "-la", "sub"] },
    ],
    dir: [{ argv: ["dir"] }],
    vdir: [{ argv: ["vdir", "file.txt"] }],
    du: [
        { argv: ["du", "-sh", "."] },
        { argv: ["du", "-h", "sub"] },
    ],
    tree: [
        { argv: ["tree", "sub"] },
        { argv: ["tree", "-L", "1"], note: "value flag" },
    ],
    fd: [
        { argv: ["fd", "."], note: "first-pattern positional" },
        { argv: ["fd", "-e", "txt", "."], note: "value flag" },
    ],
    fdfind: [{ argv: ["fdfind", "."], note: "Debian name for fd (often missing)" }],

    // path manipulation
    realpath: [
        { argv: ["realpath", "file.txt", "sub"] },
        { argv: ["realpath", "--", "."] },
    ],
    readlink: [{ argv: ["readlink", "link.txt"] }],
    basename: [{ argv: ["basename", "sub/nested.txt", ".txt"], note: "value flag (-s)" }],
    dirname: [{ argv: ["dirname", "sub/nested.txt"] }],
    cd: [{ argv: ["cd", "sub"], note: "bash builtin" }],

    // text processing
    grep: [
        { argv: ["grep", "needle", "file.txt"], note: "first-pattern positional" },
        { argv: ["grep", "-f", "pattern.txt", "file.txt"], note: "path-value flag" },
        { argv: ["grep", "-r", "needle", "sub"], note: "recursive traversal" },
    ],
    // egrep/fgrep are symlinks to grep on this system
    egrep: [{ argv: ["egrep", "sec.line", "file.txt"], helpers: ["grep"] }],
    fgrep: [{ argv: ["fgrep", "needle", "file.txt"], helpers: ["grep"] }],
    zgrep: [
        // zgrep is a shell script around grep+gzip; document the helpers
        { argv: ["zgrep", "needle", "file.txt.gz"], helpers: ["sh", "dash", "bash", "grep", "gzip", "zgrep"] },
    ],
    rg: [
        { argv: ["rg", "needle"], note: "first-pattern positional" },
        { argv: ["rg", "-g", "*.txt", "needle", "."], note: "value flags" },
    ],
    sort: [
        { argv: ["sort", "file.txt"] },
        { argv: ["sort", "-o", "sorted-out.txt", "file.txt"], note: "path-value flag (write inside cwd)" },
    ],
    uniq: [{ argv: ["uniq", "file.txt"] }],
    cut: [{ argv: ["cut", "-d", " ", "-f", "1", "file.txt"], note: "value flags" }],
    paste: [{ argv: ["paste", "file.txt", "sub/nested.txt"] }],
    comm: [{ argv: ["comm", "sorted.txt", "sorted.txt"] }],
    join: [{ argv: ["join", "-t", " ", "pairs.txt", "pairs.txt"], note: "value flags" }],
    tr: [
        // tr only touches stdin/stdout (positionals are the sets, i.e. data)
        { argv: ["tr", "a-z", "A-Z"], stdin: "", note: "positionals are data; stdin only" },
    ],
    find: [
        { argv: ["find", ".", "-name", "*.txt"] },
        { argv: ["find", "sub", "-type", "f"] },
        { argv: ["find", ".", "-maxdepth", "1", "-type", "d"] },
    ],
    jq: [
        { argv: ["jq", ".", "data.json"], note: "first-pattern (filter) positional" },
        { argv: ["jq", ".name", "data.json"] },
        { argv: ["jq", "--arg", "x", "1", ". + {x}", "data.json"], note: "two-value flag" },
        { argv: ["jq", "-f", "jqfilter.jq", "data.json"], note: "path-value flag (filter file)" },
        { argv: ["jq", "--slurpfile", "f", "data.json", ".f"], note: "path slot in two-value flag" },
    ],

    // file comparison
    diff: [
        { argv: ["diff", "file.txt", "sub/nested.txt"], note: "nonzero exit expected" },
        { argv: ["diff", "-u", "file.txt", "file.txt"], note: "value flags" },
    ],
    // diff3 is a wrapper that execs the diff program
    diff3: [{ argv: ["diff3", "file.txt", "file.txt", "file.txt"], helpers: ["diff"] }],
    cmp: [
        { argv: ["cmp", "file.txt", "file.txt"] },
        { argv: ["cmp", "file.txt", "sub/nested.txt"], note: "nonzero exit expected" },
    ],

    // checksums
    cksum: [{ argv: ["cksum", "file.txt"] }],
    md5sum: [
        { argv: ["md5sum", "file.txt"] },
        { argv: ["md5sum", "-c", "checksums.md5"], note: "-c reads checksums file" },
    ],
    sha1sum: [{ argv: ["sha1sum", "file.txt"] }],
    sha224sum: [{ argv: ["sha224sum", "file.txt"] }],
    sha256sum: [
        { argv: ["sha256sum", "file.txt"] },
        { argv: ["sha256sum", "-c", "checksums.sha256"], note: "-c reads checksums file" },
    ],
    sha384sum: [{ argv: ["sha384sum", "file.txt"] }],
    sha512sum: [{ argv: ["sha512sum", "file.txt"] }],
    shasum: [{ argv: ["shasum", "file.txt"], note: "macOS/coreutils alias" }],
    md5: [{ argv: ["md5", "file.txt"], note: "macOS alias (missing on Linux distros)" }],

    // archives
    tar: [
        { argv: ["tar", "-tf", "archive.tar"], note: "first-path (archive), list mode" },
        { argv: ["tar", "-tvf", "archive.tar"] },
        { argv: ["tar", "-tf", "archive.tar", "file.txt"], note: "member name is data, not a path" },
    ],
    zipinfo: [{ argv: ["zipinfo", "archive.zip"] }],
    unzip: [
        { argv: ["unzip", "-l", "archive.zip"], note: "safe mode flag (list)" },
        { argv: ["unzip", "-p", "archive.zip", "file.txt"], note: "safe mode flag (print)" },
    ],

    // version control
    git: [
        { argv: ["git", "status"], repo: true, note: "refreshes .git/index (normal git)" },
        { argv: ["git", "log", "--oneline"], repo: true },
        { argv: ["git", "log", "-n", "1", "--format=%H"], repo: true, note: "value flags after subcommand" },
        { argv: ["git", "ls-files"], repo: true },
        { argv: ["git", "describe", "--tags"], repo: true },
        { argv: ["git", "rev-parse", "HEAD"], repo: true },
        { argv: ["git", "rev-parse", "--abbrev-ref", "HEAD"], repo: true },
        { argv: ["git", "shortlog", "-n", "5"], repo: true, note: "-n takes a value" },
        { argv: ["git", "branch"], repo: true, note: "list mode (no positionals)" },
        { argv: ["git", "tag"], repo: true, note: "list mode (no positionals)" },
        { argv: ["git", "whatchanged", "-n", "1"], repo: true, note: "alias of log" },
    ],

    // no filesystem arguments
    pwd: [{ argv: ["pwd"], note: "bash builtin" }],
    true: [{ argv: ["true"], note: "bash builtin" }],
    false: [{ argv: ["false"], note: "bash builtin; nonzero exit expected" }],
    echo: [{ argv: ["echo", "hello"], note: "bash builtin; positionals are data" }],
    printf: [{ argv: ["printf", "%s\\n", "hello"], note: "bash builtin; positionals are data" }],

    // system utilities
    date: [
        { argv: ["date"] },
        { argv: ["date", "-d", "2024-01-01"], note: "value flag" },
        { argv: ["date", "-f", "dates.txt"], note: "path-value flag" },
    ],
    sleep: [{ argv: ["sleep", "0.1"], note: "positionals are data" }],
    which: [{ argv: ["which", "cat"], note: "program name, not a path" }],
    whereis: [{ argv: ["whereis", "cat"] }],
    type: [{ argv: ["type", "cat"], note: "bash builtin" }],
    uname: [
        { argv: ["uname"] },
        { argv: ["uname", "-a"] },
    ],
    hostname: [
        { argv: ["hostname"] },
        // hostname -f: see NEGATIVE_CORPUS (does DNS — ineligible)
    ],
    nproc: [{ argv: ["nproc"] }],
    free: [{ argv: ["free"], note: "reads /proc/meminfo (mounted)" }],
    id: [{ argv: ["id"] }],
    df: [{ argv: ["df", "."] }],
};

/**
 * Invocations the heuristic must NOT allow (no sandbox run — heuristic
 * check only). Locks in exclusions: if one of these ever starts returning a
 * permission, the spec changed in a way that needs review.
 */
const NEGATIVE_CORPUS: { label: string; argv: string[]; repo?: boolean; note: string }[] = [
    { label: "less file.txt", argv: ["less", "file.txt"], note: "executes LESSOPEN pipeline (lesspipe)" },
    { label: "more file.txt", argv: ["more", "file.txt"], note: "executes LESSOPEN pipeline (lesspipe)" },
    { label: "hostname -f", argv: ["hostname", "-f"], note: "DNS resolution (observed connect())" },
    { label: "hostname -i", argv: ["hostname", "-i"], note: "DNS resolution" },
    { label: "unzip archive.zip", argv: ["unzip", "archive.zip"], note: "default mode extracts (writes)" },
    { label: "tar -xzf archive.tar", argv: ["tar", "-xzf", "archive.tar"], note: "extract mode writes" },
    { label: "git -C /etc status", argv: ["git", "-C", "/etc", "status"], repo: true, note: "parent -C relocates the repo" },
    { label: "find . -exec cat {}", argv: ["find", ".", "-exec", "cat", "{}"], note: "-exec runs programs" },
    { label: "awk '{print}' file.txt", argv: ["awk", "{print}", "file.txt"], note: "code execution" },
    { label: "curl http://example.com", argv: ["curl", "http://example.com"], note: "network" },
];

// ---------------------------------------------------------------------------
// strace trace parsing
// ---------------------------------------------------------------------------

const TRACE_SYSCALLS = "openat,newfstatat,statx,stat,lstat,access,faccessat,statfs,connect,execve";

interface TracedCall {
    pid: number;
    syscall: string;
    args: string;
    /** numeric return value, or -1 on error */
    retval: number;
    errno?: string;
    line: string;
}

/** quoted strings inside a syscall's argument list */
function quotedStrings(args: string): string[] {
    const out: string[] = [];
    const re = /"((?:[^"\\]|\\.)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(args)) !== null) {
        out.push(m[1]);
    }
    return out;
}

function parseTrace(text: string): TracedCall[] {
    const calls: TracedCall[] = [];
    for (const line of text.split("\n")) {
        // PID syscall(args) = retval [ERRNO (message)]
        const m = line.match(/^(\d+)\s+([a-z0-9_]+)\((.*)\) = (-?\d+|0x[0-9a-fA-F]+)(?:\s+([A-Z]+))?/);
        if (!m) {
            continue;
        }
        const [, pid, syscall, args, retval, errno] = m;
        calls.push({
            pid: Number(pid),
            syscall,
            args,
            retval: parseInt(retval, retval.startsWith("0x") ? 16 : 10),
            errno,
            line: line.trim(),
        });
    }
    return calls;
}

/** the filesystem path a syscall refers to (undefined for fd-only calls) */
function callPath(call: TracedCall): string | undefined {
    const strs = quotedStrings(call.args);
    switch (call.syscall) {
        case "openat":
        case "newfstatat":
        case "statx":
        case "stat":
        case "lstat":
        case "access":
        case "faccessat":
        case "faccessat2":
        case "statfs":
            // dfd (AT_FDCWD or a number) is never quoted; first quoted arg is the path
            return strs[0];
        case "execve":
            return strs[0]; // binary path
        case "connect": {
            // only AF_UNIX carries a path (sun_path); others have none
            const m = call.args.match(/sun_path="((?:[^"\\]|\\.)*)"/);
            return m ? m[1] : undefined;
        }
        default:
            return undefined;
    }
}

// ---------------------------------------------------------------------------
// allowed path set: parsed from the actual bwrap command that ran
// ---------------------------------------------------------------------------

const PREP = "\u0001";

/** tokenize a command string quoted with the builder's single-quote scheme */
function shlexSingleQuotes(cmd: string): string[] {
    const s = cmd.replace(/'"'"'/g, PREP);
    const tokens: string[] = [];
    let cur = "";
    let inQuotes = false;
    let hasToken = false;
    for (const c of s) {
        if (c === "'") {
            inQuotes = !inQuotes;
            hasToken = true;
        } else if (c === " " && !inQuotes) {
            if (hasToken) {
                tokens.push(cur.replace(new RegExp(PREP, "g"), "'"));
                cur = "";
                hasToken = false;
            }
        } else {
            cur += c;
            hasToken = true;
        }
    }
    if (hasToken) {
        tokens.push(cur.replace(new RegExp(PREP, "g"), "'"));
    }
    return tokens;
}

interface MountInfo {
    dest: string;
    rw: boolean;
}

function parseMounts(bwrapCmd: string): MountInfo[] {
    const tokens = shlexSingleQuotes(bwrapCmd);
    const mounts: MountInfo[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === "--bind" || t === "--ro-bind" || t === "--bind-try" || t === "--ro-bind-try") {
            mounts.push({ dest: tokens[i + 2], rw: t === "--bind" || t === "--bind-try" });
            i += 2;
        } else if (t === "--proc" || t === "--dev") {
            mounts.push({ dest: tokens[i + 1], rw: true });
            i += 1;
        }
    }
    return mounts;
}

function isInside(p: string, root: string): boolean {
    return p === root || p.startsWith(root + "/");
}

function isUnderAny(p: string, roots: string[]): boolean {
    return roots.some((r) => isInside(p, r));
}

/** "/" or a strict parent of a mount dest (the bwrap namespace skeleton) */
function isSkeletonDir(p: string, mounts: MountInfo[]): boolean {
    if (p === "/") {
        return true;
    }
    return mounts.some((m) => m.dest.startsWith(p + "/"));
}

// ---------------------------------------------------------------------------
// run one corpus entry
// ---------------------------------------------------------------------------

type Status = "pass" | "fail" | "skip" | "corpus";

interface Result {
    status: Status;
    label: string;
    violations: string[];
    skipped?: string;
    info: Map<string, number>; // "errno path" -> count (accesses outside allowed set that FAILED)
    traceFile?: string;
    exitCode?: number;
}

function quoteArg(a: string): string {
    return `'${a.replace(/'/g, `'\\''`)}'`;
}

function isCommandAvailable(name: string): boolean {
    const res = spawnSync("bash", ["-c", `command -v ${quoteArg(name)} >/dev/null`], { encoding: "utf8" });
    return res.status === 0;
}

function runEntry(command: string, entry: CorpusEntry, fixtureRoot: string, idx: number): Result {
    const cwd = entry.repo ? path.join(fixtureRoot, "repo") : fixtureRoot;
    const labelArgv = entry.argv ?? entry.precheck!;
    const label = `${labelArgv.map(quoteArg).join(" ")}${entry.repo ? "  (cwd=repo)" : ""}`;
    const info = new Map<string, number>();

    // corpus pre-check: the heuristic must actually allow this invocation
    const perm = getArgsConfinementPermission(labelArgv, cwd, {});
    if (!perm) {
        return {
            status: "corpus",
            label,
            violations: [`heuristic does NOT allow this invocation (expected "${perm ?? "allow:sandbox"}")`],
            info,
        };
    }

    // availability check (skip, not fail: curation is host-independent)
    if (!isCommandAvailable(labelArgv[0])) {
        return { status: "skip", label, skipped: "binary not installed on this host", violations: [], info };
    }

    const safeName = labelArgv.slice(0, 2).join("-").replace(/[^a-zA-Z0-9-]/g, "_");
    const traceFile = path.join(TRACE_DIR, `${String(idx).padStart(3, "0")}-${safeName}.log`);

    const inner = entry.shell
        ? `strace -f -s 400 -o ${traceFile} -e trace=${TRACE_SYSCALLS} -- /usr/bin/bash -c "${entry.shell}"`
        : `strace -f -s 400 -o ${traceFile} -e trace=${TRACE_SYSCALLS} -- ${entry.argv!.map(quoteArg).join(" ")}`;

    // config.default: deterministic mounts, independent of any active pi session
    const bwrapCmd = sandbox(BWRAP, inner, { cwd, config: sandboxConfig.default });
    // stdin is always explicitly fed (default: empty) so no audited command
    // can ever read from this process's terminal
    const res = spawnSync("bash", ["-c", bwrapCmd], {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        input: entry.stdin ?? "",
    });

    if (!fs.existsSync(traceFile)) {
        return {
            status: "fail",
            label,
            violations: [`no trace produced; bwrap exit=${res.status} stderr=${res.stderr?.trim()}`],
            info,
        };
    }

    const mounts = parseMounts(bwrapCmd);
    const allowedDests = mounts.map((m) => m.dest);
    const writableRoots = mounts.filter((m) => m.rw).map((m) => m.dest); // cwd, /tmp, /dev, /proc

    const violations: string[] = [];
    const calls = parseTrace(fs.readFileSync(traceFile, "utf8"));
    const allowedExecve = new Set<string>([labelArgv[0], ...(entry.helpers ?? [])]);

    for (const call of calls) {
        if (call.syscall === "connect") {
            violations.push(`connect() attempt: ${call.line}`);
            continue;
        }

        const p = callPath(call);
        if (p === undefined) {
            continue; // fd-only form (fstatfs etc.) — the fd came from a traced open
        }

        const resolved = path.resolve(cwd, p);

        if (call.syscall === "execve") {
            // failed execves are just PATH probing (a wrapper script searching
            // for a helper); only successful execs actually ran code
            if (call.retval >= 0) {
                const base = path.basename(p);
                if (!allowedExecve.has(base)) {
                    violations.push(`unexpected execve: ${call.line} (allowed: ${[...allowedExecve].join(", ")})`);
                }
            }
            continue;
        }

        const succeeded = call.retval >= 0;

        if (!isUnderAny(resolved, allowedDests)) {
            // metadata-only access to the namespace skeleton: bwrap auto-creates
            // the parent directories of every mount dest (and "/"), so stat-ing
            // them (glibc getcwd() stats "/") or opening them as directories
            // exposes nothing beyond the mount layout we define ourselves
            const isMetadata = call.syscall !== "openat" || /O_DIRECTORY/.test(call.args);
            if (succeeded && isMetadata && isSkeletonDir(resolved, mounts)) {
                continue;
            }
            if (succeeded) {
                violations.push(`access OUTSIDE allowed set succeeded: ${call.line} (resolved: ${resolved})`);
            } else {
                const key = `${call.errno ?? "?"} ${resolved}`;
                info.set(key, (info.get(key) ?? 0) + 1);
            }
            continue;
        }

        // inside the allowed set: check the write-scope assertion
        if (succeeded && /(O_WRONLY|O_RDWR|O_CREAT|O_TRUNC)/.test(call.args)) {
            if (!isUnderAny(resolved, writableRoots)) {
                violations.push(`write outside writable mounts: ${call.line}`);
            }
        }
    }

    return {
        status: violations.length > 0 ? "fail" : "pass",
        label,
        violations,
        info,
        traceFile,
        exitCode: res.status === null ? undefined : res.status,
    };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

buildFixture();

const results: Result[] = [];

// negative corpus: invocations that must NOT be allowed (heuristic only)
for (const neg of NEGATIVE_CORPUS) {
    const cwd = neg.repo ? path.join(FIXTURE_ROOT, "repo") : FIXTURE_ROOT;
    const perm = getArgsConfinementPermission(neg.argv, cwd, {});
    const ok = perm === undefined;
    results.push({
        status: ok ? "pass" : "corpus",
        label: `${neg.label}  [negative: ${neg.note}]`,
        violations: ok ? [] : [`heuristic ALLOWS this (${perm}) — spec changed?`],
        info: new Map(),
    });
    const tag = (ok ? "PASS" : "CORPUS").padEnd(7);
    console.log(`${tag} negative: ${neg.label}${ok ? "" : `  ! heuristic ALLOWS this (${perm})`}`);
}

let idx = 0;
for (const [command, entries] of Object.entries(CORPUS)) {
    for (const entry of entries) {
        idx++;
        const r = runEntry(command, entry, FIXTURE_ROOT, idx);
        results.push(r);
        const tag = r.status.toUpperCase().padEnd(7);
        const exitNote = r.exitCode !== undefined ? ` [exit ${r.exitCode}]` : "";
        console.log(`${tag} ${command}: ${r.label}${exitNote}`);
        for (const v of r.violations) {
            console.log(`         ! ${v}`);
        }
        if (r.skipped) {
            console.log(`         - ${r.skipped}`);
        }
    }
}

// aggregated info notes (failed accesses outside the allowed set — the sandbox
// hid them; each one is a potential functional note, e.g. a missing mount)
const allInfo = new Map<string, number>();
for (const r of results) {
    for (const [k, n] of r.info) {
        allInfo.set(k, (allInfo.get(k) ?? 0) + n);
    }
}

if (allInfo.size > 0) {
    console.log(`\nINFO: failed accesses outside the sandbox (safe — the paths are not mounted;`);
    console.log(`     listed because a missing mount can be a functional gap, not a security one):`);
    const sorted = [...allInfo.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, n] of sorted) {
        console.log(`     ${String(n).padStart(4)}x ${k}`);
    }
}

const pass = results.filter((r) => r.status === "pass").length;
const fail = results.filter((r) => r.status === "fail").length;
const skip = results.filter((r) => r.status === "skip").length;
const corpus = results.filter((r) => r.status === "corpus").length;

console.log(`\nSummary: ${pass} pass, ${fail} fail, ${corpus} corpus, ${skip} skip (${results.length} runs)`);
if (fail > 0 || corpus > 0) {
    console.log(`Traces kept in ${TRACE_DIR} for inspection.`);
    process.exit(1);
}
process.exit(0);
