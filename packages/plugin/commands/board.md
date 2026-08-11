---
description: Open the live board for this session in the browser
allowed-tools: mcp__session-share__ss_board, mcp__session-share__ss_status
---

Open the board.

1. Call `ss_board`. It mints a fresh link for the session this checkout is attached to and opens it in the default browser.
2. If nothing opens — a headless machine, or `SESSION_SHARE_NO_OPEN=1` — the tool returns the URL; give it to them to paste.

`/ss:host` and `/ss:join` already open the board. This is for getting it back after closing the tab.
