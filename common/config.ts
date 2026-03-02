import fs from "node:fs";
import path from "node:path";

import { SANDBOX_CONFIG_PATH, SANDBOX_CONFIG_PATH_GLOBAL } from "./constants";

function getGlobalConfigPath(): string | undefined {
    return process.env.SANDBOX_CONFIG_PATH_GLOBAL ?? SANDBOX_CONFIG_PATH_GLOBAL;
}

export type SandboxConfigMounts = Record<string, "readonly" | "readwrite">;
export type SandboxConfigPermissions = Record<string, "deny" | "ask" | "allow" | "allow:sandbox">;
export type SandboxConfigEnvFilter = Record<string, "allow" | "deny">;

export interface SandboxConfigAudit {
    provider?: string;
    model?: string;
}

export interface SandboxConfig {
    sandbox: {
        mounts: SandboxConfigMounts;
        env?: Record<string, string>;  // custom env vars
        inheritEnv?: SandboxConfigEnvFilter;  // filter for existing env vars
    };
    permissions: SandboxConfigPermissions;
    audit?: SandboxConfigAudit;
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
            audit: data.audit ? {
                provider: data.audit.provider,
                model: data.audit.model,
            } : undefined,
        } as SandboxConfig;
    } catch (e) {
        return null;
    }
}

function mergeRecords<K extends string, V>(
    base: Record<K, V> | undefined,
    override: Record<K, V> | undefined
): Record<K, V> | undefined {
    let hasRecords = false;
    const map = new Map<K, V>();

    // Add base entries first
    if (base !== undefined) {
        hasRecords = true;

        for (const [key, value] of Object.entries(base) as [K, V][]) {
            map.set(key, value);
        }
    }

    // Add override entries - delete first if exists to ensure it moves to end
    if (override !== undefined) {
        hasRecords = true;

        for (const [key, value] of Object.entries(override) as [K, V][]) {
            map.delete(key);  // Remove if exists so re-insert places it at end
            map.set(key, value);
        }
    }

    if (!hasRecords) {
        return undefined;
    }

    return Object.fromEntries(map) as Record<K, V>;
}

function mergeRecordsOrDefault<K extends string, V>(
    base: Record<K, V> | undefined,
    override: Record<K, V> | undefined,
    _default: Record<K, V>
): Record<K, V> {
    const merged = mergeRecords(base, override);

    if (merged === undefined) {
        return _default;
    }

    return merged;
}

function mergeConfigs(global: SandboxConfig | null, project: SandboxConfig | null): SandboxConfig {
    const base = global ?? defaultConfig();

    if (!project) {
        return base;
    }

    return {
        sandbox: {
            mounts: mergeRecordsOrDefault(base.sandbox.mounts, project.sandbox.mounts, {}),
            env: mergeRecords(base.sandbox.env, project.sandbox.env),
            inheritEnv: mergeRecords(base.sandbox.inheritEnv, project.sandbox.inheritEnv),
        },
        permissions: mergeRecordsOrDefault(base.permissions, project.permissions, {}),
        audit: project.audit ?? base.audit,
    };
}

function findConfigLocations(cwd: string): { global: string | null; project: string | null } {
    let projectConfig: string | null = null;

    // Check for project config in directory tree
    let currentFolder = cwd;
    for (let i = 0; i < 20; i++) {
        if (!currentFolder) {
            break;
        }

        const configPath = path.join(currentFolder, ".pi", "bash-sandbox-config.json");

        if (fs.existsSync(configPath)) {
            projectConfig = configPath;
            break;
        }

        const parentFolder = path.dirname(currentFolder);

        if (parentFolder === currentFolder) {
            break;
        }

        currentFolder = parentFolder;
    }

    // Also check SANDBOX_CONFIG_PATH as fallback project config
    if (!projectConfig && SANDBOX_CONFIG_PATH) {
        projectConfig = SANDBOX_CONFIG_PATH;
    }

    return {
        global: getGlobalConfigPath() ?? null,
        project: projectConfig,
    };
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
            const globalConfig = locations.global ? tryLoad(locations.global) : null;
            const projectConfig = locations.project ? tryLoad(locations.project) : null;

            if (!globalConfig && !projectConfig) {
                return null;
            }

            _config = mergeConfigs(globalConfig, projectConfig);
        }

        return _config ?? defaultConfig();
    },

    load(cwd: string) {
        const locations = findConfigLocations(cwd);
        const globalConfig = locations.global ? tryLoad(locations.global) : null;
        const projectConfig = locations.project ? tryLoad(locations.project) : null;

        if (!globalConfig && !projectConfig) {
            throw new Error("could not load sandbox config");
        }

        _config = mergeConfigs(globalConfig, projectConfig);
        return _config;
    },

    save(config: Partial<SandboxConfig>, cwd?: string) {
        cwd = cwd ?? process.cwd();
        const locations = findConfigLocations(cwd);

        const config_path = locations.project ?? locations.global ?? SANDBOX_CONFIG_PATH ?? getGlobalConfigPath();

        if (!config_path) {
            throw new Error("no config path available for saving");
        }

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
