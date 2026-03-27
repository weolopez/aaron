# Aaron UX Vision
## "A software engineer opens their terminal..."

This document describes the expected user experience of Aaron as a primary SE tool.
It is a design target, not a description of current state. Gaps are noted at the end.

---

## Day 1 — First time in the codebase

```bash
# Clone and enter the repo as normal
git clone https://github.com/someuser/somerepo
cd somerepo

# Point Aaron at it and start
GITHUB_REPO=someuser/somerepo aaron
```
```
  aaron  isomorphic coding agent
  github → someuser/somerepo@main
  ✓ 47 files hydrated from GitHub

you ›
```

```
you › what does this codebase do?
```
```
  ◆ Reading README, package.json, src/index.js...
  ✓ This is a Node.js REST API for managing subscription billing. Entry
    point is src/server.js. Three main domains: customers, invoices,
    webhooks. Uses Stripe for payment processing. No test suite yet.
```

```
you › map it — write notes I can refer back to
```
```
  ◆ Running init skill...
  ✦ /memory/project-notes.md
  ✓ Workspace mapped: 47 src files, 0 tests. Notes written.
```

```
you › :cat /memory/project-notes.md
```

---

## Day 1 — Understanding a specific area

```
you › how does webhook verification work?
you › where are all the Stripe API calls made?
you › what would break if I changed the invoice schema?
```

These are conversational — no special commands needed.

---

## Day 2 — There's a bug in production

```
# Someone files a GitHub issue. I paste it in directly.
you › fix this: customers report that webhook retries are firing twice
      on 5xx errors. Issue #84.
```
```
  ◆ Reading src/webhooks/handler.js...
  ◆ Root cause: retry backoff uses <= instead of <, causing N+1 iterations
  ◆ Creating branch fix/webhook-retry-88...
  ✦ /src/webhooks/handler.js
  ◆ Opening pull request...
  → https://github.com/someuser/somerepo/pull/89
  ✓ PR #89 opened: fix: webhook retry off-by-one
```

```
# Or explicitly invoke the workflow:
you › :workflow bug-fix
```

---

## Day 3 — New feature from a ticket

```
you › implement this feature: [pastes requirements]
```
```
  ◆ Running code-planner...
  ✦ /scratch/plan-implement-verify/plan.md

  Plan:
    Create: src/services/notification-queue.js
    Modify: src/server.js (register new route)
    Order: model → service → route → export

  Proceed with implementation? [y/n]
```
```
y
```
```
  ◆ Implementing...
  ✦ /src/services/notification-queue.js
  ✦ /src/server.js
  ◆ Verifying outputs... PASS
  ◆ Opening PR...
  → https://github.com/someuser/somerepo/pull/92
  ✓ PR #92 opened
```

```
# Or explicitly:
you › :workflow plan-implement-verify
```

---

## Day 3 — Reviewing your own work

```
you › review what I just wrote
you › are there any obvious bugs in the queue implementation?
you › does this match the existing code style?
```

---

## End of day — status and handoff

```
you › :vfs              # what's in memory right now
you › :github           # pending dirty files, open PRs
you › what did we accomplish today?
```
```
  ✓ Fixed PR #89 (webhook retry bug)
  ✓ Opened PR #92 (notification queue feature)
  ✓ /memory/project-notes.md updated
```

```
# Quit — session saved automatically
you › :exit
```
```
  bye
```

Next day, same repo:
```bash
GITHUB_REPO=someuser/somerepo aaron
```
```
  [session] Saved session found (12 turns, 18h ago)
  Resume? [y/n] y
  ✓ Session resumed
  PRs open: #89 (fix/webhook-retry), #92 (feat/notification-queue)

you ›
```

---

## Gaps between this vision and current Aaron

| What the UX assumes | Current reality | Gap |
|---|---|---|
| `aaron` is in PATH | `node agent-harness.mjs` or `./aaron` from project dir | Need global install or shell alias |
| `GITHUB_REPO` auto-detected from `git remote` | Must be set manually as env var | Read `git remote get-url origin` at startup |
| Plan approval gate (`Proceed? [y/n]`) | No gate — `plan-implement-verify` runs straight through | Add interactive pause after plan step in REPL |
| `what did we accomplish today?` | Agent can infer from history but no summary command | `:summary` command or end-of-session auto-summary |
| PR URL pinned after workflow | Agent emits result event but REPL just logs it inline | Surface PR URLs prominently after any workflow completes |
| `fix this` routes to bug-fix workflow automatically | Requires `:workflow bug-fix` explicitly | Agent should recognize intent and invoke the right workflow |

The biggest UX gap: **the engineer shouldn't need to know workflow names**.
`fix this`, `implement this`, `plan this`, `review this` should route to the right
skill or workflow automatically. The skill index is already injected into SYSTEM —
the agent needs a stronger signal that it should *invoke* a workflow rather than
answer conversationally.
