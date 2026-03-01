import config, { type SandboxConfig } from "../common/config";

function escapeArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}

function escapeArgWithSubstitution(arg: string): string {
    arg = arg.replace(/^~/, process.env.HOME || "");
    return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}

function buildEnvCmd(sandboxConfig: SandboxConfig): string[] {
    const cmd: string[] = [];

    const setEnvVars = new Set<string>();
    const defaultEnvVars = ["PWD", "HOME", "PATH", "SHELL", "TERM", "USER"];

    const envConfig = sandboxConfig.sandbox?.env;
    const inheritEnvConfig = sandboxConfig.sandbox?.inheritEnv;

    // apply custom environment variables first
    if (envConfig) {
        for (const [key, value] of Object.entries(envConfig)) {
            setEnvVars.add(key);
            cmd.push("--setenv", key, escapeArg(value));
        }
    }

    // then go through the allowed envs
    if (inheritEnvConfig) {
        for (const [key, value] of Object.entries(process.env)) {
            if (value === undefined) {
                continue;
            }

            if (setEnvVars.has(key)) {
                continue;
            }

            setEnvVars.add(key);

            if (inheritEnvConfig[key] !== "allow") {
                continue;
            }

            cmd.push("--setenv", key, escapeArg(value));
        }
    }

    // finally, set the default envs
    for (const key of defaultEnvVars) {
        if (setEnvVars.has(key)) {
            continue;
        }

        const value = process.env[key];
        if (value === undefined) {
            continue;
        }

        setEnvVars.add(key);
        cmd.push("--setenv", key, escapeArg(value));
    }

    return cmd;
}

function buildMountCmd(): string[] {
    const cmd: string[] = [];

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

    const homeDir = process.env.HOME;
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

export default function sandbox(bwrap: string, command: string): string {
    const cmd: string[] = [bwrap];

    const sandboxConfig = config.current ?? config.default;

    cmd.push("--clearenv");

    const cwd = escapeArg(process.cwd());
    cmd.push("--bind", cwd, cwd);

    const envCmd = buildEnvCmd(sandboxConfig);
    cmd.push(...envCmd);

    for (const [source, mode] of Object.entries(sandboxConfig.sandbox?.mounts ?? {})) {
        const dest = source;

        if (mode === "readonly") {
            cmd.push("--ro-bind-try", escapeArgWithSubstitution(source), escapeArgWithSubstitution(dest));
        } else if (mode === "readwrite") {
            cmd.push("--bind-try", escapeArgWithSubstitution(source), escapeArgWithSubstitution(dest));
        }
    }

    // Add system and home mounts
    const mountCmd = buildMountCmd();
    cmd.push(...mountCmd);

    cmd.push("--die-with-parent");
    cmd.push("--", "bash", "-c", escapeArg(command));

    return cmd.join(" ");
}
