# Aaron Stress Test — Bug Report
## UX-VISION.md Scenarios vs Actual Behavior

**Tested**: 2026-03-27
**Target repo**: `ml5174_ATT/apm0011159-oce-aifd-knowledgebase` (also `weolopez/aaron` for control)
**Provider**: askarchitect (no ANTHROPIC_API_KEY set, GITHUB_TOKEN set)
**Node**: v22.22.0
**Status**: ✅ All 8 bugs fixed and verified — tests pass, smoke test confirms session save and GitHub hydration work

---

## CRITICAL — Blocks core UX-VISION scenarios

### BUG-A1: `saveSession()` called with wrong arguments in agent-loop.js
- **File**: `src/agent-loop.js:221`
- **Code**: `await saveSession(state, state.context.vfs)`
- **Expected**: `await saveSession(state.context.workspaceId, state, state.context.vfs)`
- **Signature**: `saveSession(workspaceId, state, vfs)` — first arg must be a string
- **Symptom**: Every turn ends with `[Session] Failed to save: workspaceId.replace is not a function`
- **Impact**: Session persistence is completely broken from agent-loop. The REPL's own `saveSession` calls (lines 536, 949, 1028 in agent-harness.mjs) are correct, but the one inside `runTurn()` — which fires on every single turn — always crashes.
- **Fix**: Change line 221 to `await saveSession(state.context.workspaceId, state, state.context.vfs)`

### BUG-A2: Single-shot mode never hydrates from GitHub
- **File**: `agent-harness.mjs` — `createRunContext()` (line 1045) and `run()` (line 1087)
- **Root cause**: `createRunContext()` calls `hydrateHarness(vfs)` but never calls `initFromGitHub()`. Only the REPL's `repl()` function (line 468-477) does GitHub hydration.
- **Symptom**: `GITHUB_REPO=owner/repo node agent-harness.mjs "what does this codebase do?"` analyzes Aaron's own harness/skill files (37 files) instead of the target repo. No `/src/` files appear in VFS.
- **Impact**: **Every UX-VISION Day 1-3 scenario fails in single-shot mode.** The "map it", "what does this codebase do?", and all workflow commands produce garbage when run as CLI one-liners.
- **Affected code paths**: `run()`, `workflowRun()`, `workflowCreate()`, `workflowImprove()`, `skillRSI()` — all use `createRunContext()`.
- **Fix**: Add `initFromGitHub()` call inside `createRunContext()` when `ghClient && ghConfig` are set.

### BUG-A3: `clearSession()` called without required `workspaceId` argument
- **File**: `agent-harness.mjs:559`
- **Code**: `await clearSession()`
- **Expected**: `await clearSession(state.context.workspaceId)`
- **Signature**: `clearSession(workspaceId)` — requires workspace ID string
- **Symptom**: `:reset` command fails silently or throws — session is never actually cleared.
- **Fix**: Pass `state.context.workspaceId` or `currentWorkspaceId` as argument.

---

## HIGH — Broken functionality in specific paths

### BUG-A4: `:repo` switch sets `context.github` to plain object, not helper
- **File**: `agent-harness.mjs:987`
- **Code**: `state.context.github = { owner: targetRepo.owner, repo: targetRepo.repo, ref: targetRepo.ref }`
- **Expected**: `state.context.github = makeGitHubHelper(ghClient, targetRepo)`
- **Impact**: After `:repo` switch, agent code that calls `context.github.createBranch()`, `context.github.createPR()`, etc. will crash with "not a function". The `github-pr` skill and `bug-fix` workflow both rely on these helper methods.
- **Note**: The REPL fresh-session path (line 489) correctly uses `makeGitHubHelper()`. Only `:repo` switch is broken.
- **Fix**: Use `makeGitHubHelper(ghClient, targetRepo)` instead of the plain object.

### BUG-A5: `createRunContext()` also sets plain `context.github` object
- **File**: `agent-harness.mjs:1058`
- **Code**: `github: ghClient ? { owner: ghConfig.owner, repo: ghConfig.repo, ref: ghConfig.ref } : null`
- **Expected**: `github: ghClient ? makeGitHubHelper(ghClient, ghConfig) : null`
- **Impact**: All CLI modes (single-shot, workflow CLI, skill CLI) have a `context.github` without helper methods. Agent code using `context.github.createBranch()` etc. will crash.
- **Note**: RSI code works around this by creating its own `ghClient` from `process.env.GITHUB_TOKEN`.
- **Fix**: Use `makeGitHubHelper()` in `createRunContext()`.

