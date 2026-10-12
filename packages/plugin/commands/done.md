---
description: Finish the task you hold - commit, push, PR, and merge it into the contract
argument-hint: [what you did]
allowed-tools: Bash, Read, mcp__session-share__ss_get_my_task, mcp__plugin_ss_session-share__ss_get_my_task, mcp__session-share__ss_report_test, mcp__plugin_ss_session-share__ss_report_test, mcp__session-share__ss_done, mcp__plugin_ss_session-share__ss_done, mcp__session-share__ss_chat_post, mcp__plugin_ss_session-share__ss_chat_post
---

Finish the current task. $ARGUMENTS

1. `ss_get_my_task` for the acceptance command, then **run it**. Do not skip this: a task is done when the command that proves it passes, not when the code looks right.
2. Report the outcome with `ss_report_test`. If it failed, stop here and fix it — you keep the lease.
3. `ss_done` with a Conventional Commit summary (`<type>(<task-id>): <subject>`). If the work is more than one logical change, pass `commits` -- one `{ message, paths }` per atomic change, in order; anything left over goes in a final commit from the summary. It then pushes, opens a PR, and merges into the contract branch.
4. Report what it unblocked, and take the next task with `/ss:next` if there is one.

If the merge conflicts, it aborts cleanly and puts you back on your branch. Two tasks touching the same file means the split drew the seam in the wrong place — say so in chat with `ss_chat_post` before resolving it by hand, because the same collision will happen again otherwise.
