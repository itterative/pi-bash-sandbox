import fs from "node:fs";
import path from "node:path";

import { SANDBOX_CONFIG_PATH, SANDBOX_CONFIG_PATH_GLOBAL } from "./constants";

export type SandboxConfigMounts = Record<string, "readonly" | "readwrite">;
export type SandboxConfigPermissions = Record<string, "deny" | "ask" | "allow" | "allow:sandbox">;
export type SandboxConfigEnvFilter = Record<string, "allow" | "deny">;

export interface SandboxConfig {
    sandbox: {
        mounts: SandboxConfigMounts;
        env?: Record<string, string>;  // custom env vars
        inheritEnv?: SandboxConfigEnvFilter;  // filter for existing env vars
    };
    permissions: SandboxConfigPermissions;
}

function tryLoad(path: string): SandboxConfig | null {
    if (!fs.existsSync(path)) {
        return null;
    }

    try {
        const data = JSON.parse(fs.readFileSync(path, "utf-8"));

        if (!data || typeof data !== "object") {
            return null;
        }

        return {
            sandbox: {
                mounts: data.sandbox?.mounts ?? {},
                env: data.sandbox?.env,
                inheritEnv: data.sandbox?.inheritEnv,
            },
            permissions: data.permissions ?? {},
        } as SandboxConfig;
    } catch (e) {
        return null;
    }
}

function findConfigLocations(cwd: string): string[] {
    const locations: string[] = [];

    let currentFolder = cwd;

    if (SANDBOX_CONFIG_PATH) {
        locations.push(SANDBOX_CONFIG_PATH);
    }

    for (let i = 0; i < 20; i++) {
        if (!currentFolder) {
            break;
        }

        const configPath = path.join(cwd, ".pi", "bash-sandbox-config.json");

        try {
            fs.accessSync(configPath, fs.constants.R_OK);

            if (fs.existsSync(configPath)) {
                locations.push(configPath);
            }
        } catch (e) {
            break;
        }

        const parentFolder = path.join(cwd, "..");

        if (parentFolder === currentFolder) {
            break;
        }

        currentFolder = parentFolder;
    }

    locations.push(SANDBOX_CONFIG_PATH_GLOBAL);

    return locations;
}

let _config: SandboxConfig | null = null;

function defaultConfig(): SandboxConfig {
  return {
      sandbox: {
          mounts: {},
          env: {},
          inheritEnv: {},
      },
      permissions: {},
  }
}

export default {
    get default(): SandboxConfig {
        return defaultConfig();
    },

    get current(): SandboxConfig | null {
        if (_config === null) {
            const locations = findConfigLocations(process.cwd());

            if (locations.length === 0) {
                return null;
            }

            _config = tryLoad(locations[0]);
        }

        return _config ?? defaultConfig();
    },

    load(cwd: string) {
        const locations = findConfigLocations(cwd);

        let config: SandboxConfig | null = null;
        if (locations.length > 0) {
            config = tryLoad(locations[0]);
        }

        if (config === null) {
            throw new Error("could not load sandbox config");
        }

        _config = config;
        return _config;
    },

    save(config: Partial<SandboxConfig>, cwd?: string) {
        cwd = cwd ?? process.cwd();
        const locations = findConfigLocations(cwd);

        const config_path = locations[0] ?? SANDBOX_CONFIG_PATH ?? SANDBOX_CONFIG_PATH_GLOBAL;

        if (!fs.existsSync(config_path)) {
            fs.mkdirSync(path.dirname(config_path), {
                recursive: true,
                mode: 0o640,
            });
        }

        let newConfig: SandboxConfig = _config ?? defaultConfig();
        newConfig = Object.assign(newConfig, config);

        fs.writeFileSync(config_path, JSON.stringify(newConfig), {
            mode: 0o600,
        });

        _config = newConfig;
        return _config;
    },
};
