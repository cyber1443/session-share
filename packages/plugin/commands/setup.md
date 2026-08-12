---
description: Choose how session-share is allowed to touch your machine and your repo
allowed-tools: mcp__session-share__ss_settings
---

Walk the user through the choices, then store them with `ss_settings`. $ARGUMENTS

Call `ss_settings` with no arguments first and show them what is currently set. Then ask about each, briefly, and only change what they actually choose:

1. **Autopilot.** The important one. `full` means queued work runs itself when this Claude Code is idle — splitting a ticket, claiming tasks, writing code, running tests, opening PRs — so the only thing anyone has to do is join a ticket. It also means an agent writes to this repository and pushes branches with nobody watching. `splits` limits it to planning, which only ever reads. `off` makes everything wait for them. Say the trade plainly rather than selling it; and mention the daily token ceiling, because unattended spend is the part people do not see coming.
2. **When work gets committed.** `explicit` means nothing is committed until they run `/ss:done`. `auto-on-green` means the agent commits and merges as soon as it reports a passing acceptance test.
3. **Pushing.** On, branches go to `origin`, which is what lets two clones exchange code at all. Off, nothing leaves their machine.
4. **Pull requests.** On, one PR per task plus one for the finished session. Off, branches only.
5. **Hosting reach.** `lan` lets a teammate on the same network connect. `loopback` is this machine only, and needs a tunnel for anyone else.
6. **Opening the board.** On, hosting or joining opens the live board in their browser.
7. **Letting the room drive this agent.** On, a message sent from the board in `run` mode is delivered here and acted on. Off, the room is read-only for them.

The cautious options are not all the defaults: autopilot ships on, because a session that stops whenever someone steps away is the problem this exists to solve. Everything else errs toward doing less.