### BUG-A6: `workspace.js` `prefixToKey()` produces keys that don't match `createWorkspace()` keys
- **File**: `src/workspace.js:259-262` vs `src/workspace.js:111-126`
- **`prefixToKey('/project-skills/')`** → `"project-skills"` (hyphenated)
- **`createWorkspace()` key** → `projectSkills` (camelCase)
- **Same for**: `/project-workflows/` → `"project-workflows"` vs `projectWorkflows`
- **Impact**: `snapshotWorkspace()` writes to `bundle['project-skills']` but `restoreWorkspace()` reads `bundle['project-skills']` — this part works internally. However, if any code creates a workspace via `createWorkspace()` and then passes it to `restoreWorkspace()`, the project-skills and project-workflows data will be silently lost because the keys don't match.
- **Fix**: Either change `prefixToKey` to produce camelCase, or change `createWorkspace` to use hyphenated keys.

---

## MEDIUM — Misleading behavior / cosmetic

### BUG-A7: Banner displays wrong LLM provider
- **File**: `agent-harness.mjs:217`
- **Code**: `const provider = env.LLM_PROVIDER ?? 'anthropic'`
- **Actual provider resolution** (line 372): `env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? 'anthropic' : 'askarchitect')`
- **Symptom**: Banner always shows `provider: anthropic` even when the actual provider is `askarchitect` (when no ANTHROPIC_API_KEY is set and LLM_PROVIDER is unset).
- **Fix**: Use the same resolution logic: `env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? 'anthropic' : 'askarchitect')`

### BUG-A8: GitHub hydration returns misleading error for GHE / inaccessible repos
- **File**: `src/github.js:232-234`
- **Symptom**: When `getTree()` returns empty (404 from API), message is "Repository is empty or not found" — doesn't distinguish between empty repo, auth failure, GHE org not accessible via github.com API, or wrong repo name.
- **Impact**: User sees `✓ 0 files hydrated from GitHub` which looks like success, not failure.
- **Fix**: Check the actual HTTP response status and provide specific error messages.

### BUG-A9: GitHub API hardcodes `api.github.com` — no GHE support
- **File**: `src/github.js:14`
- **Code**: `const API = 'https://api.github.com'`
- **Impact**: Any GitHub Enterprise org (like `ml5174_ATT`) cannot be used as a target repo. The UX-VISION scenario of pointing Aaron at an enterprise repo silently fails.
- **Fix**: Allow `GITHUB_API_URL` env var override, or auto-detect from repo URL format.

---

## UX-VISION Scenario Results

| Scenario | Expected (UX-VISION.md) | Actual Result | Bugs Hit |
|----------|------------------------|---------------|----------|
| **Day 1: Launch + hydrate** | `✓ 47 files hydrated from GitHub` | Single-shot: 0 files, analyzed own harness. REPL: works for github.com repos, "empty or not found" for GHE. | A2, A8, A9 |
| **Day 1: "what does this codebase do?"** | Reads README, summarizes purpose | Read own /harness/ and /skills/ files. Concluded "Has testing infrastructure, web API backend" (wrong). | A2 |
| **Day 1: "map it"** | Writes `/memory/project-notes.md` with codebase map | Wrote `/memory/codebase-map-notes.md` with "No README.md found. Total files: 37" (own files). | A2 |
| **Day 2: "fix this" / `:workflow bug-fix`** | Diagnose, fix, open PR | Step 1 blocked: "Bug report not found at /memory/bug-report.md". No /src/ files to diagnose. Session save crashed. | A1, A2 |
| **Day 3: implement feature** | Plan, implement, open PR | Would crash on `context.github.createBranch()` — plain object, not helper. | A2, A5 |
| **Session persistence** | Auto-saves on every turn | `[Session] Failed to save: workspaceId.replace is not a function` on every turn | A1 |
| **`:reset` command** | Clears saved session | Fails silently (no workspaceId argument) | A3 |
| **`:repo` switch then PR** | Switch repo, create PR | `context.github.createPR is not a function` after switch | A4 |

---

## Fixes Priority (by blast radius)

1. **BUG-A1** — 1-line fix in `agent-loop.js:221`. Unblocks session persistence on every turn.
2. **BUG-A2** — Add `initFromGitHub()` to `createRunContext()`. Unblocks all single-shot and CLI workflows.
3. **BUG-A5** — Use `makeGitHubHelper()` in `createRunContext()`. Unblocks PR creation in CLI modes.
4. **BUG-A3** — 1-line fix in `agent-harness.mjs:559`. Unblocks `:reset` command.
5. **BUG-A4** — 1-line fix in `agent-harness.mjs:987`. Unblocks PR creation after `:repo` switch.
6. **BUG-A6** — Key naming fix in `workspace.js`. Prevents silent data loss on project skills/workflows.
7. **BUG-A7** — Cosmetic fix for banner provider display.
8. **BUG-A8/A9** — GitHub Enterprise support and better error messages.
