import config from "../common/config";

function escapeArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}

export default function sandbox(bwrap: string, command: string): string {
    const cmd: string[] = [bwrap];

    cmd.push("--unshare-all");

    const cwd = escapeArg(process.cwd());

    cmd.push("--bind", cwd, cwd);
    cmd.push("--setenv", "PWD", cwd); // note: should this be --chdir ? docs don't explain well

    const sandboxConfig = config.current ?? config.default;
    const mounts = sandboxConfig.mounts ?? {};

    for (const [source, mode] of Object.entries(mounts)) {
        const dest = source;

        if (mode === "readonly") {
            cmd.push("--ro-bind-try", escapeArg(source), escapeArg(dest));
        } else if (mode === "readwrite") {
            cmd.push("--bind-try", escapeArg(source), escapeArg(dest));
        }
    }

    cmd.push("--proc", "/proc");
    cmd.push("--dev", "/dev");

    const systemMounts = ["/usr", "/bin", "/lib", "/lib64", "/etc"];

    for (const mount of systemMounts) {
        cmd.push("--ro-bind", escapeArg(mount), escapeArg(mount));
    }

    const commonMounts = [
        "/etc/bashrc",
        "/etc/bash.bashrc",
        "/etc/profile",
        "/etc/profile.d",
        "/etc/bash_completion",
        "/usr/share/bash-completion",
    ];

    for (const file of commonMounts) {
        cmd.push("--ro-bind-try", escapeArg(file), escapeArg(file));
    }

    const homeDir = process.env.HOME;

    if (homeDir) {
        const homeMounts = [
            ".bashrc",
            ".bash_profile",
            ".bash_history",
            ".local",
            ".config",
        ];

        for (const file of homeMounts) {
            cmd.push(
                "--ro-bind-try",
                escapeArg(`${homeDir}/${file}`),
                escapeArg(`${homeDir}/${file}`),
            );
        }
    }

    cmd.push("--die-with-parent");
    cmd.push("--", "sh", "-c", escapeArg(command));

    return cmd.join(" ");
}
