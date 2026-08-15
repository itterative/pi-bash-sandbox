import { describe, it, expect } from "vitest";
import { getCwdConfinementPermission } from "../../sandbox/heuristics";
import type { SandboxConfigCwdConfinement } from "../../common/config";

const CWD = "/project";

interface HeuristicTest {
    desc: string;
    command: string;
    config?: SandboxConfigCwdConfinement;
    expected: "allow:sandbox" | "allow" | undefined;
}

const runTests = (tests: HeuristicTest[]) => {
    it.each(tests)("$desc", (test) => {
        expect(getCwdConfinementPermission(test.command, CWD, test.config ?? {})).toBe(
            test.expected,
        );
    });
};

describe("getCwdConfinementPermission", () => {
    describe("known commands within cwd", () => {
        runTests([
            { desc: "relative path", command: "cat file.txt", expected: "allow:sandbox" },
            { desc: "absolute path inside cwd", command: "cat /project/file.txt", expected: "allow:sandbox" },
            { desc: "nested relative path", command: "cat src/index.ts", expected: "allow:sandbox" },
            { desc: "dot path", command: "ls ./src", expected: "allow:sandbox" },
            { desc: "no arguments (reads stdin/cwd)", command: "cat", expected: "allow:sandbox" },
            { desc: "flags only", command: "ls -la", expected: "allow:sandbox" },
            { desc: "cwd itself", command: "ls /project", expected: "allow:sandbox" },
            { desc: "path with .. staying inside", command: "cat src/../README.md", expected: "allow:sandbox" },
            { desc: "multiple files", command: "cat a.txt b.txt c.txt", expected: "allow:sandbox" },
            { desc: "value flag consumed", command: "head -n 5 file.txt", expected: "allow:sandbox" },
            { desc: "value flag inline (short)", command: "head -n5 file.txt", expected: "allow:sandbox" },
            { desc: "value flag inline (long)", command: "head --lines=5 file.txt", expected: "allow:sandbox" },
            { desc: "double dash separator", command: "cat -- -weird-name", expected: "allow:sandbox" },
            { desc: "lone dash (stdin)", command: "cat -", expected: "allow:sandbox" },
            { desc: "no positional args command", command: "pwd", expected: "allow:sandbox" },
            { desc: "ignore positionals command", command: "echo hello world", expected: "allow:sandbox" },
            { desc: "env assignment prefix", command: "FOO=bar cat file.txt", expected: "allow:sandbox" },
            { desc: "quoted path", command: 'cat "my file.txt"', expected: "allow:sandbox" },
        ]);
    });

    describe("paths outside cwd fall back", () => {
        runTests([
            { desc: "absolute path outside", command: "cat /etc/passwd", expected: undefined },
            { desc: "parent traversal escape", command: "cat ../outside.txt", expected: undefined },
            { desc: "home path outside cwd", command: "cat ~/secrets.txt", expected: undefined },
            { desc: "ls outside dir", command: "ls /tmp", expected: undefined },
            { desc: "flag path value outside", command: "sort -o /tmp/out.txt file.txt", expected: undefined },
            { desc: "unknown long flag with path value", command: "ls --foo=/etc/passwd", expected: undefined },
            { desc: "path flag value outside (inline)", command: "sort --output=/tmp/out file", expected: undefined },
        ]);
    });

    describe("unknown commands fall back", () => {
        runTests([
            { desc: "unknown command", command: "npm install", expected: undefined },
            { desc: "unknown command with in-cwd path", command: "curl ./file.txt", expected: undefined },
            { desc: "command invoked by absolute path", command: "/tmp/evil/cat file.txt", expected: undefined },
            { desc: "command invoked by relative path", command: "./cat file.txt", expected: undefined },
            { desc: "empty command", command: "", expected: undefined },
            { desc: "whitespace command", command: "   ", expected: undefined },
            { desc: "only env assignment", command: "FOO=bar", expected: undefined },
            { desc: "positionals on no-positional command", command: "pwd /project", expected: undefined },
        ]);
    });

    describe("chained and multi-line commands", () => {
        runTests([
            { desc: "pipe of known commands", command: "cat file.txt | grep foo", expected: "allow:sandbox" },
            { desc: "chain with &&", command: "ls src && cat src/index.ts", expected: "allow:sandbox" },
            { desc: "multi-line known commands", command: "cat a.txt\nls b.txt", expected: "allow:sandbox" },
            { desc: "chain with unknown command", command: "cat file.txt && rm -rf x", expected: undefined },
            { desc: "pipe with unknown command", command: "cat file.txt | nc host 80", expected: undefined },
            { desc: "second command escapes cwd", command: "cat a.txt\ncat /etc/passwd", expected: undefined },
        ]);
    });

    describe("redirections", () => {
        runTests([
            { desc: "write within cwd", command: "cat a.txt > b.txt", expected: "allow:sandbox" },
            { desc: "append within cwd", command: "echo hello >> log.txt", expected: "allow:sandbox" },
            { desc: "stderr to /dev/null", command: "ls src 2>/dev/null", expected: "allow:sandbox" },
            { desc: "read from within cwd", command: "wc -l < file.txt", expected: "allow:sandbox" },
            { desc: "write outside cwd", command: "cat a.txt > /tmp/out.txt", expected: undefined },
            { desc: "stderr outside cwd", command: "ls 2> /tmp/err.txt", expected: undefined },
            { desc: "read from outside cwd", command: "wc -l < /etc/passwd", expected: undefined },
        ]);
    });

    describe("grep pattern handling", () => {
        runTests([
            { desc: "pattern skipped, no paths", command: "grep foo file.txt", expected: "allow:sandbox" },
            { desc: "pattern with slash skipped", command: "grep foo/bar file.txt", expected: "allow:sandbox" },
            { desc: "recursive within cwd", command: "grep -rn foo ./src", expected: "allow:sandbox" },
            { desc: "path outside as file arg", command: "grep foo /etc/passwd", expected: undefined },
            { desc: "-e makes all positionals paths", command: "grep -e foo /etc/passwd", expected: undefined },
            { desc: "-e with contained paths", command: "grep -e foo a.txt b.txt", expected: "allow:sandbox" },
            { desc: "inline -e (short) makes positionals paths", command: "grep -efoo /etc/passwd", expected: undefined },
            { desc: "--regexp makes positionals paths", command: "grep --regexp foo /etc/passwd", expected: undefined },
            { desc: "--regexp= inline", command: "grep --regexp=foo /etc/passwd", expected: undefined },
            { desc: "-f pattern file inside cwd", command: "grep -f patterns.txt file.txt", expected: "allow:sandbox" },
            { desc: "-f pattern file outside cwd", command: "grep -f /etc/patterns file.txt", expected: undefined },
        ]);
    });

    describe("find safety", () => {
        runTests([
            { desc: "simple find within cwd", command: "find . -name foo", expected: "allow:sandbox" },
            { desc: "find with path", command: "find src -type f", expected: "allow:sandbox" },
            { desc: "find outside cwd", command: "find /etc -name foo", expected: undefined },
            { desc: "find -delete is unsafe", command: "find . -name foo -delete", expected: undefined },
            { desc: "find -exec is unsafe", command: "find . -exec rm {} \\;", expected: undefined },
            { desc: "find -execdir is unsafe", command: "find . -execdir echo {} +", expected: undefined },
            { desc: "find -fprintf is unsafe", command: "find . -fprintf out.txt %p", expected: undefined },
        ]);
    });

    describe("subshells and process substitution", () => {
        runTests([
            { desc: "subshell with known command", command: "cat $(echo file.txt)", expected: "allow:sandbox" },
            { desc: "backtick subshell", command: "cat `echo file.txt`", expected: "allow:sandbox" },
            { desc: "subshell with unknown command", command: "cat $(curl example.com)", expected: undefined },
            { desc: "subshell escaping cwd", command: "cat $(cat /etc/passwd)", expected: undefined },
            { desc: "nested subshells", command: "cat $(echo $(echo file.txt))", expected: "allow:sandbox" },
            { desc: "process substitution known", command: "cat <(echo hi)", expected: "allow:sandbox" },
            { desc: "process substitution unknown", command: "cat <(curl example.com)", expected: undefined },
            { desc: "redirection into process substitution", command: "echo hi > >(cat)", expected: "allow:sandbox" },
            { desc: "redirection into unknown process substitution", command: "echo hi > >(nc host 80)", expected: undefined },
        ]);
    });

    describe("heredocs", () => {
        runTests([
            { desc: "heredoc within cwd", command: "cat << EOF\nhello\nEOF", expected: "allow:sandbox" },
            { desc: "heredoc with path arg", command: "grep foo << EOF\nhello\nEOF", expected: "allow:sandbox" },
        ]);
    });

    describe("configuration", () => {
        runTests([
            {
                desc: "disabled heuristic falls back",
                command: "cat file.txt",
                config: { enabled: false },
                expected: undefined,
            },
            {
                desc: "custom permission",
                command: "cat file.txt",
                config: { permission: "allow" },
                expected: "allow",
            },
            {
                desc: "commands allowlist permits listed command",
                command: "ls src",
                config: { commands: ["ls"] },
                expected: "allow:sandbox",
            },
            {
                desc: "commands allowlist rejects other known commands",
                command: "cat file.txt",
                config: { commands: ["ls"] },
                expected: undefined,
            },
            {
                desc: "outside cwd still falls back with custom permission",
                command: "cat /etc/passwd",
                config: { permission: "allow" },
                expected: undefined,
            },
        ]);
    });
});
