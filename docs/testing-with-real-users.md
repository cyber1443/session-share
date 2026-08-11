# Testing with real GitHub accounts and real Claude Codes

Two developers, two GitHub accounts, two Claude subscriptions, one issue. Nobody
shares credentials with anyone, including with session-share.

Claude never enters this setup as an identity. There is no "log in with Claude"
to configure: Anthropic exposes no OAuth provider for third-party apps, and this
design deliberately never wants your Claude credentials. Each developer runs
their own Claude Code, signed in as themselves, spending their own quota. The
only thing that has to be shared is the coordination server.

---

## 1. One person hosts the coordination server

Everyone talks to one server. Pick whoever is hosting and decide how the other
person reaches them.

**Same machine (fastest way to try it).** Both Claude Codes and the board run on
one laptop, in two different clones. Nothing else to set up — skip to step 2 with
`http://127.0.0.1:4310`.

**Two machines.** The second developer needs a URL that resolves to the host.
Any of these work:

| | |
|---|---|
| Same office network | `http://<host-lan-ip>:4310`, bind with `HOST=0.0.0.0` |
| Tailscale | `http://<host>.ts.net:4310` — no ports opened to the internet |
| cloudflared / ngrok | a public HTTPS URL, easiest for GitHub OAuth |

Whichever you pick, that URL is `SESSION_SHARE_URL` for the web app and the
`serverUrl` the plugin uses.

---

## 2. Register a GitHub OAuth App

This is what makes sign-in real. One person does it once, for the team.

1. GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App.
2. **Homepage URL**: wherever the board runs, e.g. `http://127.0.0.1:3000`.
3. **Authorization callback URL**: the same origin plus
   `/auth/github/callback` — e.g. `http://127.0.0.1:3000/auth/github/callback`.
   It must match exactly, including the port.
4. Generate a client secret.

The app only requests `read:user`. It reads your handle, name and avatar; it
never gains write access to any repository. Repository automation is a separate
GitHub App and is not built yet (P5) — today all git work happens locally under
each developer's own credentials.

Start the server with them:

```bash
GITHUB_CLIENT_ID=Iv1.xxxxxxxx \
GITHUB_CLIENT_SECRET=xxxxxxxxxxxx \
GITHUB_CALLBACK_URL=http://127.0.0.1:3000/auth/github/callback \
SESSION_SHARE_SECRET=$(openssl rand -hex 32) \
pnpm server
```

Keep `SESSION_SHARE_SECRET` stable — it signs cookies and participant tokens, so
changing it signs everyone out and invalidates every attached checkout. Do not
set `SESSION_SHARE_DEV_LOGIN` here; it is loopback-only and has no place in a
run with real accounts.

Then the board, pointed at that server:

```bash
SESSION_SHARE_URL=http://127.0.0.1:4310 pnpm --filter @session-share/web dev
```

---

## 3. Each developer prepares their own checkout

**Separate clones. This is not optional.** Two Claude Codes in one working tree
overwrite each other's edits, and no lease can prevent it because they are the
same filesystem. The server refuses the second attach, but only if the paths
actually differ.

```bash
# developer A
git clone git@github.com:acme/web.git ~/work/web-alice

# developer B
git clone git@github.com:acme/web.git ~/work/web-bob
```

A `git worktree` off one clone works too, as long as each person gets their own
directory.

Then wire each checkout up — once per clone:

```bash
cd ~/path/to/session-share
pnpm build
pnpm attach ~/work/web-alice
```

That merges three things into the target repo: the MCP server into `.mcp.json`,
the `PreToolUse` lease gate into `.claude/settings.json`, and the `/ss:*`
commands into `.claude/commands/ss/`. It is additive and idempotent — existing
hooks and MCP servers are preserved — so it is safe on a repo you already use.

If the coordination server is not on `127.0.0.1:4310`, tell the plugin where it
is by setting `SESSION_SHARE_URL` in the environment Claude Code runs in.

---

## 4. Sign in and attach

1. Both developers open the board and press **Continue with GitHub**. Each signs
   in as themselves; this is where identity comes from.
2. One of them creates the session: repo, title, and the issue link.
3. Each developer opens that session and presses **attach**. They get a
   one-time code and run it in Claude Code, inside their own clone:

   ```
   /ss:join ssj_xxxxxxxxxxxxxxxxxxxxxxxx
   ```

   The code is single-use and expires in 15 minutes, so the copy left in shell
   history is inert within the hour. What it exchanges for — a long-lived
   participant token — is written to `.session-share/session.json` and never
   passes through a terminal.

From that moment every `Edit` and `Write` in that checkout is checked against
the session's file leases before it runs.

---

## 5. Run the actual session

In one developer's Claude Code:

```
/ss:plan https://github.com/acme/web/issues/42
```

Their Claude reads the repo and proposes a contract plus a set of tasks. The
server validates it deterministically — overlapping paths, dependency cycles,
tasks with no test, tasks owning contract files — and hands back repair hints if
it fails. Watch the board: the split appears for approval.

Both approve, then commit the contract branch (today this is still manual —
see the gap below). Once it lands, the phase flips to build, and each developer
runs:

```
/ss:next
```

Each is handed a different task with a lease over its paths. Now try the thing
worth testing: **ask one Claude to edit a file the other owns.** It should be
denied with the other person's name, the task holding it, and the
`/ss:request` command to ask for it. That denial is the product.

Also worth exercising:

- `/ss:say` and the board's chat — including a Claude posting to it, which is
  what stops the second agent building on a wrong assumption.
- Requesting a handoff and granting it from the board; only that one path opens.
- Killing the coordination server mid-session. Editing keeps working. The gate
  fails open on purpose: a missed check costs a merge conflict, a false block
  wedges a person.

---

## What will not work yet

Be prepared for these, so they read as known gaps rather than bugs:

- **The server does not touch git.** It records the contract branch, task
  branches and PR numbers, but does not create them. Someone has to commit the
  contract branch and push task branches by hand.
- **No merge queue** (P5). Tasks reach `pr` and stop there; nothing reaches
  `merged`, so dependent tasks stay blocked. A session runs cleanly up to "all
  tasks green" and then needs a human to integrate.
- **Authorization is coarse.** Authentication is real, but any signed-in user
  can read or join any session on that server. Fine for one team on a private
  network; not fine on a public URL.
- **No TURN server.** Not relevant yet — agent activity currently streams over
  the WebSocket, not WebRTC.

## If something goes wrong

| Symptom | Cause |
|---|---|
| "That join code is expired or has already been used" | Codes are single-use and last 15 minutes. Press **attach** again. |
| Join refused, mentions a worktree | Two people pointed at the same directory. Give each their own clone. |
| GitHub returns a redirect_uri mismatch | The callback URL in the OAuth App must match `GITHUB_CALLBACK_URL` exactly, port included. |
| Everyone signed out after a restart | `SESSION_SHARE_SECRET` was not set, so a random one was generated at boot. |
| Board says "reconnecting" | It retries with backoff and replays what it missed; if it persists, the server is unreachable from the browser. |
| The lease gate never blocks anything | That checkout is not attached — no `.session-share/session.json`. Re-run `/ss:join`. |
