---
description: Sign this machine in to a hosted session-share so sessions run there, not on your laptop
argument-hint: <server address>
allowed-tools: mcp__session-share__ss_login, mcp__plugin_ss_session-share__ss_login
---

Sign in to: **$ARGUMENTS**

1. Call `ss_login` with that address as `serverUrl` (omit it if no argument was given). It opens a browser page; the person signs in with GitHub and approves the code shown.
2. If it returns a code to approve, show the code and the link, and tell them to run `/ss:login` again once approved.
3. Once signed in, `/ss:host` opens sessions on that server instead of this machine. The session keeps going when this machine sleeps, and teammates join with the invite plus their own `/ss:login`.

What the server allows (how many sessions, how many people) depends on the account's plan there; a refusal from `/ss:host` or `/ss:join` says which limit was hit and where to change it. Show it as is.
