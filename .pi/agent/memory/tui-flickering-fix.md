---
name: tui-flickering-fix
description: Fix for TUI flickering when permission dialog exceeds terminal height.
---

# TUI Flickering Fix

## Problem
The permission dialog (`selectWithMessage`) flickered when its rendered height exceeded the terminal height, because the entire command text was in the title and could be very long.

## Fix
Rewrote `selectWithMessage` to follow the same class-based `Container`/`Box`/`Text`/`DynamicBorder` pattern as `PagerComponent` and `SelectComponent`:

1. **Separated title from content** — `title` is now a short fixed string ("Allow command?"), command text goes into `contentLines`
2. **Scrollable content area** — `contentLines` are rendered in a `contentBox` capped at `maxContentLines` (default: 10), with `PageUp`/`PageDown` scrolling and a "Showing lines X-Y of Z" indicator
3. **Line numbers** — content lines are prefixed with dim line numbers and a `│` separator (e.g. `  1 │ cat /etc/hostname`)
4. **Selection items always visible** — items render below the scrollable content, never clipped
5. **Class-based component** — `SelectWithMessageComponent` follows the same `initialize(theme)` + `rebuildContent()` pattern as `PagerComponent`/`SelectComponent`

## Follow-up Fix: Long Line Wrapping
When a content line (e.g. a long bash command) exceeds the terminal width, `Text`'s automatic wrapping caused the continuation to appear without a proper line-number prefix, creating visual misalignment with the next line's prefix.

### Fix
In `rebuildContent(width)`, manually wrap each content line using `wrapTextWithAnsi` to fit within the available text content width (`width - 4 - prefixVisWidth`). Wrapped continuation lines get a blank prefix (`    │ `) matching the line number prefix width. This prevents `Text` from wrapping and ensures all visual lines have proper prefixes.

Key calculations:
- Container passes `width` → Box(paddingX=1) gives children `width-2` → Text(paddingX=1) renders content at `width-4`
- Prefix visible width: `lineNumWidth + 3` (e.g. `  1 │ `)
- Text content width: `max(1, width - 4 - lineNumWidth - 3)`

## Follow-up Fix: Clipboard Paste & Feedback Wrapping

### Clipboard Paste in Edit Mode
The inline message editor now supports pasting from the clipboard via terminal bracketed paste mode (`\x1b[200~` / `\x1b[201~`).

- Detects bracketed paste start/end markers in the input stream
- Buffers paste data across potentially fragmented input chunks
- Normalizes line endings (`\r\n` → `\n`) while preserving newlines for multi-line paste
- Only applies paste content when in edit mode; discards otherwise

### Segment-Based Edit Buffer
The edit buffer uses a segment array (`editSegments: EditSegment[]`) instead of a plain string. Segments are either typed text or large pastes:

- `type: "text"` — typed character by character, appended to existing text segment
- `type: "paste"` — large paste (>150 chars or multi-line), shown as a placeholder
  - Multi-line: `[Pasted N lines]`
  - Single-line: `[Pasted N chars]`
- Backspace on a paste segment removes the entire segment
- Backspace on a text segment removes one character, removes segment if empty
- `editBuffer` getter joins all segment contents for the final message
- Display rendering uses `display` field for paste segments instead of raw content

### Feedback Line Wrapping
When the feedback message (edit buffer) is long, it wraps properly across multiple visual lines:

- First line: `→ Label, <start of message>█`
- Continuation lines: aligned under the text start (matching `visibleWidth(prefix) + visibleWidth(labelWithSep)` indent)
- Multi-line paste: newlines in the buffer create separate visual lines
- Uses `visibleWidth()` for all prefix/label width calculations (ANSI codes don't inflate)
- Uses custom `wrapPreservingSpaces()` instead of `wrapTextWithAnsi()` because the latter trims trailing whitespace (making in-progress spaces invisible)
- Cursor marker (`CURSOR_MARKER`) and visual cursor placed at end of last visual line
- Last buffer line wraps with 1 char less to reserve space for the visual cursor character

Key calculations for edit wrapping:
- `contentWidth = width - 4` (Container→Box(padX=1)→Text(padX=1))
- `firstBufWidth = contentWidth - visibleWidth(prefix) - visibleWidth(labelWithSep)`
- `contPadWidth = visibleWidth(prefix) + visibleWidth(labelWithSep)`
- `contLineWidth = contentWidth - contPadWidth`
- Buffer split by `\n` first, then each line wrapped independently

### Edit Area Line Limit (Anti-Flickering)
To prevent the flickering issue from recurring when users type long feedback:

- Edit area capped at 3 visual lines (`maxEditLines = 3`)
- When exceeded, shows the **tail** (most recent text) with the cursor
- First visible line gets the label prefix + `…` to indicate truncation: `→ Yes (sandbox), …<tail text>`
- Continuation lines keep the standard aligned indent
- Prevents the component from growing past terminal height

## Follow-up: Cursor Navigation (see edit-cursor-navigation.md)

Added full cursor navigation in edit mode: ←/→ moves by character (paste segments atomic), ↑/↓ navigates visual lines with desired-column tracking. Insert/delete work at arbitrary cursor positions via segment-aware helpers. Display↔content position mapping handles paste placeholders. Mid-line cursor highlights the character under it (reverse-video). Truncation shows `…` at both top and bottom. See `edit-cursor-navigation.md` for full design.

### Key Fixes During Implementation
- Fixed `wrapPreservingSpaces` — `visPos` was never accumulated, causing wraps at wrong positions
- Subtracted 1 from wrap widths to reserve cursor character space
- Changed up/down navigation to use all visual lines (not windowed) with absolute index
- Fixed boundary cursor position (use `< dispEnd` instead of `<=`) so cursor at line boundary maps correctly
- First rendered line always shows label prefix even when truncated
- `…` shown at bottom of window when lines hidden below

## Files Changed
- `components/select-with-message.ts` — full rewrite with all features
- `.pi/agent/memory/edit-cursor-navigation.md` — cursor navigation design doc
