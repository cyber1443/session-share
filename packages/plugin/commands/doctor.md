---
description: Check this machine is ready for a real session, before blaming the session
allowed-tools: Bash, mcp__session-share__ss_doctor
---

Call `ss_doctor` and report what it says.

Lead with anything that would stop a session working, in this order:

1. **Identity from `gh`.** If it says git or system, `gh auth login` first — otherwise both machines may appear under the same name, and two people the server thinks are one person can never collide.
2. **origin reachable.** Without it, branches never leave the machine and the other person sees nothing.
3. **Reach.** If hosting is loopback-only, a teammate on another laptop cannot connect at all. If it reports the invite address no longer matches this machine's address, the network changed — re-host and send a fresh invite.
4. **Session attached** and the server answering.

If they are hosting and the other machine cannot connect, the usual causes in order: the two machines are not on the same network, the host bound loopback, or the host's firewall is blocking incoming connections on the port. On macOS that is System Settings → Network → Firewall, which will also prompt the first time.
