---
description: Show the session board as text - phase, people, task DAG, blockers
allowed-tools: mcp__session-share__ss_status, mcp__session-share__ss_get_my_task
---

Call `ss_status`, then `ss_get_my_task`.

Report, briefly:
- the phase, and what has to happen for it to advance
- who is here and what each of them is doing
- the task DAG: what is merged, in flight (and by whom), ready, and blocked on what
- your own task, if you hold one

Lead with anything that is stuck. A ready pool that is empty while tasks sit blocked means someone's task is holding up everyone else's.
