---
description: Create the session branch and commit the approved contract
allowed-tools: Bash, mcp__session-share__ss_land_contract, mcp__session-share__ss_status
---

Land the contract so the work can start.

1. Call `ss_land_contract`. It creates `ss/<session>/contract` from the base branch, writes the approved contract files, commits, pushes, and opens a draft PR — then tells the session, which is what makes tasks claimable.
2. Report the branch, whether it was pushed, and the PR.
3. Tell the others to run `/ss:next`. If it was not pushed, say so plainly: they cannot see the contract yet.

If it refuses because the working tree is dirty, that is deliberate — landing switches branches, and it will not do that over uncommitted work. Show them what is uncommitted and let them decide.

Only one person needs to do this, and it should be whoever ran `/ss:plan`.
