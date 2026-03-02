/**
 * Pager Component
 *
 * A pager UI component for viewing a list of items with cursor navigation.
 */

import type { ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
    Container,
    matchesKey,
    Spacer,
    Text,
} from "@mariozechner/pi-tui";
import { indentLines } from "../common/text";

// An item in the pager
export interface PagerItem<T> {
    value: T;
    label: string;
    disabled?: boolean;
}

// Options passed to renderItem callback
export interface RenderItemOptions<T> {
    index: number;
    isCursor: boolean;
    theme: Theme;
    state: PagerState<T>;
}

// Options for the pager component
export interface PagerOptions<T> {
    // Title shown at the top
    title: string;
    // Items to display
    items: PagerItem<T>[];
    // Maximum visible lines before scrolling
    maxVisibleLines?: number;
    // Custom render function for item content (cursor marker is added automatically)
    renderItem?: (item: PagerItem<T>, options: RenderItemOptions<T>) => string;
    // Optional header content rendered after title
    headerContent?: (container: Container, theme: Theme) => void;
    // Optional footer content rendered before help text
    footerContent?: (container: Container, theme: Theme, state: PagerState<T>) => void;
    // Custom help text (defaults to standard navigation help)
    helpText?: string;
    // Hook to intercept keys before pager handles them. Return true to indicate key was handled.
    onKey?: (key: string, state: PagerState<T>) => boolean;
}

// Internal state for the pager
export interface PagerState<T> {
    items: PagerItem<T>[];
    cursor: number;
    maxVisibleLines: number;
}

// Default render for an item's content (just the label)
function defaultRenderItem<T>(
    item: PagerItem<T>,
    options: RenderItemOptions<T>,
): string {
    if (options.isCursor) {
        return options.theme.fg("accent", item.label);
    }
    return item.label;
}

// Show pager UI and return when closed
export async function pager<T>(
    options: PagerOptions<T>,
    ctx: ExtensionCommandContext,
): Promise<void> {
    if (!ctx.hasUI) {
        return;
    }

    if (options.items.length === 0) {
        return;
    }

    const maxVisibleLines = options.maxVisibleLines ?? 10;
    const renderItem = options.renderItem ?? defaultRenderItem;
    const helpText = options.helpText ?? "↑/↓ navigate | Enter/Esc close";

    // State for the pager - only track cursor, scroll is derived in render
    const state: PagerState<T> = {
        items: options.items,
        cursor: 0,
        maxVisibleLines,
    };

    await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) => {
            const container = new Container();
            const borderColor = (s: string) => theme.fg("border", s);

            container.addChild(new DynamicBorder(borderColor));

            // Header
            container.addChild(
                new Text(
                    theme.fg("accent", theme.bold(`  ${options.title}`)),
                    1,
                    0,
                ),
            );
            container.addChild(new Spacer(1));

            // Custom header content if provided
            if (options.headerContent) {
                options.headerContent(container, theme);
                container.addChild(new Spacer(1));
            }

            // Dynamic content container for item list and status
            const contentContainer = new Container();
            container.addChild(contentContainer);

            container.addChild(new Spacer(1));
            container.addChild(new DynamicBorder(borderColor));

            const updateContent = () => {
                contentContainer.clear();

                // Render all items to in-memory lines
                const allLines: string[] = [];
                const itemStartIndices: number[] = []; // Track where each item starts in allLines

                for (let i = 0; i < state.items.length; i++) {
                    itemStartIndices.push(allLines.length);
                    const item = state.items[i];
                    if (!item) continue;
                    const isCursor = i === state.cursor;

                    const renderOptions: RenderItemOptions<T> = {
                        index: i,
                        isCursor,
                        theme,
                        state,
                    };
                    const content = renderItem(item, renderOptions);

                    const cursorMarker = isCursor ? "→ " : "  ";
                    const prefix = isCursor
                        ? theme.fg("accent", cursorMarker)
                        : cursorMarker;

                    const indented = indentLines(content, {
                        firstLinePrefix: prefix,
                        continuationPrefix: "  ",
                    });
                    allLines.push(...indented.split("\n"));
                }

                const totalLines = allLines.length;

                // Determine which lines to show based on cursor
                const cursorStartLine = itemStartIndices[state.cursor] ?? 0;
                const linesAfterCursor = totalLines - cursorStartLine;

                let startLine: number;
                if (linesAfterCursor <= state.maxVisibleLines) {
                    // Not enough lines after cursor - backfill from end
                    startLine = Math.max(0, totalLines - state.maxVisibleLines);
                } else {
                    startLine = cursorStartLine;
                }

                const visibleLines = allLines.slice(startLine, startLine + state.maxVisibleLines);

                // Render visible lines
                for (const line of visibleLines) {
                    contentContainer.addChild(new Text(line, 1, 0));
                }

                // Scroll indicator
                if (totalLines > state.maxVisibleLines) {
                    const endLine = startLine + visibleLines.length;
                    const showing = `  Showing lines ${startLine + 1}-${endLine} of ${totalLines}`;
                    contentContainer.addChild(new Spacer(1));
                    contentContainer.addChild(
                        new Text(theme.fg("dim", showing), 1, 0),
                    );
                }

                // Custom footer content if provided
                if (options.footerContent) {
                    options.footerContent(contentContainer, theme, state);
                }

                contentContainer.addChild(new Spacer(1));

                // Help text
                contentContainer.addChild(
                    new Text(theme.fg("muted", `  ${helpText}`), 1, 0),
                );
            };

            const handleInput = (data: string) => {
                // Allow external key handler to intercept first
                if (options.onKey?.(data, state)) {
                    updateContent();
                    return;
                }

                if (matchesKey(data, "up") || data === "k") {
                    if (state.cursor > 0) {
                        state.cursor--;
                    }
                    updateContent();
                    return;
                }

                if (matchesKey(data, "down") || data === "j") {
                    if (state.cursor < state.items.length - 1) {
                        state.cursor++;
                    }
                    updateContent();
                    return;
                }

                if (matchesKey(data, "enter") || matchesKey(data, "escape") || data === "q") {
                    done(undefined);
                    return;
                }
            };

            // Initial render
            updateContent();

            return {
                render: (_width: number) => container.render(_width),
                invalidate: () => {},
                handleInput,
            };
        },
    );
}
