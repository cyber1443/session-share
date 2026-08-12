# session-share

Split one issue across several developers and their Claude Codes, without them colliding.

Each dev keeps their own Claude account, their own quota and their own GitHub identity. **session-share never proxies inference** — it is a coordination layer: it owns the task graph, the file leases, the shared room and the branch each task lands on. Nothing about how you already run Claude Code changes.

## The idea in one screen

1. Anyone writes a **ticket** in the board's Plan column. Everyone else is told it exists and can **join** it. Joining is the only agreement there is — no approval follows.
2. As soon as someone joins, a member's Claude reads the repo and proposes a **contract** — the shared types, schemas and stubs everything else will import — plus tasks that own disjoint file globs and are each provable by one command.
3. A **deterministic validator** rejects the split if two concurrently-runnable tasks own the same path, if it collides with another live ticket, if the graph has a cycle, or if a task has nothing to prove it. An LLM never decides whether two agents are about to collide. A valid split goes live immediately, shared out between whoever joined.
4. Each dev claims a task and gets a **lease** on its paths. A `PreToolUse` hook denies any Edit or Write outside that lease, with the fix in the message. This is what makes two autonomous agents in one repo safe.
5. The cards move themselves. `plan → splitting → building → review → done` follows what the agents have actually done; nothing is draggable, because a column you maintain by hand drifts from the truth the moment anyone is busy.
6. Everyone — humans and agents — shares one durable room, and the board shows the work live. The room is also a terminal: a message sent in **run** mode is delivered into the other participants' Claude Code and acted on there.

## Status

| Phase | | |
|---|---|---|
| **P0** Protocol, event log, WS gateway, reconnect | done | 37 + 28 tests |
| **P1** Decomposition, validation, approval, contract | done | contract lands on its own branch via `/ss:land` |
| **P2** Leases, claim, `PreToolUse` gate, handoff | done | 16 tests, real subprocess |
| **P3** Board: sign-in, sessions, live DAG, room, feed | done | verified in a browser |
| **P4** WebRTC mesh | interface in place (`ActivityTransport`), ws-fanout live | |
| **P5** Branches, PRs, merging back | done | 47 server tests + a two-clone git demo |
| **P6** Final integration PR | done | `/ss:ship` |

## Installing

Your teammate does not clone this repository. They install the plugin, once,
in their own Claude Code:

```
/plugin marketplace add cyber1443/session-share
/plugin install ss@session-share
```

That is the whole install. No `pnpm`, no build, no Node modules — the plugin
ships prebuilt: the coordination server, the MCP tools and the lease-gate hook
are each bundled into a single dependency-free file, with the board vendored
beside them. Claude Code clones the marketplace repo and runs nothing.

Installing it means running prebuilt JavaScript, so you should not have to take
that on trust. CI rebuilds the bundle from source on every change and compares:

- The three executables — the coordination server, the MCP server and the
  lease-gate hook — must reproduce **byte for byte**. These are what actually
  run on your machine, including on every file edit, so any drift fails the
  build. You can check it yourself: `pnpm bundle`, then `git diff` those files.
- The board is a Next.js static export whose chunk filenames embed content
  hashes that differ between macOS and Linux. Byte-equality there would be a
  permanently red check that everyone learns to ignore, so its route set is
  compared instead.

(This is only possible because the server keeps state in `node:sqlite`, which is
built into Node. A native database driver would have meant a compile step on
every machine.)

They still clone **the project you are working on together** — one checkout per
person, which the lease gate depends on. Just not this repo. Both people need
push access to that project repo, since finishing a task pushes a branch.

