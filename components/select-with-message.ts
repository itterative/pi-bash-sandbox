/**
 * Select with Inline Message Component
 *
 * A simple single-select UI component that allows adding an optional inline message
 * by pressing Tab on an option to edit it.
 *
 * Flow:
 * - ↑/↓ navigate options
 * - Enter selects option immediately (no message)
 * - Tab switches to inline edit mode: "Option, |" where cursor types
 * - In edit mode: Enter confirms with message, Escape returns to selection
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, Focusable } from "@mariozechner/pi-tui";
import {
    CURSOR_MARKER,
    matchesKey,
    truncateToWidth,
} from "@mariozechner/pi-tui";

// An item in the select list
export interface SelectMessageItem<T> {
    value: T;
    label: string;
    description?: string;
    // Optional placeholder for message input (overrides default)
    placeholder?: string;
}

// Options for the select-with-message component
export interface SelectWithMessageOptions<T> {
    // Title shown at the top
    title: string;
    // Items to display
    items: SelectMessageItem<T>[];
    // Initial cursor position
    initialCursor?: number;
    // Custom help text for selection mode
    selectHelpText?: string;
    // Custom help text for edit mode
    editHelpText?: string;
    // Separator between label and user message (default: ", ")
    messageSeparator?: string;
    // Placeholder shown when editing and no message typed yet
    messagePlaceholder?: string;
}

// Result of the selection
export interface SelectWithMessageResult<T> {
    value: T;
    // The custom message appended by the user (if any)
    message?: string;
    // The full display text (label + message)
    displayText: string;
}

// Show select-with-message UI and return result (or undefined if cancelled)
export async function selectWithMessage<T>(
    options: SelectWithMessageOptions<T>,
    ctx: { hasUI: boolean; ui: ExtensionContext["ui"] },
): Promise<SelectWithMessageResult<T> | undefined> {
    if (!ctx.hasUI) {
        return undefined;
    }

    if (options.items.length === 0) {
        return undefined;
    }

    return ctx.ui.custom<SelectWithMessageResult<T> | undefined>((_tui, theme, _kb, done) => {
        const selectHelpText = options.selectHelpText ?? "↑/↓ navigate | Enter select | Tab add message | Esc cancel";
        const editHelpText = options.editHelpText ?? "Enter confirm | Esc back";
        const messageSeparator = options.messageSeparator ?? ", ";
        const messagePlaceholder = options.messagePlaceholder ?? "type a message...";

        // Component state
        const state = {
            cursor: options.initialCursor ?? 0,
            editing: false,
            editBuffer: "",
        };

        let cachedLines: string[] | undefined;
        let _focused = false;

        function invalidate(): void {
            cachedLines = undefined;
        }

        function confirmSelection(): void {
            const item = options.items[state.cursor];
            if (!item) {
                done(undefined);
                return;
            }

            const message = state.editBuffer.trim() || undefined;
            const displayText = message
                ? `${item.label}${messageSeparator}${message}`
                : item.label;

            done({
                value: item.value,
                message,
                displayText,
            });
        }

        function handleInput(key: string): void {
            if (state.editing) {
                if (matchesKey(key, "escape")) {
                    state.editing = false;
                    state.editBuffer = "";
                    invalidate();
                    return;
                }

                if (matchesKey(key, "enter")) {
                    confirmSelection();
                    return;
                }

                if (matchesKey(key, "backspace")) {
                    state.editBuffer = state.editBuffer.slice(0, -1);
                    invalidate();
                    return;
                }

                if (key.length === 1 && key.charCodeAt(0) >= 32) {
                    state.editBuffer += key;
                    invalidate();
                }
                return;
            }

            // Selection mode
            if (matchesKey(key, "up") || key === "k") {
                if (state.cursor > 0) {
                    state.cursor--;
                    invalidate();
                }
                return;
            }

            if (matchesKey(key, "down") || key === "j") {
                if (state.cursor < options.items.length - 1) {
                    state.cursor++;
                    invalidate();
                }
                return;
            }

            if (matchesKey(key, "enter")) {
                confirmSelection();
                return;
            }

            if (matchesKey(key, "tab")) {
                state.editing = true;
                state.editBuffer = "";
                invalidate();
                return;
            }

            if (matchesKey(key, "escape") || key === "q") {
                done(undefined);
                return;
            }
        }

        function render(width: number): string[] {
            if (cachedLines) return cachedLines;

            const lines: string[] = [];
            const add = (s: string) => lines.push(truncateToWidth(s, width));

            // Top border
            add(theme.fg("border", "─".repeat(width)));

            // Title (handle multi-line)
            const titleLines = options.title.split("\n");
            for (const line of titleLines) {
                add(theme.fg("accent", theme.bold(`  ${line}`)));
            }
            lines.push("");

            // Items
            for (let i = 0; i < options.items.length; i++) {
                const item = options.items[i];
                if (!item) continue;

                const isCursor = i === state.cursor;
                const isEditing = isCursor && state.editing;

                const prefix = isCursor
                    ? theme.fg("accent", "→ ")
                    : "  ";

                let content: string;

                if (isEditing) {
                    // Render the label
                    const label = theme.fg("accent", item.label);
                    const buffer = state.editBuffer;
                    const hasContent = buffer.length > 0;

                    // Visual cursor (reverse video space)
                    const visualCursor = "\x1b[7m \x1b[27m";
                    // CURSOR_MARKER positions hardware cursor (only when focused)
                    const marker = _focused ? CURSOR_MARKER : "";

                    if (hasContent) {
                        content = `${label}${messageSeparator}${buffer}${marker}${visualCursor}`;
                    } else {
                        // Use item placeholder if defined, otherwise default
                        const placeholderText = item.placeholder ?? messagePlaceholder;
                        const placeholder = theme.fg("dim", placeholderText);
                        content = `${label}${messageSeparator}${marker}${visualCursor}${placeholder}`;
                    }
                } else {
                    // Normal rendering
                    const label = isCursor
                        ? theme.fg("accent", item.label)
                        : item.label;

                    content = item.description
                        ? `${label}${theme.fg("muted", ` - ${item.description}`)}`
                        : label;
                }

                add(`${prefix}${content}`);
            }

            lines.push("");

            // Help text
            const helpText = state.editing ? editHelpText : selectHelpText;
            add(theme.fg("muted", `  ${helpText}`));

            // Bottom border
            add(theme.fg("border", "─".repeat(width)));

            cachedLines = lines;
            return lines;
        }

        // Return component with Focusable interface
        const component: Component & Focusable = {
            render,
            invalidate,
            handleInput,
            get focused() { return _focused; },
            set focused(value: boolean) { _focused = value; },
        };

        return component;
    });
}
