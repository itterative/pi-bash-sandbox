import { describe, it, expect } from "vitest";
import getPermission from "../../sandbox/permissions";

describe("getPermission", () => {
    describe("default behavior", () => {
        it('should return "ask" when no permissions are configured', () => {
            const result = getPermission("some-command", {});
            expect(result).toBe("ask");
        });

        it('should return "ask" as default when command does not match any permission', () => {
            const result = getPermission("random-command", {
                "other-command": "allow",
            });
            expect(result).toBe("ask");
        });
    });

    describe("exact matches", () => {
        it('should match exact command with "allow"', () => {
            const result = getPermission("ls -la", { "ls -la": "allow" });
            expect(result).toBe("allow");
        });

        it('should match exact command with "deny"', () => {
            const result = getPermission("rm -rf /", { "rm -rf /": "deny" });
            expect(result).toBe("deny");
        });

        it('should match exact command with "ask"', () => {
            const result = getPermission("sudo apt update", {
                "sudo apt update": "ask",
            });
            expect(result).toBe("ask");
        });

        it('should match exact command with "allow:sandbox"', () => {
            const result = getPermission("docker ps", {
                "docker ps": "allow:sandbox",
            });
            expect(result).toBe("allow:sandbox");
        });
    });

    describe("argument-level wildcard matching", () => {
        describe("wildcard at end of pattern", () => {
            it("should match command with * wildcard at end", () => {
                const result = getPermission("grep pattern", { "grep *": "allow" });
                expect(result).toBe("allow");
            });

            it("should match multi-argument command", () => {
                const result = getPermission("npm install --save-dev", {
                    "npm *": "allow",
                });
                expect(result).toBe("allow");
            });

            it("should match specific subcommand pattern", () => {
                const result = getPermission("npm run dev", {
                    "npm run *": "allow",
                });
                expect(result).toBe("allow");
            });

            it("should not match when command doesn't have prefix", () => {
                const result = getPermission("ls -la", { "grep *": "allow" });
                expect(result).toBe("ask");
            });
        });

        describe("wildcard at start of pattern", () => {
            it("should match command with * wildcard at start", () => {
                const result = getPermission("find /tmp", { "* /tmp": "allow" });
                expect(result).toBe("allow");
            });

            it("should match any command ending with specific arg", () => {
                const result = getPermission("cat file.txt", { "* file.txt": "allow" });
                expect(result).toBe("allow");
            });

            it("should not match if path is absolute but rule is relative", () => {
                const result = getPermission("ls -la /path/to/file.txt", {
                    "* file.txt": "allow",
                });
                expect(result).toBe("ask");
            });
        });

        describe("wildcard in middle of pattern", () => {
            it("should match command with * wildcard in middle", () => {
                const result = getPermission("find /tmp -name test", {
                    "find * -name *": "allow",
                });
                expect(result).toBe("allow");
            });

            it("should match multiple wildcards in pattern", () => {
                const result = getPermission("find /tmp -type f -name test.txt", {
                    "find * -name *": "allow",
                });
                expect(result).toBe("allow");
            });

            it("should require correct number of args before wildcard", () => {
                const result = getPermission("find -name test", {
                    "find /tmp -name *": "allow",
                });
                expect(result).toBe("ask");
            });
        });

        describe("multiple wildcards", () => {
            it("should match command with multiple separate wildcards", () => {
                const result = getPermission("cp source.txt dest.txt", {
                    "* *": "allow",
                });
                expect(result).toBe("allow");
            });

            it("should match complex pattern with multiple wildcards", () => {
                const result = getPermission("git add file.txt", {
                    "git * *": "allow",
                });
                expect(result).toBe("allow");
            });
        });
    });

    describe("special character escaping within arguments", () => {
        it("should match literal dot in argument", () => {
            const result = getPermission("ls -la .", { "ls -la .": "allow" });
            expect(result).toBe("allow");
        });

        it("should match literal dollar sign in argument", () => {
            const result = getPermission("echo $HOME", {
                "echo $HOME": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match literal caret in argument", () => {
            const result = getPermission("grep ^pattern", {
                "grep ^pattern": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match literal plus in argument", () => {
            const result = getPermission("npm install +foo", {
                "npm install +foo": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match literal question mark in argument", () => {
            const result = getPermission("ls file?.txt", {
                "ls file?.txt": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match literal parentheses in argument", () => {
            const result = getPermission("mkdir (test)", {
                "mkdir (test)": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match literal square brackets in argument", () => {
            const result = getPermission("ls [abc].txt", {
                "ls [abc].txt": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match literal curly braces in argument", () => {
            const result = getPermission("echo {a,b}", {
                "echo {a,b}": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match literal pipe in argument", () => {
            const result = getPermission("cmd | other", {
                "cmd | other": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match literal backslash in argument", () => {
            const result = getPermission("path\\to\\file", {
                "path\\to\\file": "allow",
            });
            expect(result).toBe("allow");
        });
    });

    describe("quoted arguments", () => {
        it("should handle double-quoted arguments with spaces", () => {
            const result = getPermission('npm run "dev server"', {
                'npm run "dev server"': "allow",
            });
            expect(result).toBe("allow");
        });

        it("should handle double-quoted arguments with wildcard", () => {
            const result = getPermission('git commit -am "test commit"', {
                'git commit -am "*"': "allow",
            });
            expect(result).toBe("allow");
        });

        it("should handle single-quoted arguments with spaces", () => {
            const result = getPermission("cat 'hello world.txt'", {
                "cat 'hello world.txt'": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should handle single-quoted arguments with wildcard", () => {
          const result = getPermission('git commit -am \'test commit\'', {
              'git commit -am \'*\'': "allow",
          });
          expect(result).toBe("allow");
        });

        it("should handle wildcard with quoted argument", () => {
            const result = getPermission('npm run "dev server"', {
                'npm run *': "allow",
            });
            expect(result).toBe("allow");
        });

        it("should handle escaped space in argument", () => {
            const result = getPermission("echo hello\\ world", {
                "echo hello\\ world": "allow",
            });
            expect(result).toBe("allow");
        });
    });

    describe("multiple permissions - last one wins", () => {
        it("should use the last matching permission when multiple match", () => {
            const result = getPermission("grep pattern", {
                "grep *": "allow",
                "grep pattern": "deny",
            });
            expect(result).toBe("deny");
        });

        it("should use the last matching permission for wildcard patterns", () => {
            const result = getPermission("find /tmp", {
                "*": "allow",
                "find *": "deny",
            });
            expect(result).toBe("deny");
        });

        it("should use the first matching permission when only one matches", () => {
            const result = getPermission("ls -la", {
                "ls -la": "allow",
                "grep *": "deny",
            });
            expect(result).toBe("allow");
        });
    });

    describe("edge cases", () => {
        it("should handle empty command string", () => {
            const result = getPermission("", { "": "allow" });
            expect(result).toBe("allow");
        });

        it('should return "ask" for empty command when no empty permission exists', () => {
            const result = getPermission("", { ls: "allow" });
            expect(result).toBe("ask");
        });

        it("should handle case-sensitive matching", () => {
            const result = getPermission("LS -LA", { "ls -la": "allow" });
            expect(result).toBe("ask");
        });

        it("should handle Unicode characters", () => {
            const result = getPermission("echo 你好", { "echo 你好": "allow" });
            expect(result).toBe("allow");
        });

        it("should handle commands with many arguments", () => {
            const result = getPermission(
                "cp file1.txt file2.txt file3.txt file4.txt",
                { "cp *": "allow" },
            );
            expect(result).toBe("allow");
        });

        it("should handle single wildcard matching anything", () => {
            const result = getPermission("any command here", { "*": "allow" });
            expect(result).toBe("allow");
        });

        it("should handle wildcard with multiple non-matching lookaheads", () => {
            const result = getPermission("ls -la", { "* file.txt": "allow" });
            expect(result).toBe("ask");
        });

        it("should handle multiple consecutive wildcards", () => {
            const result = getPermission("git commit -m message", {
                "git * *": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should handle wildcard at start with multiple lookaheads", () => {
            const result = getPermission("rm -rf /tmp", { "* -rf /tmp": "allow" });
            expect(result).toBe("allow");
        });

        it("should handle wildcard at end with multiple args", () => {
            const result = getPermission("echo hello world", { "echo *": "allow" });
            expect(result).toBe("allow");
        });

        it("should not match when lookahead arg is missing", () => {
            const result = getPermission("grep pattern", { "* file.txt": "allow" });
            expect(result).toBe("ask");
        });

        it("should handle pattern with only wildcards", () => {
            const result = getPermission("anything goes", { "* * *": "allow" });
            expect(result).toBe("allow");
        });

        it("should handle exact match after wildcard pattern", () => {
            const result = getPermission("npm install", { "npm *": "allow" });
            expect(result).toBe("allow");
        });

        it("should handle partial match rejection", () => {
            const result = getPermission("git add", { "git add file.txt": "allow" });
            expect(result).toBe("ask");
        });

        it("should handle wildcard in argument", () => {
            const result = getPermission("npm run test:all", { "npm run test:*": "allow" });
            expect(result).toBe("allow");
        });
    });

    describe("heredoc support", () => {
        it("should match command with heredoc delimiter", () => {
            const result = getPermission("cat <<EOF\ncontent\nEOF", {
                "cat << EOF": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match command with heredoc wildcard delimiter", () => {
            const result = getPermission("cat <<MYEOF\ncontent\nMYEOF", {
                "cat << *": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match heredoc with <<- operator", () => {
            const result = getPermission("cat <<-EOF\ncontent\nEOF", {
                "cat <<- EOF": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match heredoc with wildcard operator", () => {
            const result = getPermission("git commit <<EOF\ncontent\nEOF", {
                "git commit << *": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match regardless of heredoc delimiter name", () => {
            const result = getPermission("cat <<EOF\ncontent\nEOF", {
                "cat << OTHER": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should not match when heredoc operator differs", () => {
            const result = getPermission("cat <<EOF\ncontent\nEOF", {
                "cat <<- EOF": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should match heredoc with content and end delimiter", () => {
            const result = getPermission("cat <<EOF\nhello world\nEOF", {
                "cat <<EOF": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should not match when command has piping but pattern does not", () => {
            const result = getPermission("cat file.txt | grep foo", {
                "cat file.txt": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should not match when heredoc command has piping but pattern does not", () => {
            const command = "cat file.txt <<EOF | grep test\ntesting\nEOF";
            const result = getPermission(command, {
                "cat file.txt << EOF": "allow",
            });
            expect(result).toBe("ask");
        });
    });

    describe("subshell support", () => {
        it("should match exact command with subshell", () => {
            const result = getPermission("echo $(echo hello)", {
                "echo $(echo hello)": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should not match different subshell content", () => {
            const result = getPermission("echo $(echo world)", {
                "echo $(echo hello)": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should match wildcard inside subshell", () => {
            const result = getPermission("echo $(echo hello)", {
                "echo $(echo *)": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should not match different content with wildcard in subshell", () => {
            const result = getPermission("echo $(echo hello)", {
                "echo $(cat *)": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should match wildcard for subshell argument", () => {
            const result = getPermission("echo $(cat file.txt)", {
                "echo $(cat *)": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match multiple wildcards in subshell", () => {
            const result = getPermission("echo $(cat /tmp/file.txt)", {
                "echo $(cat * *)": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match wildcard for entire subshell", () => {
            const result = getPermission("echo $(echo hello)", {
                "echo *": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match wildcard subshell pattern", () => {
            const result = getPermission("echo $(cat file.txt)", {
                "echo $(*)": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should not match wildcard in subshell when outer args differ", () => {
            const result = getPermission("echo $(cat file.txt) extra", {
                "echo $(cat *)": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should match nested subshells with wildcards", () => {
            const result = getPermission("echo $(cat $(echo file.txt))", {
                "echo $(cat $(echo *))": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should not match different nested subshell", () => {
            const result = getPermission("echo $(cat $(echo file.txt))", {
                "echo $(cat $(cat *))": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should match backtick subshell with wildcard", () => {
            const result = getPermission("echo `cat file.txt`", {
                "echo `cat *`": "allow",
            });
            expect(result).toBe("allow");
        });
    });

    describe("process substitution support", () => {
        it("should match exact process substitution", () => {
            const result = getPermission("diff <(cat a.txt) <(cat b.txt)", {
                "diff <(cat a.txt) <(cat b.txt)": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match process substitution with wildcard", () => {
            const result = getPermission("diff <(cat a.txt) <(cat b.txt)", {
                "diff <(cat *) <(cat *)": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should not match different process substitution content", () => {
            const result = getPermission("diff <(cat a.txt) <(cat b.txt)", {
                "diff <(echo *) <(echo *)": "allow",
            });
            expect(result).toBe("ask");
        });
    });

    describe("command chaining support", () => {
        it("should match exact command with &&", () => {
            const result = getPermission("cat file.txt && rm file.txt", {
                "cat file.txt && rm file.txt": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should not match partial chain", () => {
            const result = getPermission("cat file.txt && rm file.txt", {
                "cat file.txt": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should match chained command with wildcard", () => {
            const result = getPermission("cat file.txt && rm file.txt", {
                "cat * && rm *": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should not match different chain operator", () => {
            const result = getPermission("cat file.txt && rm file.txt", {
                "cat file.txt || rm file.txt": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should not match wildcard if commands are chained", () => {
            const result = getPermission("cat file.txt && rm file.txt", {
                "cat *": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should not match wildcard with || chain operator", () => {
            const result = getPermission("cat file.txt || rm file.txt", {
                "cat *": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should not match wildcard with ; chain operator", () => {
            const result = getPermission("cat file.txt; rm file.txt", {
                "cat *": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should not match wildcard with | pipe operator", () => {
            const result = getPermission("cat file.txt | grep foo", {
                "cat *": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should not match single wildcard with chained commands", () => {
            const result = getPermission("cat file.txt && rm file.txt", {
                "*": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should match explicit || chain with wildcards", () => {
            const result = getPermission("cat file.txt || rm file.txt", {
                "cat * || rm *": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match explicit ; chain with wildcards", () => {
            const result = getPermission("cat file.txt; rm file.txt", {
                "cat *; rm *": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match explicit | pipe with wildcards", () => {
            const result = getPermission("cat file.txt | grep foo", {
                "cat * | grep *": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should not match wildcard with multiple chained commands", () => {
            const result = getPermission("a && b && c", {
                "a *": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should match multiple explicit chain operators with wildcards", () => {
            const result = getPermission("a && b && c", {
                "a * && b && *": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should not match if first command in chain differs", () => {
            const result = getPermission("cat file.txt && rm file.txt", {
                "dog * && rm *": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should not match if chain operator mismatch with wildcard", () => {
            const result = getPermission("cat file.txt && rm file.txt", {
                "cat * || rm *": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should handle wildcard before explicit chain operator", () => {
            const result = getPermission("npm install && npm test", {
                "npm * && npm test": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should handle wildcard after explicit chain operator", () => {
            const result = getPermission("npm install && npm run build", {
                "npm install && npm *": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should handle multiple wildcards around chain operators", () => {
            const result = getPermission("git add . && git commit -m msg && git push", {
                "git * && git * && git *": "allow",
            });
            expect(result).toBe("allow");
        });
    });

    describe("redirection support", () => {
        it("should match exact command with redirection", () => {
            const result = getPermission("cat file.txt > output.txt", {
                "cat file.txt > output.txt": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should not match command without redirection", () => {
            const result = getPermission("cat file.txt > output.txt", {
                "cat file.txt": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should match redirection with wildcard", () => {
            const result = getPermission("cat file.txt > output.txt", {
                "cat * > *": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should not match different redirection type", () => {
            const result = getPermission("cat file.txt > output.txt", {
                "cat file.txt >> output.txt": "allow",
            });
            expect(result).toBe("ask");
        });
    });
});
