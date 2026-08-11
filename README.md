# session-share

Split one issue across several developers and their Claude Codes, without them colliding.

Each dev keeps their own Claude account, their own quota and their own GitHub identity. **session-share never proxies inference** — it is a coordination layer: it owns the task graph, the file leases, the shared room and (later) the merge queue. Nothing about how you already run Claude Code changes.

## The idea in one screen

1. One dev runs `/ss:plan <issue>`. Their Claude reads the repo and proposes a **contract** — the shared types, schemas and stubs everything else will import — plus a set of tasks, each owning a disjoint set of file globs and each provable by one command.
2. A **deterministic validator** rejects the split if two concurrently-runnable tasks own the same path, if the graph has a cycle, if a task has nothing to prove it, or if a task tries to own a contract file. An LLM never decides whether two agents are about to collide.
3. The team approves. The contract lands on its own branch. Only then do tasks become claimable.
4. Each dev claims a task and gets a **lease** on its paths. A `PreToolUse` hook denies any Edit or Write outside that lease, with the fix in the message. This is what makes two autonomous agents in one repo safe.
5. Everyone — humans and agents — shares one durable room, and the board shows the DAG live.

## Status

| Phase | | |
|---|---|---|
| **P0** Protocol, event log, WS gateway, reconnect | done | 37 + 28 tests |
| **P1** Decomposition, validation, approval, contract | done | server-side; git commit of the contract still to wire |
| **P2** Leases, claim, `PreToolUse` gate, handoff | done | 16 tests, real subprocess |
| **P3** Board: sign-in, sessions, live DAG, room, feed | done | verified in a browser |
| **P4** WebRTC mesh | interface in place (`ActivityTransport`), ws-fanout live | |
| **P5** GitHub App, PRs, merge queue | not started | |
| **P6** Final integration PR | not started | |

## Two ways to run it

**Peer** is the default and needs no setup at all. One person runs `/ss:host`;
a coordination server starts on their machine as a side effect and they get a
single string to send. The other person pastes it into `/ss:join`. No OAuth App,
no second process, no account anywhere. Identity comes from each person's own
machine (`gh`, falling back to git config) and **nothing verifies it** — the
invite is the credential, which is the right trade for two people who can hand
each other a link and the wrong one for a public URL.

```
host   /ss:host Add a dark mode toggle
       → send: /ss:join ssx_eyJ1Ijoi…
       → board: http://192.168.0.36:4310/board/?join=ssx_…

guest  /ss:join ssx_eyJ1Ijoi…
```

The guest has to be able to reach the host: same network works out of the box,
different networks need a tunnel (`cloudflared tunnel --url http://127.0.0.1:4310`
or Tailscale). The host machine has to stay awake — it is the server.

**Hosted** is for a team that wants verified identity and a server that outlives
any one laptop: register a GitHub OAuth App, run the server somewhere, and
people sign in properly. Set `GITHUB_CLIENT_ID` and the server switches to it.

Everything below the auth layer — the split, the leases, the board, the room —
is identical in both.

## Signing in, and attaching a checkout

These are two different things, and conflating them is what made the early
version painful to use.

**Who you are** is GitHub OAuth in the browser. There is deliberately no "log in
with Claude": Anthropic exposes no OAuth provider for it, and session-share
never wants your Claude credentials — each dev's Claude Code stays local with
its own auth and its own quota.

**Which checkout is yours** is a pairing step. On the board you press *attach*
and get a one-time code; you paste `/ss:join ssj_…` into Claude Code in the clone
you want to work in. The code is single-use and expires in 15 minutes, so the
copy it leaves in your shell history is inert. What it exchanges for — a
long-lived participant token — is written to `.session-share/session.json` and
never passes through a terminal.

A participant is a person, not a checkout. You can watch, chat and approve from
the board with nothing attached; attaching is what turns the lease gate on for a
particular working tree.

For a real run with two GitHub accounts and two Claude subscriptions, follow
[docs/testing-with-real-users.md](docs/testing-with-real-users.md).

### Configuring GitHub sign-in

Register an OAuth App with callback `http://127.0.0.1:3000/auth/github/callback`,
then start the server with:

```bash
GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... SESSION_SHARE_SECRET=<random> pnpm server
```

`SESSION_SHARE_SECRET` signs cookies and tokens — set it to something stable, or
every restart signs everyone out.

Before you have an OAuth App, `SESSION_SHARE_DEV_LOGIN=1` enables a local
sign-in that takes any handle. It is refused unless the request arrives over
loopback, and it should never be set on a deployed server.

## Layout

```
packages/protocol/  zod schemas + types shared by everything, the glob-overlap
                    engine, and the decomposition validator
packages/server/    Fastify + ws. Append-only event log over node:sqlite;
                    tasks, leases, chat and presence are projections folded
                    from that log
packages/plugin/    Claude Code plugin: MCP tools, the PreToolUse lease gate,
                    and the /ss:* slash commands
```

Only two tables are persisted: a `sessions` index and the append-only `events` log. Everything else is derived, so a replay bug cannot produce a state the log disagrees with — there is a test that folds the log from scratch and asserts it matches the live projection.

