# ADR-001: Isomorphic JavaScript Coding Agent Architecture

**Status:** Living Document  
**Date:** 2026-03-21  
**Authors:** Weo + Claude  
**Revision:** 2

---

## Context

We are building a coding agent that runs in an **isomorphic JavaScript environment** — meaning the same agent loop executes in both browser and Node.js without environment-specific branching. The agent's only LLM tool call is **JavaScript execution via `AsyncFunction`**: the model writes code to accomplish tasks rather than calling discrete named tools. Code is the tool.

The agent is designed for **recursive self-improvement (RSI)** — inspired by Karpathy's autoresearch pattern — where the agent iterates on its own harness code using the same VFS-based loop it uses for all other tasks. The human iterates on `program.md` (the SYSTEM prompt + memory files). The agent iterates on everything else.

---

## Decision 1: Virtual File System (VFS) as the Unified State Model

### Decision
All persistent state — source files, memory, scratchpad, artifacts — lives in a single **Virtual File System (VFS)**: a plain JavaScript `Map` held in the agent's `context`.

### Structure
```javascript
context.vfs = {
  '/src/index.js':        { content: '...', sha: 'abc123', dirty: false },
  '/memory/facts.md':     { content: '...', sha: 'def456', dirty: false },
  '/scratch/plan.md':     { content: '...', sha: null,     dirty: true  },
  '/artifacts/result.md': { content: '...', sha: null,     dirty: true  },
}
```

### Directory Conventions

| Directory      | Purpose                                                          |
|----------------|------------------------------------------------------------------|
| `/src/`        | Working codebase — files the agent reads and modifies           |
| `/harness/`    | The agent's own runtime — subject to RSI (see Decision 11)      |
| `/memory/`     | Long-term durable facts — persisted across sessions via GitHub  |
| `/scratch/`    | Planning scratchpad — ephemeral working notes per session       |
| `/artifacts/`  | Agent outputs — generated files, test results, logs             |
| `/program.md`  | Human-editable agent instructions — the RSI steering document   |

### VFS API (implemented)
```javascript
vfs.read(path)           // → string | null
vfs.write(path, content) // → void, marks dirty: true
vfs.list()               // → string[], sorted
vfs.isDirty(path)        // → boolean
vfs.size(path)           // → bytes
```

### Rationale
- Fully isomorphic — no `fs`, no `IndexedDB`, no environment APIs required
- Single model for file I/O, memory, planning, and output
- The LLM interacts with it using the same JS it uses for everything else
- Natural serialization boundary for GitHub sync
- The agent can read and modify its own harness — the foundation for RSI

---

## Decision 2: Three-Stage File System Lifecycle

### Stage 1 — Initialization from GitHub

Fetch the repo tree recursively via the GitHub Contents API (pure `fetch`, fully isomorphic) and hydrate the VFS. Preserve each file's `sha` for later updates.

```javascript
async function initFromGitHub(owner, repo, ref = 'main', context) {
  const files = await fetchTree(owner, repo, ref);
  for (const file of files) {
    const { content } = await fetchFile(file.url);
    context.vfs[file.path] = { content, sha: file.sha, dirty: false };
  }
}
```

### Stage 2 — In-Session Persistence (Between Turns)

The `context` object (and therefore the VFS) is kept alive in the outer agent loop across turns. The LLM reads and writes the VFS freely via `AsyncFunction`. No separate persistence mechanism is needed within a session.

The agent loop shape:
```
Turn N:
  1. Inject context (VFS already hydrated from prior turn or init)
  2. LLM generates JS code
  3. AsyncFunction executes — reads/writes VFS
  4. Emit typed events back to host
  5. Optionally flush dirty files to GitHub
  6. → Turn N+1
```

### Stage 3 — Commit Back to GitHub

Only flush files where `dirty === true`. Use the stored `sha` for the GitHub update API call.

```javascript
async function commitDirtyFiles(context, message) {
  const dirty = Object.entries(context.vfs).filter(([, f]) => f.dirty);
  for (const [path, file] of dirty) {
    await updateGitHubFile({ path, content: file.content, sha: file.sha, message });
    file.sha = newSha;
    file.dirty = false;
  }
}
```

**Flush policy:** explicit `context.commit()` from agent-generated code is preferred for RSI, so the agent controls when a successful experiment is persisted.

---

## Decision 3: Context Object Shape

