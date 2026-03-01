import { lookpath } from "lookpath";

import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import type {
    ExtensionAPI,
    BashToolInput,
} from "@mariozechner/pi-coding-agent";

import sandboxConfig from "./common/config";
import sandbox from "./sandbox/bubblewrap";
import getPermission, { Permission } from "./sandbox/permissions";

// FIXME: use the import instead of this (where is it exported from though? ide complains of @mariozechner/pi-coding-agent/core/extensions)
interface ToolCallEventResult {
    block?: boolean;
    reason?: string;
}

export default function (pi: ExtensionAPI) {
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
              `pi-bash-sandbox: loaded config has ${Object.entries(config.mounts).length} mount(s) and ${Object.entries(config.permissions).length} permission(s).\n`,
              "info",
          );
        }
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
            const result = await ctx.ui.select(
                `Agent is trying to run: ${event.input.command}\n\nDo you allow this command?`,
                hasSupport ? ["Yes (sandbox)", "Yes", "No"] : ["Yes", "No"],
            );

            if (result === "Yes (sandbox)") {
                permission = "allow:sandbox";
            } else if (result === "Yes") {
                permission = "allow";
            } else if (result === "No") {
                permission = "deny";
            } else {
                permission = "deny";
            }
        }

        let blocked: boolean = true;
        let sandboxed: boolean = true;

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
            return {
                block: true,
                reason: "Command execution blocked by user.",
            };
        }

        if (sandboxed) {
            event.input.command = sandbox(bwrap, event.input.command);
        }

        return { block: false };
    });
}
