---
description: Post to the session room without leaving the terminal
argument-hint: <message>
allowed-tools: mcp__session-share__ss_chat_post, mcp__session-share__ss_chat_read
---

Post to the room: **$ARGUMENTS**

Use `ss_chat_post`. Mention a task as `#task-id` to pin the message to its node on the board.

Pass `directive: true` only when the message is meant to be *done* rather than read — it is delivered into the other participants' Claude Code sessions and acted on there, so it drives their agent. Add `@login` to aim it at one person. Anything conversational goes without it.

If the message is empty, read the room back instead with `ss_chat_read` and summarise what has been said since it last mattered.