```javascript
{
  vfs:   Object,   // Virtual File System
  env:   Object,   // Config and feature flags (NOT raw secrets)
  emit:  Function, // Typed event emitter back to host
  fetch: Function, // Proxied fetch (domain allowlist goes here later)
  turn:  Number,   // Current conversation turn index
}
```

### Security note on secrets
Raw tokens must **not** appear in `context.env`. Inject scoped helper objects (`context.github`) that use credentials internally without exposing them to agent-generated code.

---

## Decision 4: Multi-Step Planning Protocol

| File                  | Purpose                                          |
|-----------------------|--------------------------------------------------|
| `/scratch/plan.md`    | High-level goal decomposition and step checklist |
| `/scratch/current.md` | What the agent is doing right now (this turn)    |
| `/scratch/log.md`     | Append-only decision log across all turns        |

The agent checks off steps in `plan.md` between turns, giving it durable working memory that survives context window pressure. `/memory/` files serve the same purpose across sessions.

---

## Decision 5: Sandboxing (Deferred)

`AsyncFunction` alone provides no isolation. Sandboxing is explicitly **deferred** for the bootstrap phase — the agent is not adversarial and blast radius is limited to `context`. This is a clean drop-in replacement later:

| Environment | Future strategy                                          |
|-------------|----------------------------------------------------------|
| Browser     | Sandboxed `<iframe>` + `postMessage`, or SES/Hardened JS |
| Node.js     | `node:vm` with restricted context                        |
| Both        | `Promise.race` timeout (implemented now)                 |

The sandbox slot is already isolated in `execute()` — nothing upstream changes when it's added.

---

## Decision 6: Module / Package Loading

- Use **dynamic `import()`** from `esm.sh` — returns native ESM for any npm package, works isomorphically
- Maintain a **module cache** in the VFS (`/cache/modules/`) so packages aren't re-fetched each turn
- Enforce a **package allowlist** in `context.env` to prevent unsafe imports

---

## Decision 7: Structured Emit Protocol (implemented)

```javascript
emit({ type: 'progress',   message: 'string' })
emit({ type: 'result',     value: any })
emit({ type: 'file_write', path: 'string' })
emit({ type: 'file_read',  path: 'string' })
emit({ type: 'done',       message: 'string' })
emit({ type: 'error',      message: 'string' })

// RSI additions:
emit({ type: 'metric',     name: 'string', value: number, unit: 'string' })
emit({ type: 'experiment', id: 'string', kept: boolean, reason: 'string' })
```

---

## Decision 8: Error Recovery Loop (implemented)

Exceptions from `AsyncFunction` are automatically fed back to the LLM as a follow-up turn:

```
Execute code
  → Throws exception
    → Format: { error: message, attempt: N, maxRetries: 3 }
    → Inject as next user turn
    → LLM generates corrected code
    → Retry up to 3 times
      → If still failing: emit({ type: 'error' }) to user
```

---

## Decision 9: Context Window Management

1. **Always include:** Files modified in recent turns (dirty history)
2. **On request:** Agent calls `context.vfs.read(path)` explicitly
3. **Summarized:** Long files get a truncated preview; agent requests full content when needed
4. **Semantic relevance:** Lightweight similarity pass for task-relevant files

---

## Decision 10: CORS / Network Proxy

- All browser-side `fetch()` routes through `context.fetch` — passthrough now, proxy/allowlist later
- Node-side calls the same function, bypasses proxy directly
- The seam is already in place in both harnesses; no upstream changes needed when a proxy is added

---

## Decision 11: Recursive Self-Improvement (RSI)

### The Karpathy autoresearch pattern, adapted

Karpathy's autoresearch loop:
```
modify train.py → train 5 min → measure val_bpb → keep/discard → repeat
```

Our equivalent:
```
agent reads /harness/* from VFS
  → proposes modification
  → writes new version to /harness/*
  → runs evaluation suite (via AsyncFunction)
  → measures metric
  → keep (commit) or discard (revert VFS to last SHA)
  → repeat
```

### The three-file taxonomy (mirroring autoresearch)

| autoresearch | Our agent                  | Who modifies      |
|--------------|----------------------------|-------------------|
| `prepare.py` | `execute()` + VFS core     | Never (invariant) |
| `train.py`   | `/harness/agent-loop.js`   | Agent             |
| `program.md` | `/program.md` + `/memory/` | Human             |

