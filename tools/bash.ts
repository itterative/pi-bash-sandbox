import { lookpath } from "lookpath";

import { isToolCallEventType, isBashToolResult } from "@mariozechner/pi-coding-agent";
import type {
    ExtensionAPI,
    BashToolInput,
} from "@mariozechner/pi-coding-agent";

import sandboxConfig from "../common/config";
import { ALLOWED_COMMAND_ENTRY_TYPE, type AllowedCommandEntry } from "../common/audit";
import sandbox from "../sandbox/bubblewrap";
import getPermission, { Permission } from "../sandbox/permissions";
import { selectWithMessage, type SelectMessageItem } from "../components/select-with-message";

// FIXME: use the import instead of this (where is it exported from though? ide complains of @mariozechner/pi-coding-agent/core/extensions)
interface ToolCallEventResult {
    block?: boolean;
    reason?: string;
}

export default function registerBashToolHook(pi: ExtensionAPI) {
    let hasSupport =
        process.platform === "linux" || process.platform === "freebsd";

    let bwrap: string = "";

    pi.on("session_start", async (event, ctx) => {
        if (!hasSupport) {
            ctx.ui.notify(
                `pi-bash-sandbox: platform ${process.platform} is not supported\n`,
                "warning",
            );

            return;
        }

        bwrap = (await lookpath("bwrap")) ?? "";

        if (bwrap.length === 0) {
            hasSupport = false;

            ctx.ui.notify(
                "pi-bash-sandbox: bubblewrap package is required for linux sandboxing\n",
                "warning",
            );

            return;
        }

        const config = sandboxConfig.load(ctx.cwd);

        if (config !== null) {
          ctx.ui.notify(
              `pi-bash-sandbox: loaded config has ${Object.entries(config.sandbox.mounts).length} mount(s) and ${Object.entries(config.permissions).length} permission(s).\n`,
              "info",
          );
        }
    });

    // Add system prompt instructions about user notes
    pi.on("before_agent_start", async (event) => {
        const notes = `## Bash Sandbox User Notes

When requesting to run bash commands, the user may attach a note explaining their decision. These notes appear:
- For blocked commands: in the block reason
- For allowed commands: inside \`<user_note>\` tags at the start of the command output

Pay attention to these notes as they provide context about the user's preferences and concerns.
`;

        if (event.systemPromptOptions) {
            return {
                message: {
                    customType: "pi-bash-sandbox",
                    content: notes,
                    display: false,
                },
            };
        }

        return {
            systemPrompt: event.systemPrompt + "\n\n" + notes,
        };
    });

    if (!hasSupport) {
        return;
    }

    pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult> => {
        if (!isToolCallEventType<"bash", BashToolInput>("bash", event)) {
            return { block: false };
        }

        let permission: Permission = "ask";
        try {
            permission = getPermission(event.input.command);
        } catch (e) {
            ctx.ui.notify(`pi-bash-sandbox: ${e}`, "warning");
        }

        if (permission === "ask") {
            const items: SelectMessageItem<Permission>[] = hasSupport
                ? [
                    { value: "allow:sandbox", label: "Yes (sandbox)", placeholder: "e.g., trusted build tool" },
                    { value: "allow", label: "Yes", placeholder: "e.g., I've reviewed this command" },
                    { value: "deny", label: "No", placeholder: "e.g., too risky" },
                ]
                : [
                    { value: "allow", label: "Yes", placeholder: "e.g., I've reviewed this command" },
                    { value: "deny", label: "No", placeholder: "e.g., too risky" },
                ];

            const result = await selectWithMessage(
                {
                    title: "pi-bash-sandbox: Agent is trying to run a command. Do you want to allow?",
                    contentLines: event.input.command.split("\n"),
                    items,
                },
                ctx,
            );

            if (result) {
                permission = result.value;
                // Attach message to input for retrieval in tool_result
                if (result.message) {
                    (event.input as any)._userMessage = result.message;
                }
            } else {
                permission = "deny";
            }
        }

        let blocked: boolean = true;
        let sandboxed: boolean = true;
        const originalCommand = event.input.command;  // Save before sandbox wrapping

        switch (permission) {
            case "allow:sandbox":
                if (!hasSupport || bwrap.length === 0) {
                    return {
                        block: true,
                        reason: "Command execution blocked due to lack of sandboxing. If this is the first execution, you can ask the user to run the command without sandboxing and try again.",
                    };
                }

                blocked = false;
                sandboxed = true;

                break;

            case "allow":
                blocked = false;
                sandboxed = false;
                break;

            case "deny":
                blocked = true;
                break;

            default:
                blocked = true;
                ctx.ui.notify(
                    `pi-bash-sandbox: Received bad action for command: ${permission}`,
                    "warning",
                );
                break;
        }

        if (blocked) {
            const userMessage = (event.input as any)._userMessage;
            const baseReason = "Command execution blocked by user.";
            const reason = userMessage ? `${baseReason} User message: ${userMessage}` : baseReason;
            return {
                block: true,
                reason,
            };
        }

        // Track allowed command for audit
        const userMessage = (event.input as any)._userMessage;
        pi.appendEntry<AllowedCommandEntry>(ALLOWED_COMMAND_ENTRY_TYPE, {
            command: originalCommand,
            permission: sandboxed ? "allow:sandbox" : "allow",
            ...(userMessage && { userMessage }),
        });

        if (sandboxed) {
            event.input.command = sandbox(bwrap, event.input.command);
        }

        return { block: false };
    });

    // Add user message to tool result for allowed commands
    pi.on("tool_result", async (event, ctx) => {
        if (!isBashToolResult(event)) return;

        const userMessage = (event.input as any)._userMessage;
        if (!userMessage) return;

        // Prepend user message to the result content
        const trimmed = userMessage.trim();
        const hasNewlines = trimmed.includes("\n");
        const note = hasNewlines
            ? `<user_note>\nThe user has made a note: ${trimmed}\n</user_note>\n`
            : `<user_note>The user has made a note: ${trimmed}</user_note>\n`;
        return {
            content: [
                { type: "text", text: note },
                ...event.content,
            ],
        };
    });
}
