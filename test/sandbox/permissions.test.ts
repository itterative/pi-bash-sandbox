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

    describe("wildcard matching", () => {
        it("should match command with single * wildcard at end", () => {
            const result = getPermission("grep pattern", { "grep *": "allow" });
            expect(result).toBe("allow");
        });

        it("should match command with single * wildcard at start", () => {
            const result = getPermission("find /tmp", { "* /tmp": "allow" });
            expect(result).toBe("allow");
        });

        it("should match command with * wildcard in middle", () => {
            const result = getPermission("find /tmp -name test", {
                "find * -name *": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match command with multiple * wildcards", () => {
            const result = getPermission("find /tmp -name test.txt", {
                "find * -name *": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should not match when wildcard pattern does not fit", () => {
            const result = getPermission("ls -la /home", { "grep *": "allow" });
            expect(result).toBe("ask");
        });
    });

    describe("special character escaping", () => {
        it("should match literal dot in command", () => {
            const result = getPermission("ls -la .", { "ls -la .": "allow" });
            expect(result).toBe("allow");
        });

        it("should match literal dollar sign in command", () => {
            const result = getPermission("echo $HOME", {
                "echo $HOME": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match literal caret in command", () => {
            const result = getPermission("grep ^pattern", {
                "grep ^pattern": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match literal plus in command", () => {
            const result = getPermission("npm install +foo", {
                "npm install +foo": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match literal question mark in command", () => {
            const result = getPermission("ls file?.txt", {
                "ls file?.txt": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match literal parentheses in command", () => {
            const result = getPermission("mkdir (test)", {
                "mkdir (test)": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match literal square brackets in command", () => {
            const result = getPermission("ls [abc].txt", {
                "ls [abc].txt": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match literal curly braces in command", () => {
            const result = getPermission("echo {a,b}", {
                "echo {a,b}": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match literal pipe in command", () => {
            const result = getPermission("cmd | other", {
                "cmd | other": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should match literal backslash in command", () => {
            const result = getPermission("path\\to\\file", {
                "path\\to\\file": "allow",
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

    describe("complex patterns", () => {
        it("should match complex pipeline command", () => {
            const result = getPermission("find * | grep *", {
                "find * | grep *": "allow",
            });
            expect(result).toBe("allow");
        });

        it("should not match similar but different pipeline", () => {
            const result = getPermission("find * | cat", {
                "find * | grep *": "allow",
            });
            expect(result).toBe("ask");
        });

        it("should match with spaces and wildcards", () => {
            const result = getPermission("npm install --save-dev", {
                "npm install *": "allow",
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

        it("should handle commands with multiple spaces", () => {
            const result = getPermission("cmd  arg", { "cmd  arg": "allow" });
            expect(result).toBe("allow");
        });

        it("should handle case-sensitive matching", () => {
            const result = getPermission("LS -LA", { "ls -la": "allow" });
            expect(result).toBe("ask");
        });

        it("should handle Unicode characters", () => {
            const result = getPermission("echo 你好", { "echo 你好": "allow" });
            expect(result).toBe("allow");
        });
    });
});
