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

If the contract branch has moved under the task, it is left untouched and the contract is merged into **your task branch** instead, uncommitted. If git merged it cleanly, `ss_done` carries on by itself: it runs the acceptance command on that exact tree, commits the merge only if it passes, and lands it. If it fails there, nothing is committed or landed and the merge stays in progress: fix your own files and call `ss_done` again. The same goes for whatever lands on origin while it is pushing. Once a tested commit exists, nothing edited after the run is committed with it: change a file then and `ss_done` stops to test it first. If it conflicts, the conflicts are waiting in the files, and resolving them is yours — straight away, without asking anyone:

1. Read both sides of each conflicted file and make them fit so both intents survive. Never take one side wholesale (`--ours`/`--theirs`) to make it go away.
2. Change only the conflicted files and your own task's files. Do not commit, merge or reset yourself.
3. Call `ss_done` again. It refuses while markers remain or anything else changed, then runs the acceptance command itself on exactly the resolved tree. If it passes and the run changed nothing, it commits that tree as the merge and lands it. If it fails, nothing is committed and your edits stay: fix them and call `ss_done` again. `force` and earlier test reports do not count here.

It is bounded: 5 failed attempts in one round, or the contract moving under it 3 rounds running, and it stops. It also stops on anything unsafe, like the merge being taken apart by hand. Stopping undoes nothing — the merge stays as it was and every uncommitted edit is also kept under a `refs/session-share/...` ref — and the room is told. If you cannot tell how the two sides should fit, stop it yourself with `integration: "abort"`: your edits are kept under that ref first, then the merge is undone.

Once stopped, stop. `integration: "retry"` only works after a person has written in the room about the task since it stopped, and that is their call: do not ask for it or post for them. Two tasks touching the same file usually means the seam is in the wrong place — say so in chat with `ss_chat_post`.
