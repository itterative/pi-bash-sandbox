/**
 * Audit Command Extension
 *
 * Provides an /audit command that analyzes allowed commands and uses the current
 * model to suggest permission configurations.
 *
 * Usage:
 * 1. The bash tool automatically tracks commands that the user allows
 * 2. Use /bash-sandbox-audit to analyze patterns and get suggestions for your config
 * 3. Select which patterns to add, skipping existing ones
 */

import { complete } from "@mariozechner/pi-ai";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    Theme,
} from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";

import {
    AutocompleteItem,
    Container,
    Spacer,
    Text,
} from "@mariozechner/pi-tui";
import { multiSelect, type MultiSelectItem, type MultiSelectRenderOptions } from "../components/multi-select";
import { select, type PagerItem, type SelectRenderItemOptions } from "../components/select";
import fs from "node:fs";
import path from "node:path";
import {
    ALLOWED_COMMAND_ENTRY_TYPE,
    type AllowedCommandEntry,
} from "../common/audit";
import sandboxConfig, { type SandboxConfigPermissions } from "../common/config";
import { truncateLines } from "../common/text";
import getPermission from "../sandbox/permissions";
import { getModelCredentials } from "../common/credentials";

// Aggregated command data for analysis
interface AggregatedCommand {
    command: string;
    count: number;
    permissions: Set<"allow" | "allow:sandbox">;
    maxIndex: number; // highest entry index (most recent occurrence)
}

// Suggested pattern from model analysis
interface SuggestedPattern {
    pattern: string;
    permission: "allow" | "allow:sandbox" | "deny" | "ask";
    reason: string;
}

// Model analysis response
interface AuditAnalysis {
    patterns: SuggestedPattern[];
    summary: string;
}

// Instruction for the model to analyze patterns
const AUDIT_SYSTEM_INSTRUCTION = `You are a command pattern analyzer for a bash sandbox system. Your task is to analyze a list of bash commands that a user has allowed and suggest NEW permission patterns for their configuration file.

The permission system works as follows:
- Patterns use \`*\` as a wildcard to match zero or more characters within an argument
- When \`*\` appears as its own argument in the pattern, it matches one or more command arguments
- Patterns are matched on a last-match basis, so more specific patterns should come after general ones
- Permission levels: "allow", "allow:sandbox", "deny", "ask"

Output a JSON object with the following structure:
{
  "patterns": [
    {
      "pattern": "npm *",
      "permission": "allow",
      "reason": "Explanation of why this pattern is suggested"
    }
  ],
  "summary": "Brief summary of the analysis and recommendations"
}

Guidelines for generating patterns:
1. DO NOT suggest patterns that already exist in the user's current permissions
2. Group similar commands into patterns (e.g., multiple \`npm install X\` commands -> \`npm install *\`)
3. Be conservative - prefer "ask" or "allow:sandbox" for potentially dangerous operations
4. Consider common development workflows: some commands might be specific, but their patterns can be more general if they are safe
5. Suggest "deny" patterns for obviously dangerous commands if you see any
6. Keep patterns as general as is safe, but not overly broad
7. Order patterns from most general to most specific (since last-match wins)
8. Only output valid JSON - no markdown code blocks, no extra text

Analyze the commands and output ONLY the JSON object.`;

const AUDIT_USER_PROMPT = (
    commands: AggregatedCommand[],
    existingPermissions: SandboxConfigPermissions,
) => `Analyze these commands that the user has allowed during their session and suggest permission patterns:

## Current Permissions (DO NOT duplicate these)
${
    Object.entries(existingPermissions)
        .map(([pattern, perm]) => `- "${pattern}": "${perm}"`)
        .join("\n") || "(none)"
}

## Newly Allowed Commands
${commands
    .map((c) => {
        const perms = Array.from(c.permissions).join("/");
        return `- "${c.command}" (allowed ${c.count}x as ${perms})`;
    })
    .join("\n")}

Generate NEW permission patterns that are not already in the current permissions. Output only the JSON object.`;

