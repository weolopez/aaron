# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Aaron** is an isomorphic JavaScript coding agent that runs identically in browser and Node.js. The agent's only LLM tool is **JavaScript execution via `AsyncFunction`** — the model writes code to accomplish tasks rather than calling discrete named tools. Designed for recursive self-improvement (RSI) following Karpathy's autoresearch pattern. Zero npm dependencies. No build step.

## Running

```sh
# CLI REPL (interactive)
ANTHROPIC_API_KEY=sk-ant-... node agent-harness.mjs

# CLI single-shot
ANTHROPIC_API_KEY=sk-ant-... node agent-harness.mjs "your prompt"

# Using the shell wrapper
ANTHROPIC_API_KEY=sk-ant-... ./aaron

# Browser (must be served over HTTP for module imports)
python3 -m http.server  # then open http://localhost:8000/agent-harness.html

# Validation tests
node test/test-hydration.mjs   # verify VFS hydration and module exports
node test/test-skills.mjs      # verify skill loading and index building

# RSI demos
ANTHROPIC_API_KEY=sk-ant-... node rsi-demo.mjs
ANTHROPIC_API_KEY=sk-ant-... node rsi-ui.mjs
```

### CLI Commands (During Interactive Session)

| Command | Effect |
|---------|--------|
| `:vfs` | List all VFS files, sizes, dirty flags |
| `:cat /path` | Print file content |
| `:rsi [budget]` | Run harness RSI experiment loop (default 5) |
| `:skill [budget]` | Run skill RSI loop |
| `:workflow` | List workflows in `/workflows/` |
| `:workflow create <name> <goal>` | Create a new workflow definition |
| `:workflow improve <name> <feedback>` | Revise step prompts via agent turn |
| `:workflow rsi <name> [budget]` | Iterate workflow definition with LLM-judged scoring |
| `:workflow <name>` | Run or resume a named workflow (drives agent turn-by-turn) |
| `:clear` | Reset conversation history (VFS persists) |
| `:exit` | Quit |

## Architecture

### Core Invariant / Mutable Split

```
agent-core.js        ← INVARIANT: createVFS(), execute(), createLLMClient(), extractCode()
agent-loop.js        ← MUTABLE (RSI target): SYSTEM prompt, runTurn(), MAX_RETRIES
agent-rsi.js         ← RSI experiment runner, validateContract(), harness/skill scoring
agent-harness.mjs    ← CLI harness (Node 18+, ANSI output, disk persistence)
agent-harness.html   ← Browser harness (DOM, zero deps, platform API proxy)
src/workflow-runner.js ← Isomorphic workflow orchestration: runWorkflowSteps, runWorkflowRSI,
                         buildWorkflowScorer — shared by both harnesses
src/llm-client.js    ← INVARIANT: LLM client creation (default model: claude-sonnet-4-6)
src/session.js       ← Session persistence (VFS + history to disk/localStorage)
```

The invariant core (`agent-core.js`) is **never self-modified by RSI**. The mutable harness (`agent-loop.js`) is what the agent iterates on. Humans steer via `/program.md` and `/memory/`.

### VFS (Virtual File System)

All state lives in a `Map` on `context`. VFS API used by agent-generated code:

```javascript
context.vfs.read(path)            // → string | null
context.vfs.write(path, content)  // marks dirty: true
context.vfs.list()                // → string[], sorted
```

| Directory | Purpose |
|-----------|---------|
| `/src/` | Working codebase |
| `/harness/` | Agent's own runtime (RSI target) |
| `/memory/` | Long-term durable facts (persisted to `memory/` on disk); includes `agent-history.json` (workflow conversation state) and `experiments.jsonl` (RSI journal) |
| `/scratch/` | Ephemeral planning scratchpad |
| `/artifacts/` | Agent outputs (persisted to `artifacts/` on disk) |
| `/skills/*/` | Skill definitions (agentskills.io standard) |
| `/workflows/*/` | Workflow definitions (JSON, driven by `:workflow` command) |
| `/program.md` | Human RSI steering instructions |

### RSI Loop

**Harness RSI** (`:rsi`):
```
snapshot /harness/* → baseline eval → mutate agent-loop.js → contract validate → experiment eval → keep/discard → log to /memory/experiments.jsonl
```
`validateContract()` enforces 7 structural invariants on any mutated `agent-loop.js`. Skill RSI (`:skill`) runs the same loop targeting `/skills/*`.

**Workflow RSI** (`:workflow rsi <name>`):
```
snapshot workflow JSON → run baseline (score artifacts) → mutate workflow definition → validate JSON → run experiment → LLM-judge quality → keep/discard → log
```
`buildWorkflowScorer(llm)` in `workflow-runner.js` calls the LLM to rate artifact quality 0–10 against `wf.description`; this drives keep/discard. Falls back to artifact byte-count heuristic if scorer unavailable.

### Workflow Persistence

Each workflow step saves `state.history` to `/memory/agent-history.json` after its checkpoint. When a workflow is resumed in a new session, the conversation context is restored, giving the agent full memory of what was already done.

### Emit Protocol

All agent output goes through typed `context.emit()` — never raw `console.log`:

```javascript
context.emit({ type: 'progress', message: '...' })
context.emit({ type: 'done', message: '...' })
context.emit({ type: 'file_write', path: '...' })
context.emit({ type: 'metric', name: '...', value: N, unit: '...' })
context.emit({ type: 'experiment', id: '...', kept: true, reason: '...' })
```

### Skill System

Skills live in `skills/<name>/SKILL.md` with YAML frontmatter. `buildSkillIndex(vfs)` generates a compact index injected into SYSTEM at startup. When a workflow step references `step.skill`, the **full** `SKILL.md` content is injected into that step's prompt — not just a weak prefix.

## Code Style

- Vanilla JavaScript ESM only — no TypeScript, no build step, no npm
- Node 18+ (`fetch` and `AsyncFunction` are native)
- Functions over classes; plain objects over abstractions
- Keep both harnesses in sync — identical core logic, only UI/IO differs
- Isomorphic UI components must be pure render functions (no DOM APIs, no side effects)

## RSI Contract Rules

Mutations to `agent-loop.js` **must** honor all 7 invariants (enforced by `validateContract()`):

1. **ESM only** — `export const`/`export async function`, never `module.exports`
2. **Required exports** — `SYSTEM` (string), `MAX_RETRIES` (number), `runTurn` (async function)
3. **`runTurn` signature** — exactly `runTurn(userMessage, state, { llm, execute, extractCode, ui })`
4. **No inlining invariant core** — never redefine `execute()`, `extractCode()`, `createVFS()`, `createLLMClient()`; use `deps.*`
5. **No environment branching** — no `typeof window`, `typeof process`
6. **Use `state.history`** — conversation memory must persist across turns
7. **Use UI adapter** — `ui.setStatus()`, `ui.showCode()`, `ui.emitEvent()`, `ui.onRetry()`, `ui.onTurnComplete()`

## What Not to Do

- Don't add npm dependencies — the zero-dep constraint is intentional
- Don't add `if (typeof window !== 'undefined')` branching in core logic
- Don't modify `agent-core.js` (`execute()`, `createVFS()`, `createLLMClient()`, `extractCode()`) without ADR discussion
- Don't put raw API keys in `context.env`; inject scoped helpers that use credentials internally

## Key Reference

`ADR.md` — 13 architectural decisions with full rationale. Read this before making structural changes.
