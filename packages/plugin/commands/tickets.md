---
description: Show the ticket board, or open and join tickets from the terminal
argument-hint: [what you want to open]
allowed-tools: mcp__session-share__ss_tickets, mcp__session-share__ss_ticket_create, mcp__session-share__ss_ticket_join, mcp__session-share__ss_ticket_start
---

Tickets: **$ARGUMENTS**

With no argument, call `ss_tickets` and show what is on the board: each ticket, its column, who is in it, and how its tasks are going. Say which are theirs.

With an argument, open one with `ss_ticket_create` — first line the title, the rest the brief. Tell them the others have been notified and that it starts splitting as soon as someone joins, or immediately with `ss_ticket_start` if they would rather not wait.

To join one, `ss_ticket_join`. Be clear about what that means: joining is the whole agreement. The split starts, work is assigned across whoever is in, and their agent is expected to claim, work, test and land its own tasks without being asked again. There is nothing further to approve.
