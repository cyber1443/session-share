---
description: Attach this checkout to a session using the invite you were sent
argument-hint: <ssx_ invite or ssj_ code>
allowed-tools: Bash, mcp__session-share__ss_join, mcp__session-share__ss_status
---

Attach this checkout: **$ARGUMENTS**

1. Call `ss_join` with the string. An `ssx_` invite carries the address and the credential together — nothing else is needed. An `ssj_` code comes from a hosted board and may need `serverUrl`.
2. Call `ss_status` and report the phase, who else is here, and what is claimable.
3. Give them the board URL that `ss_join` returns.

**One checkout per person.** If the join is refused because someone else is working in this path, two Claude Codes are sharing a working tree — they will overwrite each other and no lease can prevent it. Use a separate clone or `git worktree add`.

From this point every Edit and Write in this repo is checked against the session's file leases before it runs.