// Get aggregated commands from session branch, limited to most used/recent
function getAggregatedCommands(
    ctx: ExtensionCommandContext,
): AggregatedCommand[] {
    const branchEntries = ctx.sessionManager.getEntries();
    const commandMap = new Map<string, AggregatedCommand>();

    // Use index as recency indicator since entries are in order
    for (let i = 0; i < branchEntries.length; i++) {
        const entry = branchEntries[i];
        if (
            entry.type !== "custom" ||
            entry.customType !== ALLOWED_COMMAND_ENTRY_TYPE
        ) {
            continue;
        }

        const data = entry.data as AllowedCommandEntry | undefined;
        if (!data?.command) continue;

        const existing = commandMap.get(data.command);
        if (existing) {
            existing.count++;
            // Keep the highest index (most recent)
            if (i > existing.maxIndex) {
                existing.maxIndex = i;
            }
        } else {
            commandMap.set(data.command, {
                command: data.command,
                count: 1,
                permissions: new Set([data.permission]),
                maxIndex: i,
            });
        }
    }

    // Sort by count (descending), then by recency (descending), and limit to 20
    const MAX_COMMANDS = 20;
    return Array.from(commandMap.values())
        .sort((a, b) => {
            // Primary sort: by count (most used first)
            if (b.count !== a.count) {
                return b.count - a.count;
            }
            // Secondary sort: by recency (most recent first)
            return b.maxIndex - a.maxIndex;
        })
        .slice(0, MAX_COMMANDS);
}

// Parse model response and extract JSON
function parseAnalysisResponse(responseText: string): AuditAnalysis | null {
    try {
        // Try to extract JSON from the response (in case there's extra text/markdown)
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return null;
        }

        const parsed = JSON.parse(jsonMatch[0]);

        if (typeof parsed !== "object") {
            return null;
        }

        if (!parsed.patterns || !Array.isArray(parsed.patterns)) {
            return null;
        }

        // Validate and normalize patterns
        const validPatterns: SuggestedPattern[] = [];
        for (const p of parsed.patterns) {
            if (
                typeof p.pattern !== "string" ||
                typeof p.permission !== "string"
            ) {
                continue;
            }
            // Normalize permission
            const perm = p.permission as string;
            if (
                perm !== "allow" &&
                perm !== "allow:sandbox" &&
                perm !== "deny" &&
                perm !== "ask"
            ) {
                continue;
            }
            validPatterns.push({
                pattern: p.pattern,
                permission: perm,
                reason: typeof p.reason === "string" ? p.reason : "",
            });
        }

        const summary = parsed.summary;

        return {
            patterns: validPatterns,
            summary:
                typeof summary === "string" ? summary : "Analysis complete",
        };
    } catch {
        return null;
    }
}

// Filter out patterns that already exist in config
function filterNewPatterns(
    patterns: SuggestedPattern[],
    existingPermissions: SandboxConfigPermissions,
): SuggestedPattern[] {
    return patterns.filter((p) => !(p.pattern in existingPermissions));
}

// Render a pattern item's content with permission-based coloring
function renderPatternItem(
    item: MultiSelectItem<SuggestedPattern>,
    options: MultiSelectRenderOptions<SuggestedPattern>,
): string {
    const pattern = item.value;
    const { isCursor, theme } = options;

    // Color based on permission
    let permDisplay: string;
    switch (pattern.permission) {
        case "allow":
            permDisplay = theme.fg("success", pattern.permission.padEnd(14));
            break;
        case "allow:sandbox":
            permDisplay = theme.fg("warning", pattern.permission.padEnd(14));
            break;
        case "deny":
            permDisplay = theme.fg("error", pattern.permission.padEnd(14));
            break;
        default:
            permDisplay = theme.fg("muted", pattern.permission.padEnd(14));
    }

    const patternText = isCursor
        ? theme.fg("accent", ` | ${pattern.pattern}`)
        : ` | ${pattern.pattern}`;

    return permDisplay + patternText;
}