**Invariant core** (never self-modified — equivalent to `prepare.py`):
- `execute()` — the AsyncFunction runner + timeout
- `createVFS()` — the storage primitive
- `callLLM()` — the API client

**Mutable harness** (agent iterates on these — equivalent to `train.py`):
- SYSTEM prompt construction
- Retry strategy and error recovery
- Emit protocol handlers
- Context window injection logic
- VFS relevance filtering

**Human steers via** (equivalent to `program.md`):
- `/program.md` — high-level research direction and agent instructions
- `/memory/` files — durable facts and accumulated learnings

### RSI metric

Unlike autoresearch (single metric: `val_bpb`), our metric is task-dependent. Store all measurements in `/memory/experiments.jsonl` — append-only, one JSON line per experiment.

| Metric               | Measures                                    |
|----------------------|---------------------------------------------|
| Task completion rate | Did the agent finish without human help?    |
| Retry count          | How many error-recovery loops were needed?  |
| Turn count           | How many turns to complete the task?        |
| Test pass rate       | Did the agent's output pass defined tests?  |
| Human score          | Explicit thumbs up/down from user           |

### Keep / discard

- **Keep:** `context.commit()` — flushes modified `/harness/*` to GitHub. Now canonical.
- **Discard:** revert VFS files to their last-committed SHA. No commit, no trace.

The GitHub SHA is the ground truth — same semantics as autoresearch's "keep the best checkpoint."

### RSI safety rails

1. **Invariant core is outside `/harness/`** — agent cannot modify `execute()` or `createVFS()`
2. **`commit()` is not in the mutable harness** — the agent cannot modify how persistence works
3. **RSI runs on a branch** — experiments live on a GitHub branch; human merges to `main`
4. **Max experiment budget** — configurable iteration cap before human review

---

## Decision 12: Combined Isomorphic Harness

### Status: implemented

Two harnesses — browser (`agent-harness.html`) and CLI (`agent-harness.mjs`) — sharing identical implementations of all core modules.

### The isomorphic seam

| Layer           | Browser                          | CLI                              |
|-----------------|----------------------------------|----------------------------------|
| `createVFS()`   | identical                        | identical                        |
| `execute()`     | identical                        | identical                        |
| `callLLM()`     | identical (platform proxy)       | identical (+ `x-api-key` header) |
| `extractCode()` | identical                        | identical                        |
| `SYSTEM` prompt | identical                        | identical                        |
| `runTurn()`     | identical                        | identical                        |
| Input           | `<textarea>` + button            | `readline` REPL                  |
| Output          | DOM panels + CSS                 | ANSI escape codes                |
| VFS display     | Clickable tree + file modal      | `:vfs` / `:cat` commands         |
| API key         | Platform proxy (implicit)        | `ANTHROPIC_API_KEY` env var      |

### CLI built-in commands
```
:vfs         list VFS files + dirty state + byte sizes
:cat /path   print file content to terminal
:clear       reset conversation history (VFS persists)
:exit        quit
```

### Requirements
- **Browser:** any modern browser, no build step, zero dependencies
- **CLI:** Node.js 18+, zero npm dependencies (native `fetch` + `AsyncFunction`)

### Future: unified codebase

The shared core (`createVFS`, `execute`, `callLLM`, `extractCode`, `runTurn`, `SYSTEM`) should be extracted into a single `agent-core.js` imported by both harnesses. Once GitHub init is implemented, this file lives in the VFS itself — the agent can read and improve it like any other source file.

---

## Decision 13: Agent Skills (agentskills.io standard)

### Decision

