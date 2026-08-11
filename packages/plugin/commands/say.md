---
description: Post to the session room without leaving the terminal
argument-hint: <message>
allowed-tools: mcp__session-share__ss_chat_post, mcp__session-share__ss_chat_read
---

Post to the room: **$ARGUMENTS**

Use `ss_chat_post`. Mention a task as `#task-id` to pin the message to its node on the board.

If the message is empty, read the room back instead with `ss_chat_read` and summarise what has been said since it last mattered.
