---
description: Host a session from this machine and get one link to send your teammate
argument-hint: <what you are building>
allowed-tools: Bash, mcp__session-share__ss_host, mcp__session-share__ss_status
---

Host a session for: **$ARGUMENTS**

1. Call `ss_host` with that as the title. Pass `issueRef` if the argument is or contains an issue URL. It starts a coordination server on this machine if one is not already running, creates the session for this repository, and attaches this checkout.
2. Show them the `/ss:join ssx_…` line to send, and the board URL. One string carries both the address and the invite.

Tell them plainly what is now exposed: with the default `expose: "lan"` the server listens on their local network, and anyone holding the invite can join. Nobody without it can. If they are on an untrusted network, re-run with `expose: "loopback"` and use a tunnel.

If their teammate is on a different network, the LAN address will not reach them. `cloudflared tunnel --url http://127.0.0.1:4310` (or Tailscale) gives a URL that does; the invite has to be re-minted against that address, so pass it as the server URL when hosting.

Identity here comes from their own machine — `gh` if authenticated, otherwise git config. Nothing verifies it. In a peer session the invite is the credential, which is the right trade for two people who can hand each other a link and the wrong one for a public server.
