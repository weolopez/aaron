# Workspace & Multi-Repo Implementation Plan

**Status:** Active  
**Created:** 2026-03-26  
**See:** ADR.md Decisions 14, 15, 16

---

## Vision

Aaron pivots from a single-repo agent to a **multi-repo agent** that can pull in any GitHub repo, apply its skills and workflows, and improve both itself and the target project. Two types of skills/workflows:

- **Core** — live in Aaron's repo, improve via self-RSI, benefit every project
- **Project** — live in `.aaron/` in the target repo, specialize for that codebase

---

## Phase 1: `src/workspace.js` Module

New pure-JS module implementing workspace lifecycle.

**Exports:**
- `createWorkspace(id)` — fresh workspace bundle
- `snapshotWorkspace(vfs)` — extract workspace-layer paths (`/src/`, `/memory/`, `/scratch/`, `/artifacts/`, `/project-skills/`, `/project-workflows/`) into a serializable bundle
- `restoreWorkspace(vfs, bundle)` — clear workspace-layer paths, load bundle contents
- `getWorkspaceId(owner, repo, ref)` — deterministic ID from repo coordinates
- `WORKSPACE_PREFIXES` — list of VFS prefixes that belong to the workspace layer

**Key design:**
- VFS API unchanged — workspace is purely a save/restore of path prefixes
- Uses existing `vfs.snapshot()` and `vfs.restore()` under the hood
- Agent layer paths (`/harness/`, `/skills/`, `/workflows/`) never touched

---

## Phase 2: Session Persistence Changes

Modify `src/session.js` to be workspace-aware.

**Changes:**
- Session key: `aaron-workspace-{id}` instead of global `aaron-session`
- `saveSession(state, vfs, workspaceId)` — saves to workspace-specific key/path
- `loadSession(workspaceId)` — loads specific workspace session
- `listSessions()` — new export, returns available workspace IDs
- Node path: `~/.aaron/workspaces/{id}/session.json`
- Browser key: `aaron-workspace-{id}`
- Backward compat: migrate old global session to `self` workspace on first load

---

## Phase 3: `.aaron/` Discovery in `initFromGitHub`

Modify `src/github.js` `initFromGitHub` to detect and mount `.aaron/` contents.

**Changes:**
- After hydrating repo tree into `/src/`, check for `.aaron/` paths in the tree
- `.aaron/skills/**` → mount at `/project-skills/` in VFS
- `.aaron/workflows/**` → mount at `/project-workflows/` in VFS
- `.aaron/memory/**` → mount at `/memory/` in VFS
- `.aaron/config.json` → parse and return as part of hydration result
- Commit-back: extend `commitToGitHub` to map `/project-skills/` → `.aaron/skills/`, `/project-workflows/` → `.aaron/workflows/`

---

## Phase 4: Skill Merging

Modify `src/agent-loop.js` `buildSkillIndex` to scan both scopes.

**Changes:**
- Scan `/skills/*/SKILL.md` (core) and `/project-skills/*/SKILL.md` (project)
- Build merged index; project skills override core on name collision
- Label project skills in the index string so the agent knows the source
- `aaron skill promote <name>` — copy from `/project-skills/` to `/skills/`

---

## Phase 5: CLI / REPL / Web Entrypoints

### CLI (`agent-harness.mjs`)
- New command: `aaron repo <owner/repo[@ref]> "task"` — hydrate, create workspace, run task
- New command: `aaron repo <owner/repo[@ref]>` — hydrate and enter REPL in that workspace

### REPL
- `:repo <owner/repo[@ref]>` — switch workspace (snapshot current, hydrate/restore target)
- `:repo` — show current workspace ID
- `:workspaces` — list saved workspaces

### Web (`agent-harness.html`)
- Repo input field in header
- Workspace selector dropdown
- Same workspace manager module as CLI

---

## Phase 6: Integration Tests

See `test/test-workspace.mjs` for the full scenario suite.

---

## Test Repo Structure

A real GitHub repo is needed for integration tests. Create **`weolopez/aaron-test-repo`** with this structure:

```
aaron-test-repo/
├── README.md                          # "# Aaron Test Repo\nA fixture repo for workspace integration tests."
├── package.json                       # { "name": "aaron-test-repo", "version": "1.0.0" }
├── src/
│   ├── index.js                       # "export function hello() { return 'world'; }"
│   ├── utils.js                       # "export function add(a, b) { return a + b; }"
│   └── config.json                    # { "debug": false }
├── .aaron/
│   ├── config.json                    # { "include": ["src/"], "exclude": [], "language": "javascript" }
│   ├── skills/
│   │   └── project-linter/
│   │       └── SKILL.md               # Project-specific linting skill (see below)
│   ├── workflows/
│   │   └── health-check.json          # Simple 2-step workflow (see below)
│   └── memory/
│       └── conventions.md             # "# Conventions\n\n- Use ES modules\n- No default exports"
└── docs/
    └── api.md                         # "# API\n\n## hello()\nReturns 'world'"
```

### `.aaron/skills/project-linter/SKILL.md`

```markdown
---
name: project-linter
description: Lint this project using its specific conventions
---

# Project Linter

Check all source files against the project's coding conventions:
1. Read /memory/conventions.md for the rules
2. Scan /src/ files for violations
3. Write a lint report to /artifacts/lint-report.md
```

### `.aaron/workflows/health-check.json`

```json
{
  "name": "health-check",
  "description": "Quick health check for the project",
  "steps": [
    {
      "id": "check-structure",
      "skill": null,
      "prompt": "List all files in /src/ and verify package.json exists. Write a summary to /artifacts/health-check/structure.md"
    },
    {
      "id": "check-conventions",
      "skill": "project-linter",
      "prompt": "Run the project linter and write results to /artifacts/health-check/lint.md"
    }
  ]
}
```

### Test branch

Create a branch `aaron-test-branch` from `main` for commit/push tests. Tests that write to the repo should target this branch and clean up after themselves.

---

## Test Scenarios (14 total)

| # | Scenario | What it validates |
|---|----------|-------------------|
| 1 | Fresh workspace hydration | Repo files → `/src/`, agent layer untouched |
| 2 | `.aaron/` discovery | `.aaron/skills/` → `/project-skills/`, `.aaron/workflows/` → `/project-workflows/` |
| 3 | Skill merging | Core + project skills in index; project wins on name collision |
| 4 | Workspace snapshot/restore | Swap between two repos without data loss |
| 5 | Context switch preserves agent layer | `/skills/`, `/harness/` unchanged after switch |
| 6 | Context switch preserves conversation | Each workspace has independent history |
| 7 | Workspace-scoped session persistence | Save/load sessions keyed by workspace ID |
| 8 | Commit to external repo | Modify `/src/` file, push to test branch, verify via API |
| 9 | `.aaron/` commit-back | Modify project skill, commit, verify `.aaron/skills/` updated |
| 10 | Workspace ID derivation | Same repo+ref = same ID; different ref = different ID |
| 11 | Switch back to self | After external repo, restore Aaron's own workspace |
| 12 | Project workflow execution | Load workflow from `.aaron/workflows/`, verify it's runnable |
| 13 | RSI scope boundary | Skill RSI on external repo mutates only `/project-skills/` |
| 14 | Large repo filtering | include/exclude from `.aaron/config.json` respected |

---

## Cleanup

This file (`plan.md`) is temporary. Delete it when the workspace implementation is complete and all tests pass.
