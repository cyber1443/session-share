---
description: Sign out of a hosted session-share and host on this machine again
argument-hint: [server address]
allowed-tools: mcp__session-share__ss_logout, mcp__plugin_ss_session-share__ss_logout
---

Call `ss_logout`, passing **$ARGUMENTS** as `serverUrl` if given. The token is revoked on the server too, and `/ss:host` goes back to running a server on this machine.
