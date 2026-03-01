import sandboxConfig, { SandboxConfigPermissions } from "../common/config";

type PermissionMatch = {
    wildcard: string;
    regex: RegExp;
    value: Permission;
};

export type Permission = "deny" | "ask" | "allow" | "allow:sandbox";

let permissions: PermissionMatch[] = [];

let config: SandboxConfigPermissions | null = null;

function wildcardToRegex(wildcard: string): RegExp {
    wildcard = wildcard.replaceAll("\\", "\\\\"); // Escape backslash FIRST
    wildcard = wildcard.replaceAll(".", "\\.");
    wildcard = wildcard.replaceAll("$", "\\$");
    wildcard = wildcard.replaceAll("^", "\\^");
    wildcard = wildcard.replaceAll("+", "\\+");
    wildcard = wildcard.replaceAll("?", "\\?");
    wildcard = wildcard.replaceAll("(", "\\(");
    wildcard = wildcard.replaceAll(")", "\\)");
    wildcard = wildcard.replaceAll("[", "\\[");
    wildcard = wildcard.replaceAll("]", "\\]");
    wildcard = wildcard.replaceAll("{", "\\{");
    wildcard = wildcard.replaceAll("}", "\\}");
    wildcard = wildcard.replaceAll("|", "\\|");
    wildcard = wildcard.replaceAll("*", ".*"); // zero-or-more (standard wildcard)

    return new RegExp("^" + wildcard + "$");
}

function getPermissions(
    configPermissions?: SandboxConfigPermissions,
): PermissionMatch[] {
    configPermissions = configPermissions ?? sandboxConfig.current?.permissions;

    if (config === configPermissions) {
        return permissions;
    }

    config = configPermissions ?? null;

    if (config === null) {
        return permissions;
    }

    let _permissions: PermissionMatch[] = [];

    try {
        for (const permission of Object.entries(config)) {
            _permissions.push({
                wildcard: permission[0],
                regex: wildcardToRegex(permission[0]),
                value: permission[1],
            });
        }
    } catch (e) {
        throw new Error(`Failed to parse permissions in config: ${e}`);
    }

    permissions = _permissions;
    return permissions;
}

export default function getPermission(
    command: string,
    configPermissions?: SandboxConfigPermissions,
): Permission {
    const permissions = getPermissions(configPermissions);

    let match: Permission = "ask";

    // note: this will match the last one (similar to opencode)
    //       could also try a specificity approach
    for (const permission of permissions) {
        if (!permission.regex.test(command)) {
            continue;
        }

        match = permission.value;
    }

    return match;
}
