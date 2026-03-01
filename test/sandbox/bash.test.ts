import { describe, it, expect } from "vitest";
import { parseBashArgs } from "../../sandbox/bash";

describe("parseBashArgs", () => {
    describe("basic parsing", () => {
        it("should parse simple command", () => {
            const result = parseBashArgs("echo hello");
            expect(result).toEqual(["echo", "hello"]);
        });

        it("should parse command with multiple args", () => {
            const result = parseBashArgs("git commit -m message");
            expect(result).toEqual(["git", "commit", "-m", "message"]);
        });

        it("should handle commands with multiple spaces between args", () => {
            const result = parseBashArgs("cmd  arg");
            expect(result).toEqual(["cmd", "arg"]);
        });

        it("should handle leading/trailing whitespace", () => {
            const result = parseBashArgs("  ls -la  ");
            expect(result).toEqual(["ls", "-la"]);
        });

        it("should handle tabs as separators", () => {
            const result = parseBashArgs("cmd\targ");
            expect(result).toEqual(["cmd", "arg"]);
        });

        it("should handle empty command string", () => {
            const result = parseBashArgs("");
            expect(result).toEqual([]);
        });
    });

    describe("quoted arguments", () => {
        it("should handle double-quoted arguments with spaces", () => {
            const result = parseBashArgs('npm run "dev server"');
            expect(result).toEqual(["npm", "run", "dev server"]);
        });

        it("should handle single-quoted arguments with spaces", () => {
            const result = parseBashArgs("cat 'hello world.txt'");
            expect(result).toEqual(["cat", "hello world.txt"]);
        });

        it("should handle mixed quoting styles", () => {
            const result = parseBashArgs('echo "hello" \'world\'');
            expect(result).toEqual(["echo", "hello", "world"]);
        });

        it("should handle escaped space in argument", () => {
            const result = parseBashArgs("echo hello\\ world");
            expect(result).toEqual(["echo", "hello world"]);
        });
    });

    describe("heredoc parsing", () => {
        it("should parse cat <<EOF with content", () => {
            const result = parseBashArgs("cat <<EOF\ncontent\nEOF");
            expect(result).toEqual(["cat", "<<", "EOF", "EOF"]);
        });

        it("should parse cat << OTHER with space", () => {
            const result = parseBashArgs("cat << OTHER");
            expect(result).toEqual(["cat", "<<", "OTHER"]);
        });

        it("should parse cat <<EOF without content", () => {
            const result = parseBashArgs("cat <<EOF");
            expect(result).toEqual(["cat", "<<", "EOF"]);
        });

        it("should parse heredoc with <<- operator", () => {
            const result = parseBashArgs("cat <<-EOF\ncontent\nEOF");
            expect(result).toEqual(["cat", "<<-", "EOF", "EOF"]);
        });
    });

    describe("subshell parsing", () => {
        it("should parse command with $(...) subshell", () => {
            const result = parseBashArgs("echo $(echo hello)");
            expect(result).toEqual(["echo", "$(echo hello)"]);
        });

        it("should parse command with backtick subshell", () => {
            const result = parseBashArgs("echo `echo hello`");
            expect(result).toEqual(["echo", "`echo hello`"]);
        });

        it("should parse nested subshells", () => {
            const result = parseBashArgs("echo $(cat $(echo file.txt))");
            expect(result).toEqual(["echo", "$(cat $(echo file.txt))"]);
        });

        it("should parse subshell with spaces", () => {
            const result = parseBashArgs("echo $(ls -la /tmp)");
            expect(result).toEqual(["echo", "$(ls -la /tmp)"]);
        });
    });

    describe("process substitution", () => {
        it("should parse process substitution <()", () => {
            const result = parseBashArgs("diff <(cat a.txt) <(cat b.txt)");
            expect(result).toEqual(["diff", "<(cat a.txt)", "<(cat b.txt)"]);
        });

        it("should parse process substitution >()", () => {
            const result = parseBashArgs("tee >(cat)");
            expect(result).toEqual(["tee", ">(cat)"]);
        });

        it("should parse process substitution with spaces inside", () => {
            const result = parseBashArgs("diff <(cat a b) >(echo x y)");
            expect(result).toEqual(["diff", "<(cat a b)", ">(echo x y)"]);
        });
    });

    describe("command chaining", () => {
        it("should parse && chaining", () => {
            const result = parseBashArgs("cat file.txt && rm file.txt");
            expect(result).toEqual(["cat", "file.txt", "&&", "rm", "file.txt"]);
        });

        it("should parse || chaining", () => {
            const result = parseBashArgs("cat file.txt || echo failed");
            expect(result).toEqual(["cat", "file.txt", "||", "echo", "failed"]);
        });

        it("should parse ; chaining", () => {
            const result = parseBashArgs("cd /tmp; ls -la");
            expect(result).toEqual(["cd", "/tmp", ";", "ls", "-la"]);
        });

        it("should parse | (pipe)", () => {
            const result = parseBashArgs("cat file.txt | grep foo");
            expect(result).toEqual(["cat", "file.txt", "|", "grep", "foo"]);
        });

        it("should parse multiple chain operators", () => {
            const result = parseBashArgs("a && b || c; d | e");
            expect(result).toEqual(["a", "&&", "b", "||", "c", ";", "d", "|", "e"]);
        });

        it("should parse chain operators without spaces", () => {
            const result = parseBashArgs("a&&b||c;d|e");
            expect(result).toEqual(["a", "&&", "b", "||", "c", ";", "d", "|", "e"]);
        });
    });

    describe("redirections", () => {
        it("should parse output redirection", () => {
            const result = parseBashArgs("cat file.txt > output.txt");
            expect(result).toEqual(["cat", "file.txt", ">", "output.txt"]);
        });

        it("should parse append redirection", () => {
            const result = parseBashArgs("cat file.txt >> output.txt");
            expect(result).toEqual(["cat", "file.txt", ">>", "output.txt"]);
        });

        it("should parse input redirection", () => {
            const result = parseBashArgs("cat < input.txt");
            expect(result).toEqual(["cat", "<", "input.txt"]);
        });

        it("should parse stderr redirection", () => {
            const result = parseBashArgs("cat file.txt 2> errors.txt");
            expect(result).toEqual(["cat", "file.txt", "2>", "errors.txt"]);
        });

        it("should parse stderr to stdout", () => {
            const result = parseBashArgs("cat file.txt 2>&1");
            expect(result).toEqual(["cat", "file.txt", "2>&1"]);
        });

        it("should parse combined redirections", () => {
            const result = parseBashArgs("cat file.txt > out.txt 2>&1");
            expect(result).toEqual(["cat", "file.txt", ">", "out.txt", "2>&1"]);
        });
    });

    describe("special characters", () => {
        it("should handle literal dot in argument", () => {
            const result = parseBashArgs("ls -la .");
            expect(result).toEqual(["ls", "-la", "."]);
        });

        it("should handle literal dollar sign in argument", () => {
            const result = parseBashArgs("echo $HOME");
            expect(result).toEqual(["echo", "$HOME"]);
        });

        it("should handle literal pipe in argument", () => {
            const result = parseBashArgs("cmd | other");
            expect(result).toEqual(["cmd", "|", "other"]);
        });

        it("should handle literal backslash in argument", () => {
            const result = parseBashArgs("path\\ to\\ file");
            expect(result).toEqual(["path to file"]);
        });
    });
});
