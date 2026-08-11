---
description: Attach this checkout to a session using the code from the board
argument-hint: <ssj_code> [server-url]
allowed-tools: Bash, mcp__session-share__ss_join, mcp__session-share__ss_status
---

Attach this checkout: **$ARGUMENTS**

1. Call `ss_join` with the code. It is single-use, expires in 15 minutes, and already carries the identity of whoever generated it on the board — no login happens here and no GitHub credentials are needed.
2. Call `ss_status` and report the phase, who else is here, and what is claimable.

If they have no code: they sign in at the board, open the session, and press **attach** — that is what produces one.

**One checkout per participant.** If the join is refused because someone else is working in this path, they are sharing a working tree — two agents editing one tree corrupt each other and no lease can prevent it. Tell them to use a separate clone or `git worktree add`.

From this point every Edit and Write in this repo is checked against the session's file leases before it runs.