To try it against something disposable, use
[cyber1443/todo-app-colab](https://github.com/cyber1443/todo-app-colab).

For local development of session-share itself, `pnpm bundle && pnpm attach
/path/to/repo` wires a checkout straight to your working copy instead.

### Releasing

Claude Code installs a plugin into a directory keyed by the version in its
manifest, and skips the download when that version is already installed. So
shipping new code under an old version reaches nobody: `/plugin update` reports
success, the cached copy never changes, and the only symptom is that the fixes
appear not to work — from the far end, indistinguishable from a broken fix.

Both manifests carry the version, and `pnpm check-version` refuses a push that
changes anything under `packages/plugin/` without bumping it. The pre-push hook
runs it before the bundle check.

### Keeping the bundle honest

`packages/plugin/bundle` is committed build output, which means it can fall
behind the source it came from — and the failure lands on whoever installs next,
not on you. So it is checked rather than remembered:

- `pnpm bundle` stamps the bundle with a hash of every source it was built from.
- `pnpm check-bundle` compares that stamp against the working tree.
- A **pre-push hook** runs the same check and refuses to push a stale bundle. It
  rebuilds for you and asks you to commit the result. The check is a hash
  comparison, so pushes with an up-to-date bundle pay nothing.
- The hook installs itself: `pnpm install` sets `core.hooksPath` to `.githooks`.

The export uses a fixed build id, so rebuilding identical sources produces an
identical bundle and no diff noise.

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
       → board opens in the browser, already seated as you

guest  /ss:join ssx_eyJ1Ijoi…
       → same, on their machine
```

Hosting and joining open the board for you and seat it — the plugin has just
joined as you, so making you retype your handle on the page it opened would be
theatre. `/ss:board` reopens it; `/ss:setup` turns the opening off.

If a join fails, the plugin says which of the two things went wrong before it
sends anything: nothing answered at that address, or something answered that is
**not the server that minted the invite**. The second is what happens when a host
was bound to loopback — then `127.0.0.1` inside the invite names the *guest's*
machine, and their own server rejects a token it never signed. Hosting refuses to
hand out that invite silently, and `/ss:doctor` says which address a teammate
should dial.

### The whole loop

Both of you have the repo cloned and are sitting on `main`. Then:

| | |
|---|---|
| `/ss:host Add a dark mode toggle` | starts the server, creates the session, hands you one string to send |
| `/ss:join ssx_…` | your teammate attaches their own clone |
| `/ss:plan add dark mode`, or type the brief on the board | Claude reads the repo and proposes a contract plus tasks; the validator rejects overlaps before anyone sees them |
| move cards, then approve, on the board | the split arrives balanced between you; both approve, or the lead if there are more than three. Each agent is then told what it owns |
| `/ss:land` | creates `ss/<session>/contract` off `main`, commits the contract files, pushes, opens a draft PR. Only now is anything claimable |
| `/ss:next` (each) | you each get a different task, a lease over its files, **and your own branch** off the contract |
| — work — | simultaneously. The lease gate blocks either agent from editing the other's files. The board shows both live |
| `/ss:done` | runs the acceptance test, commits your owned paths, pushes, opens a PR, merges into the contract branch, and unblocks whatever was waiting |
| `/ss:sync` | pulls what your teammate landed |
| `/ss:ship` | opens the PR for the whole session: contract branch → `main` |

Two ways to try that without involving anyone: `pnpm git-flow-demo` drives the
whole loop against a throwaway remote and two clones and prints what happened,
and `pnpm sandbox` sets up the same two clones for you to drive by hand from two
Claude Codes. For the second, run each with `SESSION_SHARE_LOGIN=alice` and
`SESSION_SHARE_LOGIN=bob` — identity comes from `gh`, so without the override
both seats are the same account and the leases can never collide.

What gets committed, whether branches are pushed and whether PRs are opened are
your choices, not defaults baked in here — `/ss:setup` asks once and stores the
answers. The cautious options are the defaults: nothing is committed until you
run `/ss:done`.

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
pnpm e2e         # the whole product, through the real MCP tools, hook and HTTP
pnpm peer-demo   # host + guest + a real daemon, no accounts anywhere
pnpm demo        # the same flow through the hosted (OAuth) path
pnpm test        # 158 tests
```

`pnpm e2e` is the one that matters. It hosts, joins, plans from the board, moves
a card, approves, lands the contract and claims — touching nothing that a user
does not touch: the MCP tools their Claude Code calls, the HTTP the board calls,
and the hook binary that runs between turns. It exists because every unit test
passed while the board's approve button was dead, which is exactly the class of
bug a unit test cannot see.

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

Everything about a ticket lives on its card: click it and the panel shows the
split, who has which task, what each agent is doing right now, test results,
branches and blockers. There is no separate graph or DAG view — they answered
questions the panel answers in the place you were already looking.

### The room is a terminal

The composer has two modes. **say** posts to the room and stops there. **run**
delivers the message into the other participants' Claude Code, where it is acted
on as an instruction — so you can drive a teammate's agent from the board without
either of you touching the other's terminal. `@login` aims it at one person;
without a mention it goes to everyone but you. Agents can do the same from their
side with `ss_chat_post({ directive: true })`, or `/ss:say`.

The modes are explicit and sticky rather than inferred from what you typed. "make
it dark" reads like an instruction and is often just a remark, and guessing wrong
means two agents start editing.

**How delivery actually works, and what it cannot do.** Claude Code cannot be
pushed into from outside, so the plugin pulls at the three moments a hook gets to
speak: when a turn ends (`Stop`, which blocks and hands the agent the message as
its next instruction), when the human types (`UserPromptSubmit`), and at
`SessionStart`. The consequence is worth knowing: **a directive lands when the
recipient's agent finishes its current turn.** If their Claude is sitting idle
with nobody typing, it waits until either of them does something. It is not a
push, and pretending otherwise would be the wrong mental model.

A checkout starts caught up — joining a long-running session does not replay its
whole room at your agent — and each directive is delivered exactly once. Your own
messages never come back to you, `stop_hook_active` stops a delivery from
triggering another, and file leases still apply, so an instruction to edit
someone else's files is refused exactly as if you had typed it yourself. Turn the
whole thing off per machine with `/ss:setup`.

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
| `/ss:setup` | choose what may be committed, pushed and opened on your behalf |
| `/ss:doctor` | check this machine is ready before blaming the session |
| `/ss:land` | create the session branch and commit the approved contract |
| `/ss:done` | finish a task: test, commit, push, PR, merge back |
| `/ss:sync` | pull what teammates have landed |
| `/ss:ship` | open the PR for the finished session |
| `/ss:plan` | decompose an issue into a contract plus tasks |
| `/ss:next` | claim the next ready task and work it |
| `/ss:status` | phase, people, DAG, blockers |
| `/ss:request` | ask the holder for a file outside your lease |
| `/ss:say` | post to the session room, or send it to the other agents |
| `/ss:board` | reopen the live board |
| `/ss:worktree` | a second working tree, so this repo can be in two sessions at once |
| `/ss:tickets` | what is on the board and what is yours |
| `/ss:go` | pick up queued work when a terminal has been sitting idle |
| `/ss:stop` | stop the coordination server on this machine |

### MCP tools

The agent is a participant, not a subject: `ss_claim`, `ss_get_my_task`, `ss_get_contract`, `ss_report_progress`, `ss_check_lease`, `ss_request_handoff`, `ss_report_test`, `ss_propose`, `ss_approve`, and `ss_chat_post` / `ss_chat_read` so one dev's Claude can tell the other's what it just learned *before* it acts on it — with `directive: true` when it should be done rather than read.

## Design notes worth knowing

**Two transports, on purpose.** Task state is low-rate and must be durable and ordered, so it rides a WebSocket over a seq-stamped event log. Agent activity lines, cursors and voice are high-rate and worthless ten seconds later, so they ride a separate ephemeral channel that is never persisted. Today that channel is server fan-out over the same socket; `ActivityTransport` exists so a WebRTC mesh can replace it without anything upstream noticing. A mesh dies around six peers, which is why the seam is there at all.

**The lease gate fails open.** A coordination server that is down must never stop someone editing their own repository. A missed check costs a merge conflict; a false block wedges the session.

**The contract is frozen during build.** Every task was planned against it. Changing the seam mid-flight is how a clean split silently rots, so the gate denies contract edits to everyone, holder included, and points at chat instead.

**Repeated denials are a signal, not an annoyance.** A stream of `lease.denied` events means the decomposition drew the seam in the wrong place. The fix is to hoist that file into the contract, not to keep passing it back and forth.

**Applying an event is idempotent.** A client can legitimately see the same event
twice — a reconnect backlog overlapping live delivery, two sockets in one page —
and appending a chat message twice because of it is a real bug, so the reducer
drops anything at or below the sequence it has already applied.

## Security, plainly

Read this before pointing it at a repository you care about.

**Peer mode does not verify anyone.** Names come from each participant's own
machine (`gh`, falling back to git config) and nothing checks them. The invite
is the credential: whoever holds it is in the room and can call themselves
anything. That is a deliberate trade for two people who can hand each other a
link. Do not put a peer server on a public address.

**Hosting exposes a port on your network.** `/ss:host` binds `0.0.0.0` by
default so a teammate can reach you. Invites are signed, session creation is
restricted to the hosting machine by socket address, and reading anything needs
a token — but the port is open. Use `expose: "loopback"` plus a tunnel on an
untrusted network.

**The lease gate fails open.** If the coordination server is unreachable, edits
proceed unchecked. A missed check costs a merge conflict; a false block wedges a
developer, and that is the worse failure.

**Hooks are bypassable.** A participant can disable the `PreToolUse` gate in
their own settings. The gate prevents accidents between people who agreed to
collaborate; it is not a control against someone who does not want it.

**Authorisation is coarse.** In hosted mode any signed-in user can read or join
any session on that server. Authentication is real; per-session membership rules
are not built.

**No secrets are collected.** Your Claude credentials are never involved —
inference is never proxied. In hosted mode the OAuth App requests `read:user`
only, and never gains write access to a repository.

## Not done yet

- **CI status is not read.** `/ss:done` runs the acceptance command locally and merges on that; it does not wait for checks on the PR.
- **Merging is first-come, not queued.** Two people finishing at once both merge into the contract branch; git handles it because their files are disjoint, but there is no serialisation and no automatic conflict resolution.
- The WebRTC mesh (P4). Agent activity lines already stream over `ws-fanout`, and they are ephemeral by design — reload the board and they are gone until the next one arrives.
- Authorization is coarse: any signed-in user can read and join any session. Authentication is real; per-session membership rules are not.
- Assignment is not enforced. `/ss:next` prefers your own tasks, but someone can still claim a task assigned to another person rather than sit idle. That is deliberate; if it turns out to be wrong, the fix is a rule, not a lock.
- Room directives are delivered on a hook, not pushed: they land when the recipient's agent finishes a turn. An agent sitting idle with nobody typing will not pick one up until something else wakes it.