## Try it

```bash
pnpm install
pnpm peer-demo   # host + guest + a real daemon, no accounts anywhere
pnpm demo        # the same flow through the hosted (OAuth) path
pnpm test        # 94 tests
```

`pnpm demo` runs a real server, two real participants and the real hook binary as
a subprocess. It walks a sloppy split being rejected, the repaired split being
approved, both devs claiming different tasks, one agent being denied an edit into
the other's task, a handoff opening exactly one file, the shared room, and the
DAG advancing when a task passes its acceptance command.

### The board

```bash
pnpm build
SESSION_SHARE_DEV_LOGIN=1 SESSION_SHARE_SECRET=dev pnpm server   # :4310
pnpm --filter @session-share/web dev                             # :3000
```

Open <http://localhost:3000>. Everything the browser touches is proxied to the
coordination server, so it is one origin — no CORS, and the OAuth callback lands
where it should.

The board shows the same tasks two ways:

- **Topics** — a force-directed knowledge graph. A hub per area of the codebase,
  tasks orbiting the hub they belong to, and the contract files in the middle
  with dotted links to every task that assumes them, so the seam is visibly the
  centre of the work. Hovering isolates a neighbourhood; nodes drag, the canvas
  pans and zooms. Ring colour is the topic, fill is the task state.
- **Order** — the dependency DAG, left to right by depth, which answers the
  different question of what unblocks what.

Topics are derived from the paths a task owns rather than from labels anyone has
to maintain: tasks are cut as vertical slices, so the folder structure already
says what they are about.

### With your own Claude Code

```bash
pnpm attach /path/to/your/repo   # merges MCP server, lease gate and /ss:* commands
```

`attach` is additive and idempotent — existing hooks and MCP servers are merged,
not replaced. Run it once per checkout, then press *attach* on the board and
paste the `/ss:join ssj_…` it gives you into Claude Code in that checkout.

## Run it

```bash
pnpm --filter @session-share/server start     # http://127.0.0.1:4310, ws at /ws
```

### Two devs, one repo

Each participant needs **their own clone or `git worktree`**. Two Claude Codes in one working tree corrupt each other's edits and no lease can prevent it — the server refuses the join.

Install the plugin (from `packages/plugin`), then in each checkout:

```
/ss:join <session-slug> [server-url]
```

Then, on one machine:

```
/ss:plan https://github.com/acme/web/issues/42
```

and once the split is approved and the contract has landed, on every machine:

```
/ss:next
```

### Slash commands

| | |
|---|---|
| `/ss:host` | start hosting from this machine, get one string to send |
| `/ss:join` | attach this checkout to a session |
| `/ss:plan` | decompose an issue into a contract plus tasks |
| `/ss:next` | claim the next ready task and work it |
| `/ss:status` | phase, people, DAG, blockers |
| `/ss:request` | ask the holder for a file outside your lease |
| `/ss:say` | post to the session room |

### MCP tools

The agent is a participant, not a subject: `ss_claim`, `ss_get_my_task`, `ss_get_contract`, `ss_report_progress`, `ss_check_lease`, `ss_request_handoff`, `ss_report_test`, `ss_propose`, `ss_approve`, and `ss_chat_post` / `ss_chat_read` so one dev's Claude can tell the other's what it just learned *before* it acts on it.

## Design notes worth knowing

**Two transports, on purpose.** Task state is low-rate and must be durable and ordered, so it rides a WebSocket over a seq-stamped event log. Agent activity lines, cursors and voice are high-rate and worthless ten seconds later, so they ride a separate ephemeral channel that is never persisted. Today that channel is server fan-out over the same socket; `ActivityTransport` exists so a WebRTC mesh can replace it without anything upstream noticing. A mesh dies around six peers, which is why the seam is there at all.

**The lease gate fails open.** A coordination server that is down must never stop someone editing their own repository. A missed check costs a merge conflict; a false block wedges the session.

**The contract is frozen during build.** Every task was planned against it. Changing the seam mid-flight is how a clean split silently rots, so the gate denies contract edits to everyone, holder included, and points at chat instead.

**Repeated denials are a signal, not an annoyance.** A stream of `lease.denied` events means the decomposition drew the seam in the wrong place. The fix is to hoist that file into the contract, not to keep passing it back and forth.

**Applying an event is idempotent.** A client can legitimately see the same event
twice — a reconnect backlog overlapping live delivery, two sockets in one page —
and appending a chat message twice because of it is a real bug, so the reducer
drops anything at or below the sequence it has already applied.

## Not done yet

- Git: the contract branch commit and task branches are recorded by the server but not yet performed by it.
- GitHub App, CI status, the serial merge queue and `/ss:resolve` (P5).
- The WebRTC mesh (P4). Agent activity lines already stream over `ws-fanout`, and they are ephemeral by design — reload the board and they are gone until the next one arrives.
- Authorization is coarse: any signed-in user can read and join any session. Authentication is real; per-session membership rules are not.
