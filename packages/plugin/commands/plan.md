---
description: Split a GitHub issue into a contract plus standalone, testable tasks for everyone in the session
argument-hint: <issue-url-or-description>
allowed-tools: Read, Grep, Glob, Bash, mcp__session-share__ss_status, mcp__session-share__ss_chat_post
---

Decompose this work so several developers and their agents can attack it in parallel without colliding: **$ARGUMENTS**

Call `ss_status` first to see who is in the session — the split has to keep all of them busy.

## How to split

Read the repo before proposing anything. The split is judged on whether each piece is genuinely standalone and genuinely provable, not on how evenly sized the pieces are.

**First, find the seam.** Everything two tasks would both need to touch — shared types, API and zod schemas, component prop interfaces, route stubs, empty modules with real signatures, test fixtures — goes into a *contract* that is committed before anyone starts. The contract is what makes the tasks independent. If you cannot find a seam, the work does not parallelise, and saying so is a better answer than inventing one.

**Then cut vertical slices behind that seam.** Rules, in priority order:

1. **One command must prove each task.** Name a command that fails now and passes when the task is done, and name the test file it runs. No test, no task.
2. **No two tasks that can run at the same time may own the same path.** If they must, that shared part belongs in the contract instead.
3. **Prefer adding files to editing them.** New files never conflict.
4. **30–90 minutes each.** Bigger, split it. Smaller, fold it into a sibling.
5. **State what each task may assume** — and it may only assume what the contract provides.
6. **Aim for a ready-frontier at least as wide as the team**, so nobody idles at the start.

Slice by feature, never by layer. "Toggle component + its test" is a task. "All the components" is not.

## Then propose it

Call the `ss_propose` MCP tool with the contract and the tasks. The server validates it deterministically — overlapping paths, dependency cycles, missing tests, tasks owning contract files — and returns any problems with a repair hint.

If it comes back with errors, fix them and propose once more. Do not argue with the validator: an overlap it reports is an overlap two agents would have hit for real.

When it passes, tell the team what you split and why, and ask them to approve on the board. Nothing becomes claimable until the split is approved and the contract has landed.
