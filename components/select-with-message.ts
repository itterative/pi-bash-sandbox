/**
 * Select with Inline Message Component
 *
 * A single-select UI component with a scrollable content area (like a pager)
 * and an optional inline message edited by pressing Tab.
 *
 * Layout:
 *   ┌─── DynamicBorder ────────────────────────┐
 *   │  Title (fixed, always visible)           │
 *   │                                          │
 *   │  ┌─ contentBox (scrollable) ───────────┐ │
 *   │  │  Content lines (PgUp/PgDn to scroll)│ │
 *   │  │  ...                                │ │
 *   │  │  Showing lines X-Y of Z             │ │
 *   │  └─────────────────────────────────────┘ │
 *   │                                          │
 *   │  → Item 1                                │
 *   │    Item 2                                │
 *   │    Item 3                                │
 *   │                                          │
 *   │  Help text                               │
 *   └─── DynamicBorder ────────────────────────┘
 *
 * Flow:
 * - ↑/↓ navigate options
 * - Enter selects option immediately (no message)
 * - Tab switches to inline edit mode: "Option, |" where cursor types
 * - In edit mode: Enter confirms with message, Escape returns to selection
 * - PageUp/PageDown scrolls the content area
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import type { Component, Focusable } from "@mariozechner/pi-tui";
import {
    CURSOR_MARKER,
    Box,
    Container,
    matchesKey,
    Spacer,
    Text,
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
    // Title shown at the top (always visible)
    title: string;
    // Content lines displayed in the scrollable area (e.g. command text)
    contentLines: string[];
    // Items to select from (always visible below content area)
    items: SelectMessageItem<T>[];
    // Initial cursor position
    initialCursor?: number;
    // Maximum visible lines in the scrollable content area (default: 10)
    maxContentLines?: number;
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

// Calculate clamped scroll offset after applying a delta
function clampScrollOffset(
    totalLines: number,
    currentOffset: number,
    delta: number,
    maxVisibleLines: number,
): number {
    const maxOffset = Math.max(0, totalLines - maxVisibleLines);
    return Math.max(0, Math.min(currentOffset + delta, maxOffset));
}

/**
 * SelectWithMessageComponent
 *
 * Uses the same Container/Box/Text/DynamicBorder pattern as PagerComponent
 * and SelectComponent.
 */
class SelectWithMessageComponent<T> implements Component, Focusable {
    private container: Container;
    private contentBox: Box;
    private theme: Theme | null = null;
    private readonly selectHelpText: string;
    private readonly editHelpText: string;
    private readonly messageSeparator: string;
    private readonly messagePlaceholder: string;
    private readonly maxContentLines: number;
    private done: ((result: SelectWithMessageResult<T> | undefined) => void) | null = null;

    // Mutable state
    cursor: number;
    editing = false;
    editBuffer = "";
    scrollOffset = 0;
    private _focused = false;

    constructor(
        private readonly options: SelectWithMessageOptions<T>,
    ) {
        this.selectHelpText = options.selectHelpText ?? "↑/↓ navigate | Enter select | Tab add message | PgUp/PgDn scroll | Esc cancel";
        this.editHelpText = options.editHelpText ?? "Enter confirm | Esc back";
        this.messageSeparator = options.messageSeparator ?? ", ";
        this.messagePlaceholder = options.messagePlaceholder ?? "type a message...";
        this.maxContentLines = options.maxContentLines ?? 10;
        this.cursor = options.initialCursor ?? 0;

        this.container = new Container();
        this.contentBox = new Box(1, 0);
    }

    setDoneCallback(done: (result: SelectWithMessageResult<T> | undefined) => void): void {
        this.done = done;
    }

    initialize(theme: Theme): void {
        this.theme = theme;
        const borderColor = (s: string) => theme.fg("border", s);

        this.container.addChild(new DynamicBorder(borderColor));

        // Title (fixed, always visible)
        this.container.addChild(
            new Text(
                theme.fg("accent", theme.bold(`  ${this.options.title}`)),
                1,
                0,
            ),
        );
        this.container.addChild(new Spacer(1));

        // Scrollable content area + items + help text
        this.container.addChild(this.contentBox);

        this.container.addChild(new Spacer(1));
        this.container.addChild(new DynamicBorder(borderColor));
    }

    get focused(): boolean {
        return this._focused;
    }

    set focused(value: boolean) {
        this._focused = value;
    }

    render(width: number): string[] {
        if (!this.theme) {
            throw new Error("SelectWithMessageComponent must be initialized before rendering");
        }
        this.rebuildContent();
        return this.container.render(width);
    }

    invalidate(): void {
        this.container.invalidate();
    }

    handleInput(key: string): void {
        // Handled by the wrapper in selectWithMessage()
    }

