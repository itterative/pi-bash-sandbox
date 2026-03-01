import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import registerBashToolHook from "./tools/bash";

export default function (pi: ExtensionAPI) {
    registerBashToolHook(pi);
}
