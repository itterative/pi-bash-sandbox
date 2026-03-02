/**
 * Config Command Extension
 *
 * Provides a /bash-sandbox-config command that displays the currently loaded
 * sandbox configuration.
 *
 * Subcommands:
 * - show (default): Display the current configuration
 * - reload: Reload the configuration from disk
 */

import {
    DynamicBorder,
    ThemeColor,
    type ExtensionAPI,
    type ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import {
    AutocompleteItem,
    Container,
    Spacer,
    Text,
} from "@mariozechner/pi-tui";

import sandboxConfig from "../common/config";

async function showConfig(_args: string, ctx: ExtensionCommandContext) {
    const config = sandboxConfig.current;

    if (!config) {
        ctx.ui.notify(
            "pi-bash-sandbox: No config loaded (using defaults)",
            "info",
        );
        return;
    }

    if (!ctx.hasUI) {
        // Non-UI mode: just print the config
        ctx.ui.notify(
            `pi-bash-sandbox config:\n${JSON.stringify(config, null, 2)}`,
            "info",
        );
        return;
    }

    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const container = new Container();
        const borderColor = (s: string) => theme.fg("border", s);

        container.addChild(new DynamicBorder(borderColor));

        // Header
        container.addChild(
            new Text(
                theme.fg(
                    "accent",
                    theme.bold("  pi-bash-sandbox: Current configuration"),
                ),
                1,
                0,
            ),
        );
        container.addChild(new Spacer(1));

        // Sandbox section
        container.addChild(new Text(theme.fg("success", "  Sandbox:"), 1, 0));

        // Mounts
        const mounts = Object.entries(config.sandbox.mounts);
        if (mounts.length > 0) {
            container.addChild(new Text(theme.fg("dim", "    Mounts:"), 1, 0));
            for (const [path, access] of mounts) {
                const accessColor =
                    access === "readonly" ? "warning" : "success";
                container.addChild(
                    new Text(
                        `      ${path} → ${theme.fg(accessColor, access)}`,
                        1,
                        0,
                    ),
                );
            }
        } else {
            container.addChild(
                new Text(theme.fg("dim", "    (no mounts)"), 1, 0),
            );
        }

        // Env vars
        if (config.sandbox.env && Object.keys(config.sandbox.env).length > 0) {
            container.addChild(
                new Text(theme.fg("dim", "    Environment:"), 1, 0),
            );
            for (const [key, value] of Object.entries(config.sandbox.env)) {
                container.addChild(
                    new Text(`      ${key}=${theme.fg("muted", value)}`, 1, 0),
                );
            }
        }

        // Inherit env filter
        if (
            config.sandbox.inheritEnv &&
            Object.keys(config.sandbox.inheritEnv).length > 0
        ) {
            container.addChild(
                new Text(theme.fg("dim", "    Inherit env filter:"), 1, 0),
            );
            for (const [key, action] of Object.entries(
                config.sandbox.inheritEnv,
            )) {
                const actionColor = action === "allow" ? "success" : "error";
                container.addChild(
                    new Text(
                        `      ${key} → ${theme.fg(actionColor, action)}`,
                        1,
                        0,
                    ),
                );
            }
        }

        container.addChild(new Spacer(1));

        // Permissions section
        container.addChild(
            new Text(theme.fg("success", "  Permissions:"), 1, 0),
        );

        const permissions = Object.entries(config.permissions);
        if (permissions.length > 0) {
            const maxPatternLength = Math.max(
                ...permissions.map(([p]) => p.length),
            );

            for (const [pattern, perm] of permissions) {
                let permColor: ThemeColor;
                switch (perm) {
                    case "allow":
                        permColor = "success";
                        break;
                    case "allow:sandbox":
                        permColor = "warning";
                        break;
                    case "deny":
                        permColor = "error";
                        break;
                    default:
                        permColor = "muted";
                }
                container.addChild(
                    new Text(
                        `    ${pattern.padEnd(maxPatternLength)} ${theme.fg(permColor, perm)}`,
                        1,
                        0,
                    ),
                );
            }
        } else {
            container.addChild(
                new Text(theme.fg("dim", "    (no permissions defined)"), 1, 0),
            );
        }

        // Audit section
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("success", "  Audit:"), 1, 0));

        if (config.audit?.provider && config.audit?.model) {
            container.addChild(
                new Text(
                    `    Model: ${theme.fg("accent", `${config.audit.provider}/${config.audit.model}`)}`,
                    1,
                    0,
                ),
            );
        } else {
            container.addChild(
                new Text(
                    theme.fg(
                        "dim",
                        "    Model: (using current session model): ",
                    ),
                    1,
                    0,
                ),
            );
        }

        container.addChild(new Spacer(1));
        container.addChild(
            new Text(theme.fg("muted", "  Press any key to close"), 1, 0),
        );
        container.addChild(new DynamicBorder(borderColor));

        const handleInput = (_data: string) => {
            done();
        };

        return {
            render: (_width: number) => container.render(_width),
            invalidate: () => {},
            handleInput,
        };
    });
}

export default function registerConfigCommand(pi: ExtensionAPI) {
    const configSubcommands: AutocompleteItem[] = [
        {
            value: "show",
            label: "show (default)",
            description: "Display the currently loaded sandbox configuration",
        },
        {
            value: "reload",
            label: "reload",
            description: "Reload the configuration from disk",
        },
    ];

    pi.registerCommand("bash-sandbox-config", {
        description: "Show the currently loaded sandbox configuration",
        getArgumentCompletions: (prefix: string) => {
            const completions: AutocompleteItem[] = [];

            for (const subcommand of configSubcommands) {
                if (prefix && !subcommand.value.startsWith(prefix)) {
                    continue;
                }

                completions.push(subcommand);
            }

            return completions;
        },
        handler: async (args, ctx) => {
            const subcommand = args.trim();

            switch (subcommand) {
                case "reload":
                    try {
                        sandboxConfig.load(ctx.cwd);
                        ctx.ui.notify(
                            "pi-bash-sandbox: Configuration reloaded from disk",
                            "info",
                        );
                    } catch (e) {
                        const error = e as Error;
                        ctx.ui.notify(
                            `pi-bash-sandbox: Failed to reload config: ${error.message}`,
                            "error",
                        );
                    }
                    break;

                case "show":
                case "":
                    await showConfig(args, ctx);
                    break;

                default:
                    ctx.ui.notify(
                        `pi-bash-sandbox: Unknown subcommand: ${args}.`,
                        "warning",
                    );
            }
        },
    });
}