// Show pattern selection UI and return selected patterns
async function selectPatternsUi(
    patterns: SuggestedPattern[],
    summary: string,
    existingPermissions: SandboxConfigPermissions,
    ctx: ExtensionCommandContext,
): Promise<SuggestedPattern[]> {
    if (!ctx.hasUI) {
        return [];
    }

    // Separate new vs existing patterns
    const newPatterns = filterNewPatterns(patterns, existingPermissions);
    const existingPatterns = patterns.filter(
        (p) => p.pattern in existingPermissions,
    );

    if (newPatterns.length === 0) {
        ctx.ui.notify(
            "pi-bash-sandbox: All suggested patterns already exist in your config.",
            "info",
        );
        return [];
    }

    // Convert patterns to multi-select items
    const items: MultiSelectItem<SuggestedPattern>[] = newPatterns.map((p) => ({
        value: p,
        label: `${p.permission.padEnd(14)} | ${p.pattern}`,
    }));

    // Build header content with summary, info and existing patterns
    const headerContent = (container: Container, theme: Theme) => {
        // Show analysis summary
        container.addChild(new Text(theme.fg("accent", `  ${summary}`), 1, 0));
        container.addChild(new Spacer(1));

        const newCount = newPatterns.length;
        const existingCount = existingPatterns.length;
        let info = `  ${newCount} new pattern(s)`;
        if (existingCount > 0) {
            info += ` (${existingCount} already in config)`;
        }
        container.addChild(new Text(theme.fg("dim", info), 1, 0));

        // Show existing patterns summary
        if (existingPatterns.length > 0) {
            container.addChild(new Spacer(1));
            container.addChild(
                new Text(theme.fg("dim", "  Already in config:"), 1, 0),
            );
            for (const p of existingPatterns.slice(0, 2)) {
                container.addChild(
                    new Text(
                        theme.fg(
                            "dim",
                            `    ${p.permission.padEnd(14)} | ${p.pattern}`,
                        ),
                        1,
                        0,
                    ),
                );
            }
            if (existingPatterns.length > 2) {
                container.addChild(
                    new Text(
                        theme.fg(
                            "dim",
                            `    ... and ${existingPatterns.length - 2} more`,
                        ),
                        1,
                        0,
                    ),
                );
            }
        }
    };

    return multiSelect(
        {
            title: "pi-bash-sandbox: Select which permission patterns you want to add",
            items,
            renderItem: renderPatternItem,
            headerContent,
        },
        ctx,
    );
}

// Save selected patterns to config
async function savePatternsToConfig(
    patterns: SuggestedPattern[],
    ctx: ExtensionCommandContext,
): Promise<boolean> {
    const configPath = path.join(ctx.cwd, ".pi", "bash-sandbox-config.json");

    // Load only the project-level config (not merged with global)
    let projectConfig: {
        sandbox: {
            mounts: Record<string, string>;
            env?: Record<string, string>;
            inheritEnv?: Record<string, string>;
        };
        permissions: SandboxConfigPermissions;
    } = {
        sandbox: { mounts: {} },
        permissions: {},
    };

    if (fs.existsSync(configPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            projectConfig = {
                sandbox: data.sandbox ?? { mounts: {} },
                permissions: data.permissions ?? {},
            };
        } catch {
            // Keep defaults if parse fails
        }
    }

    // Add new patterns to project permissions only
    for (const p of patterns) {
        projectConfig.permissions[p.pattern] = p.permission;
    }

    // Show preview
    const previewLines = patterns.map(
        (p) => `  "${p.pattern}": "${p.permission}"`,
    );
    const previewText = previewLines.join("\n");

    const confirmed = await ctx.ui.confirm(
        "pi-bash-sandbox: Confirm new permissions",
        `Add ${patterns.length} pattern(s) to ${configPath}?\n\n${previewText}`,
    );

    if (!confirmed) {
        ctx.ui.notify(
            "pi-bash-sandbox: Cancelled - no changes made to permissions",
            "info",
        );
        return false;
    }

    try {
        // Ensure directory exists
        const configDir = path.dirname(configPath);
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true, mode: 0o755 });
        }

        fs.writeFileSync(configPath, JSON.stringify(projectConfig, null, 2), {
            mode: 0o644,
        });

        // Reload the config so current reflects the changes
        sandboxConfig.load(ctx.cwd);

        ctx.ui.notify(
            `pi-bash-sandbox: Added ${patterns.length} pattern(s) to config.`,
            "info",
        );

        return true;
    } catch (e) {
        const error = e as Error;
        ctx.ui.notify(
            `pi-bash-sandbox: Failed to save config: ${error.message}`,
            "error",
        );
        return false;
    }
}

