---
description: Pick up whatever the session has queued for you and do it
allowed-tools: mcp__session-share__ss_inbox, mcp__session-share__ss_tickets, mcp__session-share__ss_claim, mcp__session-share__ss_propose, mcp__session-share__ss_chat_post, Read, Grep, Glob, Bash, Edit, Write
---

Take the queued work.

1. Call `ss_inbox`. It returns whatever the room has addressed to you — a ticket to split, tasks to claim, a PR to open — and hands it over exactly once.
2. Do what it says, now, without asking for confirmation. That is what joining the ticket agreed to.
3. If it says nothing is waiting, call `ss_tickets` and report where things stand instead.

Why this exists: instructions from the room normally arrive by themselves when a turn ends. An idle Claude Code has no turn ending, so a session that starts while you are away sits still until something wakes it. This is the wake.
