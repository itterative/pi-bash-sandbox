import { PATH_VALUE, VALUE, type CommandSpec } from "./spec";

/**
 * No-filesystem-argument commands and system utilities (no file access, or
 * program names instead of paths).
 */
export const SYSTEM_COMMANDS: Record<string, CommandSpec> = {
    pwd: { positionals: "none" },
    true: { positionals: "none" },
    false: { positionals: "none" },
    echo: { positionals: "ignore" },
    printf: { positionals: "ignore" },

    date: {
        flags: {
            "-d": VALUE, "--date": VALUE,
            "-f": PATH_VALUE, "--file": PATH_VALUE,
        },
    },
    sleep: { positionals: "ignore" },
    which: { positionals: "ignore" },
    whereis: { positionals: "ignore" },
    type: { positionals: "ignore" },
    uname: { positionals: "none" },
    hostname: {
        positionals: "ignore",
        flags: { "-F": PATH_VALUE, "--file": PATH_VALUE },
    },
    nproc: { positionals: "none", flags: { "--ignore": VALUE } },
    free: { positionals: "none", flags: { "-c": VALUE } },
    id: { positionals: "none" },
    df: { flags: { "-B": VALUE, "--block-size": VALUE, "--output": VALUE } },
};
