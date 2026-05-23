---
name: testing
description: How to test the pi-bash-sandbox extension locally.
---

# Testing pi-bash-sandbox

## Quick Test Command
Run `cat /etc/hostname` — this should always trigger the permission prompt ("ask" permission level), making it ideal for testing the `selectWithMessage` UI.

## Build & Link
The extension is loaded by pi from this directory. Ensure it compiles cleanly with `npx tsc --noEmit`.

## Key UI Features to Verify
- Permission dialog renders without flickering
- Long commands wrap with proper line-number prefixes in the content area
- PgUp/PgDn scrolls the content area
- Tab enters edit mode (inline message/feedback)
- **Clipboard paste**: Ctrl+V / Cmd+V while in edit mode should insert clipboard content via bracketed paste
- **Feedback wrapping**: type or paste a long message and verify it wraps across multiple visual lines with proper indentation
- Enter confirms selection, Escape cancels
