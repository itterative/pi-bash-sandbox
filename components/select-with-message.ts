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
 * - In edit mode: ←/→ move cursor, ↑/↓ navigate visual lines
 * - PageUp/PageDown scrolls the content area
 *
 * Edit buffer model:
 * - Segments: typed text or large pastes (shown as placeholder)
 * - cursorPos: flat offset into concatenated content
 * - Paste segments are atomic for cursor navigation (left/right skip them)
 * - Display buffer replaces paste content with placeholders; cursor mapping
 *   translates between content and display positions
 *
 * Scrolling:
 * - scrollOffset is a visual-row index (accounts for wrapped lines)
 * - When a wrapped line is split by scrolling, the continuation gets an
 *   ellipsis prefix ("… │ ") to indicate it belongs to the line above
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
    visibleWidth,
    wrapTextWithAnsi,
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

// Per-logical-line info after wrapping (content only, no prefixes)
interface LogicalLineInfo {
    // Wrapped text parts (raw content, no prefix)
    parts: string[];
    // Number of visual rows this logical line occupies
    visualCount: number;
}

// Edit buffer segment: typed text or a large paste shown as placeholder
type EditSegment =
    | { type: "text"; content: string }
    | { type: "paste"; content: string; display: string };

// Maps a visual row to its logical line and part
interface FlatEntry {
    logicalIdx: number;
    partIdx: number;
}

/**
 * Wrap a single-line string at word boundaries, preserving trailing spaces.
 * Unlike wrapTextWithAnsi which trims trailing whitespace on wrapped lines,
 * this function keeps spaces intact so in-progress typing (e.g. trailing
 * spaces) remains visible in the edit buffer.
 */
function wrapPreservingSpaces(text: string, width: number): string[] {
    if (width <= 0) return [text || ""];
    const visLen = visibleWidth(text);
    if (visLen <= width) return [text];

    const lines: string[] = [];
    let remaining = text;

    while (visibleWidth(remaining) > width) {
        let lastSpaceStrIdx = -1;
        let visPos = 0;

        for (let si = 0; si < remaining.length; si++) {
            const ch = remaining.codePointAt(si)!;
            // Skip over ANSI escape sequences
            if (ch === 0x1b && remaining[si + 1] === "[") {
                const endSeq = remaining.indexOf("m", si + 2);
                if (endSeq !== -1) {
                    si = endSeq;
                    continue;
                }
            }
            const charWidth = ch > 0xffff ? 2 : 1;
            visPos += charWidth;

            if (visPos > width) {
                break;
            }

            if (ch === 32) {
                lastSpaceStrIdx = si + 1;
            }
        }

        if (lastSpaceStrIdx > 0) {
            lines.push(remaining.substring(0, lastSpaceStrIdx));
            remaining = remaining.substring(lastSpaceStrIdx);
        } else {
            // Hard break at width
            let hardIdx = 0;
            let hv = 0;
            for (let si = 0; si < remaining.length; si++) {
                const ch = remaining.codePointAt(si)!;
                if (ch === 0x1b && remaining[si + 1] === "[") {
                    const endSeq = remaining.indexOf("m", si + 2);
                    if (endSeq !== -1) {
                        si = endSeq;
                        continue;
                    }
                }
                const cw = ch > 0xffff ? 2 : 1;
                if (hv + cw > width) {
                    hardIdx = si;
                    break;
                }
                hv += cw;
                hardIdx = si + 1;
            }
            lines.push(remaining.substring(0, hardIdx));
            remaining = remaining.substring(hardIdx);
        }
    }

    if (remaining.length > 0) {
        lines.push(remaining);
    }

    return lines.length > 0 ? lines : [""];
}

// Visual line info for cursor navigation
interface EditVisLine {
    dispStart: number; // start offset in display string
    dispEnd: number;   // end offset (exclusive) in display string
    text: string;      // visible text (plain, no prefix)
    isFirst: boolean;  // is the very first visual line of the edit area
    truncOffset: number; // display chars skipped due to truncation (0 if not truncated)
}

