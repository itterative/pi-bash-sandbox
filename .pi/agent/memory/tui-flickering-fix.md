---
name: tui-flickering-fix
description: Fix for TUI flickering when permission dialog exceeds terminal height.
---

# TUI Flickering Fix

## Problem
The permission dialog (`selectWithMessage`) flickered when its rendered height exceeded the terminal height, because the entire command text was in the title and could be very long.

## Architecture

`SelectWithMessageComponent` follows the same class-based `Container`/`Box`/`Text`/`DynamicBorder` pattern as `PagerComponent` and `SelectComponent`:

1. **Title** — short fixed string, always visible
2. **Scrollable content area** — `contentLines` rendered in a `contentBox` capped at `maxContentLines` (default: 10), with `PageUp`/`PageDown` scrolling and "Showing lines X-Y of Z" indicator
3. **Line numbers** — content lines prefixed with dim line numbers and `│` separator
4. **Selection items** — always visible below the scrollable content, never clipped
5. **Help text** — context-sensitive (select mode vs edit mode)

## Content Area Wrapping

Long lines are manually wrapped using `wrapTextWithAnsi` to fit within `width - HORIZONTAL_PADDING - prefixVisWidth`. Wrapped continuations get a blank prefix matching the line number width. This prevents `Text` from auto-wrapping and ensures all visual lines have proper prefixes.

## Edit Area (Inline Message)

### Segment-Based Buffer
`editSegments: EditSegment[]` — either typed text or large pastes:
- `type: "text"` — typed character by character, merged into adjacent text segments
- `type: "paste"` — large paste (>150 chars or multi-line), shown as placeholder
  - Multi-line: `[Pasted N lines]`
  - Single-line: `[Pasted N chars]`

### Clipboard Paste
Supports terminal bracketed paste mode (`\x1b[200~` / `\x1b[201~`):
- Buffers paste data across fragmented input chunks
- Normalizes line endings (`\r\n` → `\n`)
- Only applies in edit mode; discards otherwise

### Line Limit (Anti-Flickering)
Edit area capped at `MAX_EDIT_LINES` (3) visual lines. Window offset ensures cursor is never on a truncated line (see `edit-cursor-navigation.md`).

### Wrapping
Uses `wrapPreservingSpaces()` (from `common/text.ts`) instead of `wrapTextWithAnsi()` because the latter trims trailing whitespace, making in-progress spaces invisible.

## Cursor Navigation

Full cursor navigation in edit mode: ←/→ by character, ↑/↓ by visual line with desired-column tracking. Display↔content mapping handles paste placeholders. See `edit-cursor-navigation.md` for full design.

## Files
- `components/select-with-message.ts` — the component
- `common/text.ts` — `wrapPreservingSpaces`, `findHardBreakIndex`