// The main audit command handler
async function runAudit(
    _args: string,
    ctx: ExtensionCommandContext,
    _pi: ExtensionAPI,
) {
    const commands = getAggregatedCommands(ctx);

    if (commands.length === 0) {
        ctx.ui.notify(
            "pi-bash-sandbox: No allowed commands tracked yet. Use the agent to run some commands first.",
            "info",
        );
        return;
    }

    // Get existing permissions
    const config = sandboxConfig.current ?? sandboxConfig.default;

    // Determine which model to use for audit
    let model = ctx.model;

    if (config.audit?.provider && config.audit?.model) {
        const configuredModel = ctx.modelRegistry.find(
            config.audit.provider,
            config.audit.model,
        );
        if (configuredModel) {
            model = configuredModel;
        } else {
            ctx.ui.notify(
                `pi-bash-sandbox: Configured audit model ${config.audit.provider}/${config.audit.model} not found, falling back to current model`,
                "warning",
            );
        }
    }

    if (!model) {
        ctx.ui.notify("No model selected", "error");
        return;
    }

    const modelCredentials = await getModelCredentials(ctx, model);

    // Filter out commands that already match existing permissions
    const unmatchedCommands = commands.filter((cmd) => {
        const permission = getPermission(cmd.command, config.permissions);
        // Only include commands that don't have an explicit allow/allow:sandbox/deny rule
        return permission === "ask";
    });

    if (unmatchedCommands.length === 0) {
        ctx.ui.notify(
            "pi-bash-sandbox: All tracked commands already match existing permission patterns.",
            "info",
        );
        return;
    }

    // Build the prompt with filtered commands and existing permissions
    const userPrompt = AUDIT_USER_PROMPT(unmatchedCommands, config.permissions);

    // Run analysis with loader UI
    const analysis = await ctx.ui.custom<{
        result: AuditAnalysis | null;
        error: string | null;
    } | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(
            tui,
            theme,
            "pi-bash-sandbox: Analyzing command patterns...",
        );
        loader.onAbort = () => done(null);

        const doAnalysis = async () => {
            try {
                const response = await complete(
                    model,
                    {
                        messages: [
                            {
                                role: "user",
                                content: [{ type: "text", text: userPrompt }],
                                timestamp: Date.now(),
                            },
                        ],
                        systemPrompt: AUDIT_SYSTEM_INSTRUCTION,
                    },
                    {
                        apiKey: modelCredentials.apiKey,
                        headers: modelCredentials.headers,
                        signal: loader.signal
                    },
                );

                if (response.stopReason === "aborted") {
                    return null;
                }

                // Extract the response text
                const responseText = response.content
                    .filter(
                        (c): c is { type: "text"; text: string } =>
                            c.type === "text",
                    )
                    .map((c) => c.text)
                    .join("\n");

                return {
                    result: parseAnalysisResponse(responseText),
                    error: null,
                };
            } catch (err) {
                const error = err as Error;
                return { result: null, error: error.message };
            }
        };

        doAnalysis().then(done);
        return loader;
    });

    if (analysis === null) {
        ctx.ui.notify("pi-bash-sandbox: Analysis cancelled", "info");
        return;
    }

    if (analysis.error) {
        ctx.ui.notify(
            `pi-bash-sandbox: Audit analysis failed: ${analysis.error}`,
            "error",
        );
        return;
    }

    if (!analysis.result) {
        ctx.ui.notify(
            "pi-bash-sandbox: Analysis returned no result",
            "warning",
        );
        return;
    }

    if (analysis.result.patterns.length === 0) {
        ctx.ui.notify(
            "pi-bash-sandbox: No new patterns suggested by the model (may already exist in config).",
            "info",
        );
        return;
    }

    // Show selection UI
    const selectedPatterns = await selectPatternsUi(
        analysis.result.patterns,
        analysis.result.summary,
        config.permissions,
        ctx,
    );

    if (selectedPatterns.length === 0) {
        ctx.ui.notify("pi-bash-sandbox: No patterns selected.", "info");
        return;
    }

    // Save to config
    await savePatternsToConfig(selectedPatterns, ctx);
}