Extensible skill system following the [Agent Skills open standard](https://agentskills.io/specification). Skills provide progressive disclosure — only names and descriptions are injected at startup; full instructions are loaded on demand from VFS.

### On-disk structure

```
skills/
  component-builder/
    SKILL.md          ← required: YAML frontmatter (name, description) + instructions
    references/       ← optional: supporting docs
      patterns.md
  code-review/
    SKILL.md
```

### VFS mapping

Skills map to `/skills/` in VFS and `skills/` on disk (via `VFS_DISK_MAP`).

### SKILL.md format (agentskills.io compliant)

```markdown
---
name: component-builder
description: Build isomorphic UI components as pure render functions
---

# Component Builder

Full instructions here — only loaded when the agent reads this file.
```

### Progressive disclosure flow

1. **Startup:** Harness scans `/skills/*/SKILL.md`, parses YAML frontmatter (name + description only)
2. **SYSTEM prompt injection:** Appends a compact skill index to the system prompt:
   ```
   AVAILABLE SKILLS — read the full SKILL.md when the task matches:
     - component-builder: Build isomorphic UI components → context.vfs.read('/skills/component-builder/SKILL.md')
   ```
3. **Activation:** When a task matches a skill, the agent reads the full SKILL.md from VFS for detailed instructions, checklists, and templates
4. **Supporting files:** Agent can also read `/skills/<name>/references/*` for additional context

### Implementation

- `parseSkillFrontmatter(content)` — extracts `{ name, description }` from YAML frontmatter
- `buildSkillIndex(vfs)` — scans VFS for `/skills/*/SKILL.md`, returns formatted index string
- Both exported from `agent-loop.js` (mutable — subject to RSI improvement)
- `runTurn` appends `state.context.skillIndex` to SYSTEM when present
- No new API surface — VFS is the activation mechanism (`context.vfs.read()`)

### Rationale

- **Zero new dependencies** — YAML frontmatter parsed with regex (name + description are single-line)
- **Fully isomorphic** — skills load from VFS in both browser and CLI
- **VFS-native** — no new API; agent reads skills the same way it reads any file
- **Progressive disclosure** — keeps SYSTEM prompt lean while making full instructions available on demand
- **RSI-compatible** — the agent can create, modify, and improve its own skills

### RSI for Skills

Skills participate in the same RSI loop as the harness (Decision 11), with a separate experiment runner:

```
snapshot /skills/* → baseline eval → mutate skill → validate → rebuild skillIndex → experiment eval → keep/discard
```

| Aspect | Harness RSI | Skill RSI |
|--------|-------------|-----------|
| Snapshot scope | `/harness/*` | `/skills/*` |
| Mutation target | `agent-loop.js` | `/skills/<name>/SKILL.md` |
| Contract validation | 7 structural checks | YAML frontmatter + body content |
| Post-mutation hook | — | Rebuild `skillIndex` on context |
| CLI command | `:rsi [budget]` | `:skill [budget]` |

Skill contract rules:
1. Must have YAML frontmatter with `name` and `description`
2. Frontmatter `name` must match directory name
3. Body must have substantive instructions (50+ chars)

The `:skill` command supports both improving existing skills and creating new ones. After the RSI loop, the skill index is rebuilt so subsequent turns see the latest skill state.

---

## Open Questions

| #  | Question | Notes |
|----|----------|-------|
| 1  | **Flush policy** | `context.commit()` preferred for RSI |
| 2  | **VFS size limits** | Lazy loading for large repos |
| 3  | **Conflict resolution** | SHA divergence mid-session |
| 4  | **SES vs iframe** | Browser sandboxing — deferred |
| 5  | **Package allowlist** | `/config/allowed-packages.json` in VFS |
| 6  | **Testing integration** | Vitest runs isomorphically; needs emit integration |
| 7  | **Session identity** | GitHub branch per RSI experiment session |
| 8  | **Multi-agent** | SHA-per-file gives optimistic concurrency almost for free |
| 9  | **RSI metric weighting** | Single metric vs composite score |
| 10 | **RSI budget** | How many autonomous iterations before human review? |
| 11 | **program.md format** | Structured vs freeform |
| 12 | **Unified codebase** | When to extract `agent-core.js` from the two harnesses |

---

## Decision Summary

| #  | Decision | Choice |
|----|----------|--------|
| 1  | State model | VFS — single Map in `context` |
| 2  | File persistence | GitHub 3-stage lifecycle |
| 3  | Context object | `{ vfs, env, emit, fetch, turn }` |
| 4  | Memory & planning | `/memory/`, `/scratch/` VFS dirs |
| 5  | Sandboxing | Deferred — `AsyncFunction` + timeout now |
| 6  | Module loading | `import()` from `esm.sh` + VFS cache |
| 7  | Observability | Typed `emit()` + RSI metric/experiment events |
| 8  | Error recovery | Auto-retry, error injected into history |
| 9  | Context management | Relevance-filtered VFS injection |
| 10 | Network | `context.fetch` passthrough → proxy later |
| 11 | RSI | autoresearch pattern; agent on `/harness/`, human on `/program.md` |
| 12 | Harness | Browser + CLI; identical core, swappable UI |
| 13 | Agent Skills | agentskills.io standard; progressive disclosure via VFS |
