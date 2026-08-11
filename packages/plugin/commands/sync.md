---
description: Pull whatever your teammates have landed on the contract branch
allowed-tools: Bash, mcp__session-share__ss_sync, mcp__session-share__ss_status
---

Call `ss_sync`, then `ss_status`.

Report what came in and whether anything you are waiting on is now merged. Worth doing before starting a task that depends on someone else's, so you build against what actually landed rather than what you had when you cloned.
