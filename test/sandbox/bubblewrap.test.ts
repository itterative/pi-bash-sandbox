import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import config from "../../common/config";
import sandbox, { type SandboxOptions } from "../../sandbox/bubblewrap";

describe("bubblewrap", () => {
    let tempDir: string;
    let projectDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-test-"));
        projectDir = path.join(tempDir, "project");
        fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function writeProjectConfig(cfg: object): ReturnType<typeof config.load> {
        fs.writeFileSync(
            path.join(projectDir, ".pi", "bash-sandbox-config.json"),
            JSON.stringify(cfg)
        );
        return config.load(projectDir);
    }

    describe("buildEnvCmd - default environment variables", () => {
        it("should set HOME from env.HOME when available", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("--setenv HOME '/home/testuser'");
        });

        it("should NOT set HOME when env.HOME is undefined", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { PATH: "/usr/bin", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).not.toMatch(/--setenv HOME '/);
        });

        it("should set USER from env.USER when available", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("--setenv USER 'testuser'");
        });

        it("should NOT set USER when env.USER is undefined", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).not.toMatch(/--setenv USER '/);
        });

        it("should set PATH from env.PATH when available", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/local/bin:/usr/bin", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("--setenv PATH '/usr/local/bin:/usr/bin'");
        });

        it("should NOT set PATH when env.PATH is undefined", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).not.toMatch(/--setenv PATH '/);
        });

        it("should set PWD from env.PWD when available", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser", PWD: "/custom/pwd" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("--setenv PWD '/custom/pwd'");
        });

        it("should set SHELL from env.SHELL when available", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser", SHELL: "/bin/zsh" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("--setenv SHELL '/bin/zsh'");
        });

        it("should allow config env to override env vars", () => {
            const testConfig = writeProjectConfig({
                sandbox: {
                    mounts: {},
                    env: {
                        HOME: "/home/custom",
                    },
                },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/original", PATH: "/usr/bin", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            // Config env should take precedence
            expect(result).toContain("--setenv HOME '/home/custom'");
            expect(result).not.toContain("--setenv HOME '/home/original'");
        });
    });

    describe("clearenv behavior", () => {
        it("should include --clearenv in the command", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("--clearenv");
        });
    });

    describe("inheritEnv behavior", () => {
        it("should inherit env vars marked as 'allow' in inheritEnv config", () => {
            const testConfig = writeProjectConfig({
                sandbox: {
                    mounts: {},
                    inheritEnv: {
                        CUSTOM_VAR: "allow",
                        SECRET_VAR: "deny",
                    },
                },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: {
                    HOME: "/home/testuser",
                    PATH: "/usr/bin",
                    USER: "testuser",
                    CUSTOM_VAR: "custom_value",
                    SECRET_VAR: "secret",
                },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("--setenv CUSTOM_VAR 'custom_value'");
            expect(result).not.toContain("--setenv SECRET_VAR 'secret'");
        });

        it("should not process inheritEnv when it is empty", () => {
            const testConfig = writeProjectConfig({
                sandbox: {
                    mounts: {},
                    inheritEnv: {},
                },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: {
                    HOME: "/home/testuser",
                    PATH: "/usr/bin",
                    USER: "testuser",
                    CUSTOM_VAR: "custom_value",
                },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            // Default env vars should still be set
            expect(result).toContain("--setenv HOME '/home/testuser'");
            expect(result).toContain("--setenv USER 'testuser'");
            expect(result).toContain("--setenv PATH '/usr/bin'");
            // But CUSTOM_VAR should NOT be set (empty inheritEnv means no inheritance)
            expect(result).not.toContain("--setenv CUSTOM_VAR");
        });
    });

    describe("shell behavior", () => {
        it("should use SHELL env var when available", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser", SHELL: "/bin/zsh" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("-- /bin/zsh -c 'echo hello'");
        });

        it("should fallback to sh when SHELL is not set", () => {
            const testConfig = writeProjectConfig({
                sandbox: { mounts: {} },
                permissions: {},
            });

            const options: SandboxOptions = {
                env: { HOME: "/home/testuser", PATH: "/usr/bin", USER: "testuser" },
                cwd: projectDir,
                config: testConfig,
            };

            const result = sandbox("bwrap", "echo hello", options);

            expect(result).toContain("-- sh -c 'echo hello'");
        });
    });
});
