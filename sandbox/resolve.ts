import { type SandboxConfigCwdConfinement, type SandboxConfigPermissions } from "../common/config";
import {
    getPermissionMatch,
    getArgsPermissionMatch,
    moreRestrictive,
    type Permission,
} from "./permissions";
import { parseBash } from "./bash";
import { getArgsConfinementPermission, splitAtChainOperators } from "./heuristics";

export interface ResolvePermissionOptions {
    permissions?: SandboxConfigPermissions;
    cwdConfinement?: SandboxConfigCwdConfinement | null;
}

type SegmentResult = {
    permission: Permission;
    /** where the permission came from */
    source: "policy" | "heuristic" | "unresolved";
};

/**
 * Resolve the effective permission for a command.
 *
 * The command is split into lines (parseBash) and each line into chain
 * segments (&&, ||, ;, |, &). Resolution rules:
 *
 * 1. A permission pattern matching a whole line (chain operators included)
 *    wins for that line.
 * 2. Otherwise each segment resolves independently: explicit pattern match,
 *    then the non-"ask" default ("**"), then — only when the segment would
 *    prompt — heuristics.
 * 3. Combination: "deny" dominates; then unresolved segments force "ask";
 *    then explicit/default ("policy") results combine most-restrictive.
 *    Heuristic grants only rescue segments that would prompt — they never
 *    downgrade policy results, so `cd /project && npx vitest | tail -5` with
 *    `"npx *": "allow"` resolves to "allow". A chain covered *only* by
 *    heuristics resolves to the heuristic permission ("allow:sandbox").
 */
export default function resolvePermission(
    command: string,
    cwd: string,
    options?: ResolvePermissionOptions,
): Permission {
    // empty command and unparsable input keep the whole-command behavior
    if (command === "" || command.trim() === "") {
        return getPermissionMatch(command, options?.permissions).permission;
    }

    let lines: string[][];
    try {
        lines = parseBash(command);
    } catch {
        return "ask";
    }

    if (lines.length === 0) {
        return getPermissionMatch(command, options?.permissions).permission;
    }

    let policy: Permission | null = null;
    let heuristic: Permission | null = null;
    let hasUnresolved = false;

    for (const line of lines) {
        const result = resolveLine(line, cwd, options);

        if (result.source === "policy") {
            policy = policy === null ? result.permission : moreRestrictive(policy, result.permission);
            if (policy === "deny") {
                return "deny";
            }
        } else if (result.source === "heuristic") {
            heuristic = heuristic === null ? result.permission : moreRestrictive(heuristic, result.permission);
        } else {
            hasUnresolved = true;
        }
    }

    if (hasUnresolved) {
        return "ask";
    }

    if (policy !== null) {
        return policy;
    }

    return heuristic ?? "ask";
}

function resolveLine(
    lineArgs: string[],
    cwd: string,
    options?: ResolvePermissionOptions,
): SegmentResult {
    // 1. whole-line match (chain-aware patterns work here)
    const whole = getArgsPermissionMatch(lineArgs, options?.permissions);
    if (whole.matched) {
        return { permission: whole.permission, source: "policy" };
    }

    // 2. per-segment resolution
    const segments = splitAtChainOperators(lineArgs);

    if (segments.length === 0) {
        return { permission: whole.permission, source: "policy" };
    }

    let policy: Permission | null = null;
    let heuristic: Permission | null = null;
    let hasUnresolved = false;

    for (const segment of segments) {
        const match = getArgsPermissionMatch(segment, options?.permissions);

        if (match.matched) {
            policy = policy === null ? match.permission : moreRestrictive(policy, match.permission);
            if (policy === "deny") {
                return { permission: "deny", source: "policy" };
            }
        } else if (match.permission !== "ask") {
            // non-"ask" default ("**") stands as-is
            policy = policy === null ? match.permission : moreRestrictive(policy, match.permission);
            if (policy === "deny") {
                return { permission: "deny", source: "policy" };
            }
        } else {
            // would prompt: heuristics may rescue the segment
            const grant = getArgsConfinementPermission(segment, cwd, options?.cwdConfinement);
            if (grant) {
                heuristic = heuristic === null ? grant : moreRestrictive(heuristic, grant);
            } else {
                hasUnresolved = true;
            }
        }
    }

    if (hasUnresolved) {
        return { permission: "ask", source: "unresolved" };
    }

    if (policy !== null) {
        return { permission: policy, source: "policy" };
    }

    return { permission: heuristic ?? "ask", source: heuristic ? "heuristic" : "unresolved" };
}
