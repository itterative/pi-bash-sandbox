import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import registerBashToolHook from "./tools/bash";
import registerAuditCommand from "./commands/audit";

export default function (pi: ExtensionAPI) {
    registerAuditCommand(pi);
    registerBashToolHook(pi);
}