    private rebuildContent(): void {
        if (!this.theme) return;

        this.contentBox.clear();

        // --- Scrollable content area ---
        const contentLines = this.options.contentLines;
        const totalLines = contentLines.length;

        if (totalLines > 0) {
            const maxOffset = Math.max(0, totalLines - this.maxContentLines);
            const clampedOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
            const visibleLines = contentLines.slice(clampedOffset, clampedOffset + this.maxContentLines);
            const lineNumWidth = String(totalLines).length;

            for (let vi = 0; vi < visibleLines.length; vi++) {
                const lineNum = clampedOffset + vi + 1;
                const line = visibleLines[vi];
                const numPrefix = this.theme.fg("dim", String(lineNum).padStart(lineNumWidth) + " │ ");

                if (line.trim() === "") {
                    this.contentBox.addChild(new Text(numPrefix, 1, 0));
                } else {
                    this.contentBox.addChild(new Text(numPrefix + line, 1, 0));
                }
            }

            // Scroll indicator
            if (totalLines > this.maxContentLines) {
                const endLine = clampedOffset + visibleLines.length;
                this.contentBox.addChild(new Spacer(1));
                this.contentBox.addChild(
                    new Text(
                        this.theme.fg("dim", `  Showing lines ${clampedOffset + 1}-${endLine} of ${totalLines} (PgUp/PgDn to scroll)`),
                        1,
                        0,
                    ),
                );
            }
        }

        this.contentBox.addChild(new Spacer(1));

        // --- Selection items (always visible) ---
        for (let i = 0; i < this.options.items.length; i++) {
            const item = this.options.items[i];
            if (!item) continue;

            const isCursor = i === this.cursor;
            const isEditing = isCursor && this.editing;

            const prefix = isCursor
                ? this.theme.fg("accent", "→ ")
                : "  ";

            let content: string;

            if (isEditing) {
                const label = this.theme.fg("accent", item.label);
                const buffer = this.editBuffer;
                const hasContent = buffer.length > 0;

                const visualCursor = "\x1b[7m \x1b[27m";
                const marker = this._focused ? CURSOR_MARKER : "";

                if (hasContent) {
                    content = `${label}${this.messageSeparator}${buffer}${marker}${visualCursor}`;
                } else {
                    const placeholderText = item.placeholder ?? this.messagePlaceholder;
                    const placeholder = this.theme.fg("dim", placeholderText);
                    content = `${label}${this.messageSeparator}${marker}${visualCursor}${placeholder}`;
                }
            } else {
                const label = isCursor
                    ? this.theme.fg("accent", item.label)
                    : item.label;

                content = item.description
                    ? `${label}${this.theme.fg("muted", ` - ${item.description}`)}`
                    : label;
            }

            this.contentBox.addChild(new Text(`${prefix}${content}`, 1, 0));
        }

        this.contentBox.addChild(new Spacer(1));

        // Help text
        const helpText = this.editing ? this.editHelpText : this.selectHelpText;
        this.contentBox.addChild(
            new Text(this.theme.fg("muted", `  ${helpText}`), 1, 0),
        );
    }
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
        const component = new SelectWithMessageComponent(options);
        component.setDoneCallback(done);
        component.initialize(theme);

        function confirmSelection(): void {
            const item = options.items[component.cursor];
            if (!item) {
                done(undefined);
                return;
            }

            const message = component.editBuffer.trim() || undefined;
            const messageSeparator = options.messageSeparator ?? ", ";
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
            if (component.editing) {
                if (matchesKey(key, "escape")) {
                    component.editing = false;
                    component.editBuffer = "";
                    component.invalidate();
                    return;
                }

                if (matchesKey(key, "enter")) {
                    confirmSelection();
                    return;
                }

                if (matchesKey(key, "backspace")) {
                    component.editBuffer = component.editBuffer.slice(0, -1);
                    component.invalidate();
                    return;
                }

                if (key.length === 1 && key.charCodeAt(0) >= 32) {
                    component.editBuffer += key;
                    component.invalidate();
                }
                return;
            }

            // Selection mode
            if (matchesKey(key, "up") || key === "k") {
                if (component.cursor > 0) {
                    component.cursor--;
                    component.invalidate();
                }
                return;
            }

            if (matchesKey(key, "down") || key === "j") {
                if (component.cursor < options.items.length - 1) {
                    component.cursor++;
                    component.invalidate();
                }
                return;
            }

            if (matchesKey(key, "pageUp")) {
                component.scrollOffset = clampScrollOffset(
                    options.contentLines.length,
                    component.scrollOffset,
                    -(options.maxContentLines ?? 10),
                    options.maxContentLines ?? 10,
                );
                component.invalidate();
                return;
            }

            if (matchesKey(key, "pageDown")) {
                component.scrollOffset = clampScrollOffset(
                    options.contentLines.length,
                    component.scrollOffset,
                    options.maxContentLines ?? 10,
                    options.maxContentLines ?? 10,
                );
                component.invalidate();
                return;
            }

            if (matchesKey(key, "enter")) {
                confirmSelection();
                return;
            }

            if (matchesKey(key, "tab")) {
                component.editing = true;
                component.editBuffer = "";
                component.invalidate();
                return;
            }

            if (matchesKey(key, "escape") || key === "q") {
                done(undefined);
                return;
            }
        }

        // Return wrapper component that delegates to the component instance
        const wrapper: Component & Focusable = {
            render: (width: number) => component.render(width),
            invalidate: () => component.invalidate(),
            handleInput,
            get focused() { return component.focused; },
            set focused(value: boolean) { component.focused = value; },
        };

        return wrapper;
    });
}
