---
description: Open the pull request for the finished session
allowed-tools: Bash, mcp__session-share__ss_ship, mcp__plugin_ss_session-share__ss_ship, mcp__session-share__ss_status, mcp__plugin_ss_session-share__ss_status
---

Call `ss_ship`.

It refuses while any task is unmerged, and lists them — that is the point, not an obstacle. If they genuinely want to ship without one, they should say so in chat first so nobody is surprised.

It also refuses unless every ticket on the contract branch passed a run of the assembled thing at exactly the commit being shipped. A failed run, a run from before its work changed, or a run of an earlier commit does not count, and neither does work that belongs to no ticket — a task outside any ticket, or a session from before tickets, has never been run assembled, so it does not ship. When it refuses, say which tickets need running again: check out the contract branch, run it end to end, and report with `ss_ticket_verified`. Do not work around it.

When it succeeds, report the PR number and what it contains: the contract branch with every task merged into it, against the base branch.
