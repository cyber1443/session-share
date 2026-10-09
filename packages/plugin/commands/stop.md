---
description: Stop the coordination server running on this machine
allowed-tools: mcp__session-share__ss_stop_host, mcp__plugin_ss_session-share__ss_stop_host, mcp__session-share__ss_doctor, mcp__plugin_ss_session-share__ss_doctor
---

Stop hosting.

1. Call `ss_stop_host`.
2. Say what that means: everyone loses the session until someone hosts again. Before stopping, the log is saved to the repository's `session-share/log` branch (unless they turned that off in `/ss:setup`), so `/ss:host` on this machine or any other carries on exactly where it stopped -- tickets, tasks, history and usage included. Guests re-join with the new invite and get their own seats back.

The server is normally replaced for you when it needs to be: hosting again after a plugin update restarts it, because a daemon running old code serves an old board. Use this when you want it gone entirely, or when something is wedged and you want a clean start.

`/ss:doctor` shows whether one is running here and which build it is.