// List tracked commands
async function listAudit(_args: string, ctx: ExtensionCommandContext) {
    const commands = getAggregatedCommands(ctx);

    if (commands.length === 0) {
        ctx.ui.notify("pi-bash-sandbox: No commands tracked", "info");
        return;
    }

    const MAX_LINE_LENGTH = 80;
    const MAX_LINES = 3;

    // Build pager items
    const items: PagerItem<AggregatedCommand>[] = commands.map((c) => ({
        value: c,
        label: c.command,
    }));

    // Custom render function for select items
    const renderItem = (
        item: PagerItem<AggregatedCommand>,
        options: SelectRenderItemOptions<AggregatedCommand>,
    ): string => {
        const { isCursor, theme } = options;
        const c = item.value;
        const perms = Array.from(c.permissions).join("/");
        const prefix = `(${c.count}x) `;
        const suffix = ` [${perms}]`;

        // Truncate command to fit limits
        const truncated = truncateLines(c.command, {
            maxLines: MAX_LINES,
            maxLineLength: MAX_LINE_LENGTH,
            firstLineLengthReduction: prefix.length + suffix.length,
        });

        // Build lines with prefix and suffix on first line
        const lines = truncated.split("\n");
        const firstLine = prefix + lines[0] + suffix;
        const continuationIndent = " ".repeat(prefix.length);
        const allLines = [firstLine, ...lines.slice(1).map((l) => continuationIndent + l)];

        // Apply highlight to each line if cursor (ANSI codes need per-line application)
        if (isCursor) {
            return allLines.map((l) => theme.fg("accent", l)).join("\n");
        }
        return allLines.join("\n");
    };

    await select(
        {
            title: "pi-bash-sandbox: Recent commands",
            items,
            maxVisible: 10,
            renderItem,
            helpText: "↑/↓ navigate | Enter/Esc close",
        },
        ctx,
    );
}

export default function registerAuditCommand(pi: ExtensionAPI) {
    const auditSubcommands: AutocompleteItem[] = [
        {
            value: "analyze",
            label: "analyze (default)",
            description:
                "Analyze the recent commands using the model and get recommendations for your local permissions",
        },
        {
            value: "list",
            label: "list",
            description: "List recent commands the model asked for permission",
        },
    ];

    pi.registerCommand("bash-sandbox-audit", {
        description: "Analyze allowed commands and suggest permission patterns",
        getArgumentCompletions: (prefix: string) => {
            const completions: AutocompleteItem[] = [];

            for (const subcommand of auditSubcommands) {
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
                case "list":
                    await listAudit(args.slice(4).trim(), ctx);
                    break;

                case "analyze":
                case "":
                    await runAudit(args, ctx, pi);
                    break;

                default:
                    ctx.ui.notify(
                        `pi-bash-sandbox: Unknown subcommand: ${args}.`,
                        "warning",
                    );
                    return;
            }
        },
    });
}
