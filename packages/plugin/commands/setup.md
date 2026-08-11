---
description: Choose how session-share is allowed to touch your machine and your repo
allowed-tools: mcp__session-share__ss_settings
---

Walk the user through the choices, then store them with `ss_settings`. $ARGUMENTS

Call `ss_settings` with no arguments first and show them what is currently set. Then ask about each, briefly, and only change what they actually choose:

1. **When work gets committed.** `explicit` means nothing is committed until they run `/ss:done`. `auto-on-green` means the agent commits and merges as soon as it reports a passing acceptance test — less typing, but code lands in their repo on an agent's judgement about whether the tests really passed.
2. **Pushing.** On, branches go to `origin`, which is what lets two clones exchange code at all. Off, nothing leaves their machine and they sync by hand.
3. **Pull requests.** On, one PR per task plus one for the finished session. Off, branches only.
4. **Hosting reach.** `lan` lets a teammate on the same network connect and opens a port on it. `loopback` is this machine only, and needs a tunnel for anyone else.
5. **Opening the board.** On, hosting or joining opens the live board in their browser. Off, they get the URL.
6. **Letting the room drive this agent.** On, a message sent from the board in `run` mode is delivered into this Claude Code and acted on — that is what makes the room a shared terminal rather than a chat window. Off, the room is read-only here: they still see everything, but nothing anyone types reaches their agent.

Tell them the defaults are the cautious ones — explicit commits, and hosting bound to the LAN only because a session with nobody able to join is useless. They can change any of this later with `/ss:setup`.