/**
 * SelectWithMessageComponent
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
    // Segment-based edit buffer
    editSegments: EditSegment[] = [];
    get editBuffer(): string {
        return this.editSegments.map(s => s.content).join("");
    }

    // Cursor position: flat offset into concatenated content (0 to totalLength)
    cursorPos: number = 0;
    // Desired column for vertical navigation (null = use actual)
    desiredCol: number | null = null;

    // Stored during render for up/down navigation (all visual lines)
    private editAllVisLines: EditVisLine[] = [];
    private editVisLines: EditVisLine[] = [];
    private editDispToContent: number[] = [];
    private editCursorDispOff: number = 0;
    private editCursorVisLineIdx: number = 0;

    // Scroll offset for content area
    scrollOffset = 0;
    // Computed during render, used by PgUp/PgDn
    lineInfos: LogicalLineInfo[] = [];
    flatIndex: FlatEntry[] = [];
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
        this.rebuildContent(width);
        return this.container.render(width);
    }

    invalidate(): void {
        this.container.invalidate();
    }

    handleInput(key: string): void {
        // Handled by the wrapper in selectWithMessage()
    }

    // --- Segment / cursor helpers ---

    getContentLength(): number {
        return this.editSegments.reduce((sum, s) => sum + s.content.length, 0);
    }

    /** Map flat content position to (segmentIndex, offset within segment). */
    getSegmentAtPos(pos: number): { segIdx: number; offset: number } {
        let accumulated = 0;
        for (let i = 0; i < this.editSegments.length; i++) {
            const segLen = this.editSegments[i]!.content.length;
            if (pos <= accumulated + segLen) {
                return { segIdx: i, offset: pos - accumulated };
            }
            accumulated += segLen;
        }
        // Past the end — clamp to end of last segment
        const lastIdx = Math.max(0, this.editSegments.length - 1);
        return { segIdx: lastIdx, offset: this.editSegments[lastIdx]?.content.length ?? 0 };
    }

    /** Map (segmentIndex, offset) to flat content position. */
    getFlatPos(segIdx: number, offset: number): number {
        let pos = 0;
        for (let i = 0; i < segIdx; i++) {
            pos += this.editSegments[i]!.content.length;
        }
        return pos + offset;
    }

    // --- Cursor movement ---

    moveCursorLeft(): void {
        if (this.cursorPos <= 0) return;
        this.cursorPos--;
        this.desiredCol = null;
        // If landed inside a paste segment, jump to its start
        const { segIdx, offset } = this.getSegmentAtPos(this.cursorPos);
        const seg = this.editSegments[segIdx];
        if (seg?.type === "paste") {
            this.cursorPos = this.getFlatPos(segIdx, 0);
        }
    }

    moveCursorRight(): void {
        const totalLen = this.getContentLength();
        if (this.cursorPos >= totalLen) return;
        this.cursorPos++;
        this.desiredCol = null;
        // If landed inside a paste segment, jump to its end
        const { segIdx } = this.getSegmentAtPos(this.cursorPos);
        const seg = this.editSegments[segIdx];
        if (seg?.type === "paste") {
            this.cursorPos = this.getFlatPos(segIdx, seg.content.length);
        }
    }

    moveCursorUp(): void {
        if (this.editAllVisLines.length === 0) return;

        const curLine = this.editCursorVisLineIdx;
        if (curLine <= 0) {
            // Already on absolute first line — move to start
            this.cursorPos = 0;
            this.desiredCol = null;
            return;
        }

        const curVl = this.editAllVisLines[curLine]!;
        const curCol = this.desiredCol ?? (this.editCursorDispOff - curVl.dispStart);
        this.desiredCol = curCol;

        const prev = this.editAllVisLines[curLine - 1]!;
        const targetDispOff = Math.min(prev.dispStart + curCol, prev.dispEnd);
        this.cursorPos = this.editDispToContent[targetDispOff] ?? 0;
    }

    moveCursorDown(): void {
        if (this.editAllVisLines.length === 0) return;

        const curLine = this.editCursorVisLineIdx;
        if (curLine === -1 || curLine >= this.editAllVisLines.length - 1) {
            // Already on absolute last line — move to end
            this.cursorPos = this.getContentLength();
            this.desiredCol = null;
            return;
        }

        const curVl = this.editAllVisLines[curLine]!;
        const curCol = this.desiredCol ?? (this.editCursorDispOff - curVl.dispStart);
        this.desiredCol = curCol;

        const next = this.editAllVisLines[curLine + 1]!;
        const targetDispOff = Math.min(next.dispStart + curCol, next.dispEnd);
        this.cursorPos = this.editDispToContent[targetDispOff] ?? this.getContentLength();
    }

    // --- Editing ---

    /** Insert text at cursor position. */
    insertAtCursor(text: string): void {
        if (this.editSegments.length === 0) {
            this.editSegments.push({ type: "text", content: text });
            this.cursorPos = text.length;
            return;
        }

        const { segIdx, offset } = this.getSegmentAtPos(this.cursorPos);
        const seg = this.editSegments[segIdx];

        if (seg && seg.type === "text") {
            // Insert into existing text segment
            seg.content = seg.content.slice(0, offset) + text + seg.content.slice(offset);
        } else {
            // At a paste boundary — create new text segment
            const insertIdx = (seg?.type === "paste" && offset === seg.content.length)
                ? segIdx + 1
                : segIdx;
            // Try to merge with adjacent text segment
            const prev = insertIdx > 0 ? this.editSegments[insertIdx - 1] : undefined;
            if (prev && prev.type === "text" && offset === 0) {
                // Appending to end of previous text segment
                prev.content += text;
            } else {
                this.editSegments.splice(insertIdx, 0, { type: "text", content: text });
            }
        }
        this.cursorPos += text.length;
    }

    /** Delete character/segment before cursor. */
    deleteBeforeCursor(): void {
        if (this.cursorPos <= 0) return;

        const { segIdx, offset } = this.getSegmentAtPos(this.cursorPos - 1);
        const seg = this.editSegments[segIdx];
        if (!seg) return;

        if (seg.type === "paste") {
            // Remove entire paste segment
            this.cursorPos -= seg.content.length;
            this.editSegments.splice(segIdx, 1);
        } else {
            seg.content = seg.content.slice(0, offset) + seg.content.slice(offset + 1);
            this.cursorPos--;
            if (seg.content.length === 0) {
                this.editSegments.splice(segIdx, 1);
            }
        }
    }

    // --- Content area helpers ---

    private computeLineInfos(
        contentLines: string[],
        width: number,
    ): { infos: LogicalLineInfo[]; flatIndex: FlatEntry[] } {
        const totalLines = contentLines.length;
        if (totalLines === 0) return { infos: [], flatIndex: [] };

        const lineNumWidth = String(totalLines).length;
        const effectiveTextWidth = Math.max(1, width - 4);
        const prefixVisWidth = lineNumWidth + 3;
        const textContentWidth = Math.max(1, effectiveTextWidth - prefixVisWidth);

        const infos: LogicalLineInfo[] = [];
        const flatIndex: FlatEntry[] = [];

        for (let i = 0; i < totalLines; i++) {
            const line = contentLines[i]!;

            let parts: string[];
            if (line.trim() === "") {
                parts = [""];
            } else {
                parts = wrapTextWithAnsi(line, textContentWidth);
            }

            infos.push({ parts, visualCount: parts.length });
            for (let pi = 0; pi < parts.length; pi++) {
                flatIndex.push({ logicalIdx: i, partIdx: pi });
            }
        }

        return { infos, flatIndex };
    }

    /**
     * Build the display buffer from segments (replacing paste content with
     * placeholders) and the content↔display position mapping.
     */
    private buildDisplayMapping(): {
        display: string;
        contentToDisp: number[];
        dispToContent: number[];
    } {
        let display = "";
        const contentToDisp: number[] = [];
        const dispToContent: number[] = [];
        let cPos = 0;

        for (const seg of this.editSegments) {
            if (seg.type === "paste") {
                const dStart = display.length;
                // Content start maps to display start
                contentToDisp[cPos] = dStart;
                // All placeholder chars map to paste start content position
                for (let di = 0; di < seg.display.length; di++) {
                    dispToContent[dStart + di] = cPos;
                }
                display += seg.display;
                // Content end maps to display end
                const dEnd = display.length;
                cPos += seg.content.length;
                contentToDisp[cPos] = dEnd;
                dispToContent[dEnd] = cPos;
            } else {
                for (let i = 0; i < seg.content.length; i++) {
                    contentToDisp[cPos + i] = display.length + i;
                    dispToContent[display.length + i] = cPos + i;
                }
                display += seg.content;
                cPos += seg.content.length;
            }
        }

        return { display, contentToDisp, dispToContent };
    }

    private rebuildContent(width: number): void {
        if (!this.theme) return;

        this.contentBox.clear();

        // --- Scrollable content area ---
        const contentLines = this.options.contentLines;
        const totalLogicalLines = contentLines.length;

        if (totalLogicalLines > 0) {
            const { infos, flatIndex } = this.computeLineInfos(contentLines, width);
            this.lineInfos = infos;
            this.flatIndex = flatIndex;

            const totalVisual = flatIndex.length;

            const maxOffset = Math.max(0, totalVisual - this.maxContentLines);
            const start = Math.max(0, Math.min(this.scrollOffset, maxOffset));
            this.scrollOffset = start;
            const end = Math.min(totalVisual, start + this.maxContentLines);

            const lineNumWidth = String(totalLogicalLines).length;
            const numPrefix = (idx: number) =>
                this.theme!.fg("dim", String(idx + 1).padStart(lineNumWidth) + " │ ");
            const contPrefix = this.theme!.fg("dim", " ".repeat(lineNumWidth) + " │ ");
            const ellipsisPrefix = this.theme!.fg("dim", " ".repeat(Math.max(0, lineNumWidth - 1)) + "… │ ");

            for (let vi = start; vi < end; vi++) {
                const entry = flatIndex[vi]!;
                let prefix: string;

                if (entry.partIdx === 0) {
                    prefix = numPrefix(entry.logicalIdx);
                } else if (vi === start) {
                    prefix = ellipsisPrefix;
                } else {
                    prefix = contPrefix;
                }

                const content = infos[entry.logicalIdx]!.parts[entry.partIdx]!;
                this.contentBox.addChild(new Text(prefix + content, 1, 0));
            }

            if (totalVisual > this.maxContentLines) {
                const firstLogical = flatIndex[start]!.logicalIdx + 1;
                const lastLogical = flatIndex[end - 1]!.logicalIdx + 1;
                this.contentBox.addChild(new Spacer(1));
                this.contentBox.addChild(
                    new Text(
                        this.theme!.fg("dim", `  Showing lines ${firstLogical}-${lastLogical} of ${totalLogicalLines} (PgUp/PgDn to scroll)`),
                        1,
                        0,
                    ),
                );
            }
        } else {
            this.lineInfos = [];
            this.flatIndex = [];
        }

        this.contentBox.addChild(new Spacer(1));

        // --- Selection items (always visible) ---
        for (let i = 0; i < this.options.items.length; i++) {
            const item = this.options.items[i];
            if (!item) continue;

            const isCursor = i === this.cursor;
            const isEditing = isCursor && this.editing;

            const prefix = isCursor
                ? this.theme!.fg("accent", "→ ")
                : "  ";

            if (isEditing) {
                this.renderEditArea(item, prefix, width);
            } else {
                const label = isCursor
                    ? this.theme!.fg("accent", item.label)
                    : item.label;
                const content = item.description
                    ? `${label}${this.theme!.fg("muted", ` - ${item.description}`)}`
                    : label;
                this.contentBox.addChild(new Text(`${prefix}${content}`, 1, 0));
            }
        }

        this.contentBox.addChild(new Spacer(1));

        // Help text
        const helpText = this.editing ? this.editHelpText : this.selectHelpText;
        this.contentBox.addChild(
            new Text(this.theme!.fg("muted", `  ${helpText}`), 1, 0),
        );
    }

    /** Render the edit area for the selected item with cursor navigation support. */
    private renderEditArea(item: SelectMessageItem<T>, prefix: string, width: number): void {
        const label = this.theme!.fg("accent", item.label);
        const buffer = this.editBuffer;
        const hasContent = buffer.length > 0;
        const marker = this._focused ? CURSOR_MARKER : "";
        const visualCursor = "\x1b[7m \x1b[27m";
        const isAtEnd = this.cursorPos >= buffer.length;

        // Content width: Container(width) → Box(padX=1) → Text(padX=1) = width-4
        const contentWidth = Math.max(1, width - 4);
        const prefixVisWidth = visibleWidth(prefix);

        if (!hasContent) {
            // Empty buffer — cursor at start
            const placeholder = this.theme!.fg("dim", item.placeholder ?? this.messagePlaceholder);
            this.contentBox.addChild(new Text(
                `${prefix}${label}${this.messageSeparator}${marker}${visualCursor}${placeholder}`,
                1, 0,
            ));
            // Store minimal navigation state
            this.editAllVisLines = [];
            this.editVisLines = [];
            this.editDispToContent = [];
            this.editCursorDispOff = 0;
            this.editCursorVisLineIdx = 0;
            return;
        }

        // Label and width calculations
        const labelWithSep = `${label}${this.messageSeparator}`;
        const labelSepVisWidth = visibleWidth(labelWithSep);
        const totalPrefixVisWidth = prefixVisWidth + labelSepVisWidth;

        // -1 to leave room for the cursor character on every visual line
        const firstBufWidth = Math.max(1, contentWidth - totalPrefixVisWidth - 1);
        const contPadWidth = totalPrefixVisWidth;
        const contIndent = " ".repeat(contPadWidth);
        const contLineWidth = Math.max(1, contentWidth - contPadWidth - 1);

        // Build display buffer with content↔display mapping
        const { display, contentToDisp, dispToContent } = this.buildDisplayMapping();

        // Store for up/down navigation
        this.editDispToContent = dispToContent;
        this.editCursorDispOff = contentToDisp[this.cursorPos] ?? display.length;

        // Wrap display buffer into visual lines, tracking display offsets
        const displayLines = display.split("\n");
        const allVisLines: EditVisLine[] = [];
        let dOff = 0;
        let firstVis = true;

        for (let li = 0; li < displayLines.length; li++) {
            const dLine = displayLines[li]!;
            const wrapWidth = firstVis ? firstBufWidth : contLineWidth;
            const parts = dLine.length === 0 ? [""] : wrapPreservingSpaces(dLine, wrapWidth);

            let lineDOff = dOff;
            for (const part of parts) {
                allVisLines.push({
                    dispStart: lineDOff,
                    dispEnd: lineDOff + part.length,
                    text: part,
                    isFirst: firstVis,
                    truncOffset: 0,
                });
                lineDOff += part.length;
                firstVis = false;
            }
            // Account for the \n character in display offsets
            dOff += dLine.length + (li < displayLines.length - 1 ? 1 : 0);
        }

        // Find cursor's visual line (use < for exclusive dispEnd)
        const cursorDispOff = this.editCursorDispOff;
        let cursorVisLineIdx = allVisLines.findIndex(vl =>
            cursorDispOff >= vl.dispStart && cursorDispOff < vl.dispEnd
        );
        if (cursorVisLineIdx === -1) {
            // Cursor at end of buffer (past all dispEnds) — use last line
            cursorVisLineIdx = allVisLines.length - 1;
        }

        // Apply line limit: show window that includes cursor's visual line
        const maxEditLines = 3;
        let startLine: number;
        if (allVisLines.length <= maxEditLines) {
            startLine = 0;
        } else {
            startLine = Math.max(0, Math.min(
                cursorVisLineIdx,
                allVisLines.length - maxEditLines,
            ));
        }
        const endLine = Math.min(allVisLines.length, startLine + maxEditLines);
        const visibleVisLines = allVisLines.slice(startLine, endLine);

        // Compute truncation offset for the first visible line when truncated.
        // When the first line is truncated, the "…" replaces `firstBufWidth` display chars
        // with 1 visible char. Navigation needs to account for this offset.
        const isTruncated = startLine > 0;
        if (isTruncated && visibleVisLines.length > 0) {
            const firstVl = visibleVisLines[0]!;
            // If the first visible line is the original first line (with label prefix),
            // the displayed text is label + "…" + (text from mid-line onwards).
            // The truncation hides chars from the start of the original first line's text.
            // Figure out how many display chars of the first line are hidden.
            if (firstVl.isFirst) {
                // Show "…" (1 col) + tail of first line text.
                // We skip 1 char from the start of the text to make room for "…".
                firstVl.truncOffset = 1;
            }
        }

        // Store all visual lines and cursor index for up/down navigation
        this.editAllVisLines = allVisLines;
        this.editCursorVisLineIdx = cursorVisLineIdx;
        // Store visible visual lines for rendering reference
        this.editVisLines = visibleVisLines;

        // Build Text components with cursor marker
        for (let vi = 0; vi < visibleVisLines.length; vi++) {
            const vl = visibleVisLines[vi]!;
            const isCursorLine = (startLine + vi) === cursorVisLineIdx;
        const isTruncatedTop = startLine > 0;
        const isTruncatedBottom = endLine < allVisLines.length;

            let linePrefix: string;
            let prefixText: string; // text before the buffer content (label or "…")

            if (vi === 0) {
                // First rendered line always shows label
                linePrefix = prefix;
                if (isTruncatedTop) {
                    prefixText = labelWithSep + "…";
                } else if (vl.isFirst) {
                    prefixText = labelWithSep;
                } else {
                    // Shouldn't happen (vi===0 implies first vis line), but fallback
                    prefixText = labelWithSep;
                }
            } else {
                linePrefix = contIndent;
                prefixText = "";
            }

            // Append "…" suffix if this is the last visible line and there are more lines below
            let suffixText = "";
            if (vi === visibleVisLines.length - 1 && isTruncatedBottom) {
                suffixText = "…";
            }

            // Compute the actual text to display for this visual line
            let displayText = vl.text;
            if (vl.truncOffset > 0) {
                // Truncated: skip the hidden portion of text
                displayText = vl.text.slice(vl.truncOffset);
            }

            if (isCursorLine) {
                const cursorColInText = cursorDispOff - vl.dispStart - vl.truncOffset;
                const insertAt = prefixText.length + Math.min(cursorColInText, displayText.length);

                if (isAtEnd) {
                    // Cursor at end of buffer — append marker + visual cursor + suffix
                    this.contentBox.addChild(new Text(
                        `${linePrefix}${prefixText}${displayText}${suffixText}${marker}${visualCursor}`,
                        1, 0,
                    ));
                } else {
                    // Cursor mid-line — highlight the character under the cursor
                    const full = prefixText + displayText + suffixText;
                    const charUnderCursor = full[insertAt];
                    if (charUnderCursor) {
                        const highlighted = `\x1b[7m${charUnderCursor}\x1b[27m`;
                        this.contentBox.addChild(new Text(
                            `${linePrefix}${full.slice(0, insertAt)}${marker}${highlighted}${full.slice(insertAt + 1)}`,
                            1, 0,
                        ));
                    } else {
                        this.contentBox.addChild(new Text(
                            `${linePrefix}${full}${marker}${visualCursor}`,
                            1, 0,
                        ));
                    }
                }
            } else {
                this.contentBox.addChild(new Text(
                    `${linePrefix}${prefixText}${displayText}${suffixText}`,
                    1, 0,
                ));
            }
        }
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

        // Bracketed paste state
        let pasteBuffer = "";
        let isInPaste = false;

        function handleInput(key: string): void {
            // Handle bracketed paste mode: \x1b[200~ starts, \x1b[201~ ends
            if (key.includes("\x1b[200~")) {
                isInPaste = true;
                pasteBuffer = "";
                key = key.replace("\x1b[200~", "");
            }

            if (isInPaste) {
                pasteBuffer += key;
                const endIndex = pasteBuffer.indexOf("\x1b[201~");
                if (endIndex !== -1) {
                    const pasteContent = pasteBuffer.substring(0, endIndex);
                    if (component.editing) {
                        const cleanText = pasteContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
                        const isLarge = cleanText.includes("\n") || cleanText.length > 150;
                        if (isLarge) {
                            const lineCount = cleanText.split("\n").length;
                            const display = lineCount > 1
                                ? `[Pasted ${lineCount} lines]`
                                : `[Pasted ${cleanText.length} chars]`;
                            component.editSegments.push({ type: "paste", content: cleanText, display });
                            component.cursorPos = component.getContentLength();
                        } else {
                            component.insertAtCursor(cleanText);
                        }
                        component.invalidate();
                    }
                    isInPaste = false;
                    const remaining = pasteBuffer.substring(endIndex + 6);
                    pasteBuffer = "";
                    if (remaining) {
                        handleInput(remaining);
                    }
                }
                return;
            }

            if (component.editing) {
                if (matchesKey(key, "escape")) {
                    component.editing = false;
                    component.editSegments = [];
                    component.cursorPos = 0;
                    component.invalidate();
                    return;
                }

                if (matchesKey(key, "enter")) {
                    confirmSelection();
                    return;
                }

                if (matchesKey(key, "backspace")) {
                    component.deleteBeforeCursor();
                    component.invalidate();
                    return;
                }

                if (matchesKey(key, "left")) {
                    component.moveCursorLeft();
                    component.invalidate();
                    return;
                }

                if (matchesKey(key, "right")) {
                    component.moveCursorRight();
                    component.invalidate();
                    return;
                }

                if (matchesKey(key, "up")) {
                    component.moveCursorUp();
                    component.invalidate();
                    return;
                }

                if (matchesKey(key, "down")) {
                    component.moveCursorDown();
                    component.invalidate();
                    return;
                }

                if (key.length === 1 && key.charCodeAt(0) >= 32) {
                    component.insertAtCursor(key);
                    component.desiredCol = null;
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
                const maxCL = options.maxContentLines ?? 10;
                component.scrollOffset = Math.max(0, component.scrollOffset - maxCL);
                component.invalidate();
                return;
            }

            if (matchesKey(key, "pageDown")) {
                const flatIndex = component.flatIndex;
                const maxCL = options.maxContentLines ?? 10;
                const currentEnd = Math.min(flatIndex.length, component.scrollOffset + maxCL);

                if (currentEnd < flatIndex.length) {
                    component.scrollOffset = currentEnd;
                }
                component.invalidate();
                return;
            }

            if (matchesKey(key, "enter")) {
                confirmSelection();
                return;
            }

            if (matchesKey(key, "tab")) {
                component.editing = true;
                component.editSegments = [];
                component.cursorPos = 0;
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
