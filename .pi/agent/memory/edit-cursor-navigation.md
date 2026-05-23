---
name: edit-cursor-navigation
description: Design and implementation of cursor navigation in the select-with-message edit area.
---

# Edit Cursor Navigation Design

## Cursor Model

**Primary state:** `cursorPos: number` — flat offset into concatenated content string (0 to `getContentLength()`).

Segment-aware operations use helpers to convert flat offset ↔ (segmentIndex, charOffset):
- `getSegmentAtPos(pos)` → `{ segIdx, offset }`
- `getFlatPos(segIdx, offset)` → `number`
- `getContentLength()` — sum of all segment content lengths

## Paste Segments (Atomic Navigation)

Paste segments are atomic — cursor cannot land inside them:
- **moveCursorRight:** increment by 1. If landed in paste, jump to paste end.
- **moveCursorLeft:** decrement by 1. If landed in paste, jump to paste start.
- **Backspace/Delete at paste boundary:** remove entire paste segment.

## Display ↔ Content Mapping

Built in `buildDisplayMapping()`:
- `contentToDisp[contentOffset]` → display offset
- `dispToContent[displayOffset]` → content offset

Paste placeholders cause display ≠ content positions. End-boundary positions are explicitly mapped for both text and paste segments.

## Visual Line Layout

During render (`renderEditArea`):
1. Build display buffer + mapping via `buildDisplayMapping()`
2. Map `cursorPos` → `editCursorDispOff` via `contentToDisp`
3. Split display buffer by `\n`, wrap each line with `wrapPreservingSpaces`
4. Track `EditVisLine { dispStart, dispEnd, text }` for each visual line
5. Find cursor's visual line index (using `< dispEnd` for exclusive end)
6. Apply `MAX_EDIT_LINES` window to keep cursor visible

**Stored on component:**
- `editAllVisLines` — ALL visual lines (for up/down navigation)
- `editCursorVisLineIdx` — absolute index into `editAllVisLines`
- `editDispToContent`, `editCursorDispOff`

## Key Invariant: Cursor Never on Truncated Lines

Window offset is `cursorVisLineIdx - 1`, so the cursor is always at position 1 in the visible window (never the first or last visible line). `MAX_EDIT_LINES` must be >= 3 to guarantee a safe middle line. This eliminates all cursor-on-truncated-line edge cases.

The `…` truncation indicators consume 1 char from the text (front for top, back for bottom) — an accepted tradeoff vs re-wrapping complexity.

## Up/Down Navigation

Uses `editAllVisLines` and `editCursorVisLineIdx` (absolute, not windowed):
1. Get current column: `desiredCol ?? (editCursorDispOff - curVl.dispStart)`
2. Set `desiredCol` to remember column across vertical moves
3. Move to adjacent visual line at `min(targetLine.dispStart + desiredCol, targetLine.dispEnd)`
4. Map display offset back to content offset

**Boundary handling:** Adjacent visual lines share a display offset (`prev.dispEnd == next.dispStart`). The finder uses `< dispEnd` (exclusive), so `moveCursorUp`/`moveCursorDown` step back by 1 when `targetDispOff` lands on `dispEnd` — except on the last visual line where `dispEnd` is valid end-of-buffer.

**Edge cases:** Up on first line → pos 0; Down on last line → end.

## Cursor Rendering

- **End of buffer:** append `CURSOR_MARKER + visualCursor` (reverse-video space)
- **Mid-line:** highlight character *under* cursor with `\x1b[7m${ch}\x1b[27m` — no text shift
- **Empty buffer:** show `CURSOR_MARKER + visualCursor + placeholder`

## Wrap Width

`editLineWidth = contentWidth - totalPrefixVisWidth - 1` — the `-1` reserves room for the cursor character on every visual line.

## Delete Operations
- `deleteBeforeCursor()` — backspace. At text segment boundary (offset 0), peeks at previous segment. Removes paste atomically. Merges adjacent text segments via `removeSegmentAndMerge()`.
- `deleteAfterCursor()` — forward delete. At text segment boundary (offset === length), peeks at next segment. Same paste + merge logic.

## Constants
- `MAX_EDIT_LINES = 3` — max visible edit lines before truncation
- `LARGE_PASTE_THRESHOLD = 150` — char count for placeholder segment
- `ELLIPSIS_VISUAL_WIDTH = 1` — width of `…` truncation indicator
- `HORIZONTAL_PADDING = 4` — total horizontal padding (Container → Box → Text)
