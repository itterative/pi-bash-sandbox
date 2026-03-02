import os from "node:os";
import config, { type SandboxConfig } from "../common/config";

export interface SandboxOptions {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    config?: SandboxConfig;
}

function escapeArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}

function escapeArgWithSubstitution(arg: string, homeDir: string): string {
    arg = arg.replace(/^~/, homeDir);
    return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}

function buildEnvCmd(sandboxConfig: SandboxConfig, options?: SandboxOptions): string[] {
    const cmd: string[] = [];
    const env = options?.env ?? process.env;

    const setEnvVars = new Set<string>();
    const defaultEnvVars = ["PWD", "HOME", "PATH", "SHELL", "TERM", "USER"];

    const envConfig = sandboxConfig.sandbox?.env;
    const inheritEnvConfig = sandboxConfig.sandbox?.inheritEnv;

    if (inheritEnvConfig !== undefined) {
        cmd.push("--clearenv");
    }

    // apply custom environment variables first
    if (envConfig) {
        for (const [key, value] of Object.entries(envConfig)) {
            setEnvVars.add(key);
            cmd.push("--setenv", key, escapeArg(value));
        }
    }

    // then go through the allowed envs
    if (inheritEnvConfig) {
        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) {
                continue;
            }

            if (setEnvVars.has(key)) {
                continue;
            }

            if (inheritEnvConfig[key] !== "allow") {
                continue;
            }

            setEnvVars.add(key);
            cmd.push("--setenv", key, escapeArg(value));
        }
    }

    // finally, set the default envs
    for (const key of defaultEnvVars) {
        if (setEnvVars.has(key)) {
            continue;
        }

        const value = env[key];
        if (value === undefined) {
            continue;
        }

        setEnvVars.add(key);
        cmd.push("--setenv", key, escapeArg(value));
    }

    return cmd;
}

function buildMountCmd(options?: SandboxOptions): string[] {
    const cmd: string[] = [];
    const env = options?.env ?? process.env;

    cmd.push("--proc", "/proc");
    cmd.push("--dev", "/dev");

    const systemMounts = ["/usr", "/bin", "/lib", "/lib64", "/etc"];

    const commonMounts = [
        "/etc/bashrc",
        "/etc/bash.bashrc",
        "/etc/profile",
        "/etc/profile.d",
        "/etc/bash_completion",
        "/usr/share/bash-completion",
    ];

    const homeMounts = [
        ".bashrc",
        ".bash_profile",
        ".bash_history",
        ".local",
        ".config",
    ];

    for (const mount of systemMounts) {
        cmd.push("--ro-bind", escapeArg(mount), escapeArg(mount));
    }

    for (const file of commonMounts) {
        cmd.push("--ro-bind-try", escapeArg(file), escapeArg(file));
    }

    const homeDir = env.HOME ?? os.homedir();
    if (homeDir) {
        for (const file of homeMounts) {
            cmd.push(
                "--ro-bind-try",
                escapeArg(`${homeDir}/${file}`),
                escapeArg(`${homeDir}/${file}`),
            );
        }
    }

    return cmd;
}

export default function sandbox(bwrap: string, command: string, options?: SandboxOptions): string {
    const cmd: string[] = [bwrap];
    const env = options?.env ?? process.env;
    const cwd = options?.cwd ?? process.cwd();
    const homeDir = env.HOME ?? os.homedir();

    const sandboxConfig = options?.config ?? config.current ?? config.default;

    cmd.push("--bind", escapeArg(cwd), escapeArg(cwd));

    const envCmd = buildEnvCmd(sandboxConfig, { env, cwd });
    cmd.push(...envCmd);

    for (const [source, mode] of Object.entries(sandboxConfig.sandbox?.mounts ?? {})) {
        const dest = source;

        if (mode === "readonly") {
            cmd.push("--ro-bind-try", escapeArgWithSubstitution(source, homeDir), escapeArgWithSubstitution(dest, homeDir));
        } else if (mode === "readwrite") {
            cmd.push("--bind-try", escapeArgWithSubstitution(source, homeDir), escapeArgWithSubstitution(dest, homeDir));
        }
    }

    // Add system and home mounts
    const mountCmd = buildMountCmd(options);
    cmd.push(...mountCmd);

    const shell = env.SHELL ?? "sh";

    cmd.push("--die-with-parent");
    cmd.push("--", shell, "-c", escapeArg(command));

    return cmd.join(" ");
}
