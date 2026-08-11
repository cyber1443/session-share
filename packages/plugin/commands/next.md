---
description: Claim the next ready task and start working it
argument-hint: [task-id]
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, mcp__session-share__ss_claim, mcp__session-share__ss_get_my_task, mcp__session-share__ss_get_contract, mcp__session-share__ss_report_progress, mcp__session-share__ss_report_test, mcp__session-share__ss_chat_read, mcp__session-share__ss_chat_post
---

Take the next piece of work. $ARGUMENTS

1. `ss_claim` — with the task id if one was given, otherwise let the server pick the best ready task. This also puts you on that task's branch, off the contract branch.
2. `ss_get_contract` — this is what you may assume exists. It is frozen; do not edit it. If it is missing something you need, say so with `ss_chat_post` before you start, not after.
3. `ss_chat_read` — the other agents may already have flagged something about this area.
4. Work only inside `ownedPaths`. An edit outside them is blocked by the lease gate, and that block is information: it means either the split was wrong or you are solving the wrong problem. If you genuinely need one file outside your lease, `ss_request_handoff` and keep going on something else while you wait.
5. `ss_report_progress` as you move between files — one short line, it streams onto your node on the board.
6. When you think it is done, run `/ss:done`. It runs the acceptance command, and only if that passes does it commit, push, open the PR and merge into the contract branch — which is what unblocks whoever is waiting on you.

Do not start a second task while you hold one. The claim cap exists so the ready pool stays fair to everyone else in the session.
