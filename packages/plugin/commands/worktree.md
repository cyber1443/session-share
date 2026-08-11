---
description: Make a second working tree so this repo can be in two sessions at once
argument-hint: <what the other session is for>
allowed-tools: mcp__session-share__ss_worktree
---

Set up a parallel session for: **$ARGUMENTS**

1. Call `ss_worktree` with that as the title. Pass `invite` if they are joining a session someone else hosts rather than starting one.
2. Give them the directory it returns and the exact command to run there.

Explain what this is for: one Claude Code lives in one directory, so a second concurrent session needs a second directory. A worktree is that, sharing this clone's history, remote and object store — not a second clone.

They open a **new** Claude Code in that directory and run `/ss:host` or `/ss:join` there. This session keeps running untouched; the two share one coordination server on this machine.

Remove it when the work lands: `git worktree remove <path>`.
