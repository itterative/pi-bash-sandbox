import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerBashToolHook from "./tools/bash";
import registerAuditCommand from "./commands/audit";
import registerConfigCommand from "./commands/config";

export default function (pi: ExtensionAPI) {
    registerAuditCommand(pi);
    registerConfigCommand(pi);
    registerBashToolHook(pi);
}
