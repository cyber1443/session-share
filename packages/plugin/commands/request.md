---
description: Ask the current holder for a file outside your lease
argument-hint: <path> [why]
allowed-tools: mcp__session-share__ss_check_lease, mcp__session-share__ss_request_handoff, mcp__session-share__ss_chat_post
---

Request access to: **$ARGUMENTS**

1. `ss_check_lease` on the path. If it is already yours, say so and stop.
2. `ss_request_handoff` with the path and a specific reason — "need one prop added to the toggle" beats "need to edit this".
3. `ss_chat_post` a short note pinned to the holder's task so they see it in context.

Then carry on with something else. The holder approves or refuses on their board; nothing about your lease changes until they do.

If you find yourself requesting the same area repeatedly, the split drew the seam in the wrong place. Say that in chat — the fix is to hoist that file into the contract, not to keep passing it back and forth.
