---
name: edit-cursor-navigation
description: Design and implementation of cursor navigation in the select-with-message edit area.
---

# Edit Cursor Navigation Design

## Cursor Model

**Primary state:** `cursorPos: number` — flat offset into the concatenated content string (0 to `getContentLength()`).

**Why flat offset?** Simpler for up/down navigation (compute visual lines from display buffer, navigate, map back). Segment-aware operations use helpers to convert flat offset ↔ (segmentIndex, charOffset).

## Segment Helpers

- `getSegmentAtPos(pos)` → `{ segIdx, offset }` — walks segments accumulating lengths
- `getFlatPos(segIdx, offset)` → `number` — sums preceding segment lengths + offset
- `getContentLength()` — sum of all segment content lengths

## Paste Segments (Atomic Navigation)

Paste segments are atomic — cursor cannot land inside them:
- **moveCursorRight:** increment by 1. If landed in paste, jump to paste end.
- **moveCursorLeft:** decrement by 1. If landed in paste, jump to paste start.
- **Backspace at paste boundary:** remove entire paste segment.

## Display ↔ Content Mapping

Built in `buildDisplayMapping()`:
- `contentToDisp[contentOffset]` → display offset
- `dispToContent[displayOffset]` → content offset

Paste placeholders cause display ≠ content positions.

## Visual Line Layout

During render (`renderEditArea`):
1. Build display buffer + mapping via `buildDisplayMapping()`
2. Map `cursorPos` → `editCursorDispOff` via `contentToDisp`
3. Split display buffer by `\n`, wrap each line with `wrapPreservingSpaces`
4. Track `EditVisLine { dispStart, dispEnd, text, isFirst, truncOffset }` for each visual lines
5. Find cursor's visual line index (using `< dispEnd` for exclusive end)
6. Apply `maxEditLines` (3) window to keep cursor visible

**Stored on component:**
- `editAllVisLines` — ALL visual lines (for up/down navigation)
- `editCursorVisLineIdx` — absolute index into `editAllVisLines`
- `editVisLines` — visible window only (for rendering reference)
- `editDispToContent`, `editCursorDispOff`

## Up/Down Navigation

Uses `editAllVisLines` and `editCursorVisLineIdx` (absolute, not windowed):
1. Get current column: `desiredCol ?? (editCursorDispOff - curVl.dispStart)`
2. Set `desiredCol` to remember column across vertical moves
3. Move to adjacent visual line at `min(targetLine.dispStart + desiredCol, targetLine.dispEnd)`
4. Map display offset back to content offset

**Edge cases:** Up on first line → pos 0; Down on last line → end.

## Cursor Rendering

- **End of buffer:** append `CURSOR_MARKER + visualCursor` (reverse-video space)
- **Mid-line:** highlight character *under* cursor with `\x1b[7m${ch}\x1b[27m` — no text shift
- **Empty buffer:** show `CURSOR_MARKER + visualCursor + placeholder`

## Wrap Width

`firstBufWidth` and `contLineWidth` are reduced by 1 to leave room for the cursor character on every visual line.

## Truncation Indicators

- **Top truncated** (hidden lines above): first rendered line shows `label + "…"`
- **Bottom truncated** (hidden lines below): last rendered line appends `"…"` suffix
- `truncOffset` on first visible `EditVisLine` tracks how many display chars are hidden by the `…` prefix

## Fixes Applied (Session 2)

1. **`wrapPreservingSpaces` bug:** `visPos` was never accumulated — loop always ran to end of string, wrapping at the *last* space instead of last space that fits within width
2. **Cursor room:** Subtracted 1 from wrap widths to prevent cursor char from overflowing to new line
3. **Mid-line cursor visibility:** Changed from zero-width `CURSOR_MARKER` alone to highlighting the character under the cursor (reverse-video) — no text shift
4. **Up/down using all lines:** Changed from windowed `editVisLines` to `editAllVisLines` + absolute index, so up/down works correctly even when lines are scrolled out of view
5. **Boundary findIndex:** Changed `<= dispEnd` to `< dispEnd` so cursor at exact boundary between lines maps to the correct line
6. **Truncation prefix:** First rendered line always shows label; `…` added when lines hidden above or below

## Cleanup Pass
- Extracted `findHardBreakIndex()` helper from duplicated ANSI-scanning logic in `wrapPreservingSpaces`
- Fixed surrogate pair handling in `wrapPreservingSpaces` (skip low surrogate with `si++`)
- Hoisted loop-invariant `isTruncatedTop`/`isTruncatedBottom` outside render loop (fixed indentation bug)
- Removed redundant `contPadWidth` alias (use `totalPrefixVisWidth` directly)
- Made `messageSeparator` package-internal so `confirmSelection` doesn't recompute the default
- Added explicit `public` on mutable state fields accessed from wrapper closure
- Removed dead `handleInput` method from class (Component interface has it optional)
- Split wrapper `handleInput` into `handlePasteInput` / `handleEditInput` / `handleSelectInput`
- Paste handler only buffers in edit mode; outside edit mode, markers are consumed and discarded
- Added `insertSegmentAtCursor()` for inserting paste segments at cursor (splits text segment)
- `insertAtCursor()` kept as inline-merge for plain text (no fragmentation)
- Large pastes now insert at cursor position via `insertSegmentAtCursor` instead of appending
- Added forward delete (Delete key) with `deleteAfterCursor()`
- Extracted `removeSegmentAndMerge()` helper for paste segment removal + adjacent text merge
- Both `deleteBeforeCursor` and `deleteAfterCursor` handle segment boundary peeking
- Removed commented-out debug `ctx.ui.notify` in `tools/bash.ts`

## Cleanup Pass (Session 3)
All input handling moved into `SelectWithMessageComponent`. No more public mutable fields or wrapper closure.
- `wrapPreservingSpaces` + `findHardBreakIndex` moved to `common/text.ts`
- Magic numbers extracted as constants (`HORIZONTAL_PADDING`, `MAX_EDIT_LINES`, `LARGE_PASTE_THRESHOLD`, `ELLIPSIS_VISUAL_WIDTH`)
- `buildEditVisualLines` extracted from `renderEditArea` (visual line building + cursor location)
- `confirmSelection` moved into class
- Component returned directly from `ctx.ui.custom` (no wrapper needed)
- Dead `editVisLines` field removed
- `done` callback uses definite assignment (`!`) instead of `| null`

## Delete Operations
- `deleteBeforeCursor()` — backspace. At text segment boundary (offset 0), peeks at previous segment. Removes paste atomically. Merges adjacent text segments via `removeSegmentAndMerge()`.
- `deleteAfterCursor()` — forward delete (Delete key). At text segment boundary (offset === length), peeks at next segment. Same paste + merge logic.

## Files Changed
- `components/select-with-message.ts` — cursor navigation + cleanup
- `tools/bash.ts` — removed debug line
