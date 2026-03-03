/**
 * Text utilities for formatting and truncating multi-line text.
 */

import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// Options for indenting lines
export interface IndentLinesOptions {
    // Prefix for the first line
    firstLinePrefix: string;
    // Prefix for continuation lines (default: same as firstLinePrefix)
    continuationPrefix?: string;
}

// Indent multi-line text with different prefixes for first and continuation lines
export function indentLines(text: string, options: IndentLinesOptions): string {
    const { firstLinePrefix, continuationPrefix = firstLinePrefix } = options;
    const lines = text.split("\n");

    if (lines.length === 0) {
        return firstLinePrefix;
    }

    if (lines.length === 1) {
        return firstLinePrefix + lines[0];
    }

    return (
        firstLinePrefix +
        lines[0] +
        "\n" +
        lines
            .slice(1)
            .map((line) => continuationPrefix + line)
            .join("\n")
    );
}

// Options for truncating lines
export interface TruncateLinesOptions {
    // Maximum number of lines to keep (default: no limit)
    maxLines?: number;
    // Maximum length of each line (default: no limit)
    maxLineLength?: number;
    // Extra characters to account for on first line (e.g., prefix/suffix length)
    firstLineLengthReduction?: number;
    // String to append when line is truncated (default: "...")
    truncationSuffix?: string;
}

// Truncate multi-line text to fit within line/length limits
// Uses ANSI-aware width calculation and truncation
export function truncateLines(text: string, options: TruncateLinesOptions = {}): string {
    const {
        maxLines,
        maxLineLength,
        firstLineLengthReduction = 0,
        truncationSuffix = "...",
    } = options;

    const lines = text.split("\n");
    const result: string[] = [];

    const limit = maxLines ?? lines.length;

    for (let i = 0; i < Math.min(lines.length, limit); i++) {
        let line = lines[i];
        if (!line) continue;

        // First line may have less available space due to prefix/suffix
        const maxLen = i === 0
            ? (maxLineLength ?? Infinity) - firstLineLengthReduction
            : maxLineLength ?? Infinity;

        if (maxLen !== Infinity && visibleWidth(line) > maxLen) {
            line = truncateToWidth(line, maxLen, truncationSuffix);
        }
        result.push(line);
    }

    // Add indicator if lines were truncated
    if (maxLines !== undefined && lines.length > maxLines) {
        result.push(`... (${lines.length - maxLines} more lines)`);
    }

    return result.join("\n");
}
