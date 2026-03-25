# Global Rules for Aaron Project

## Project Overview
Aaron is an isomorphic JavaScript coding agent that runs identically in browser and Node.js. The agent's only tool is JavaScript execution via `AsyncFunction` — it writes code to accomplish tasks rather than calling discrete named tools.

## Core Architecture Rules

### Language and Dependencies
- **Vanilla JavaScript ESM only** — no TypeScript, no build step, no npm dependencies
- **Node 18+ compatibility** — use native `fetch` and `AsyncFunction`
- **Zero dependencies constraint** — intentional design choice, never add npm packages
- **Functions over classes** — prefer plain functions and objects over abstractions

### Isomorphic Design
- **No environment branching** — never use `typeof window`, `typeof process` in core logic
- **Keep harnesses in sync** — `agent-harness.html` and `agent-harness.mjs` must have identical core logic
- **Pure render functions** for UI components — no DOM APIs, no side effects

### Module System
- **ESM only** — use `export` and `export async function`, never `module.exports` or `require()`
- **Dynamic imports** from `esm.sh` for external packages (with allowlist)
- **Module cache** in VFS (`/cache/modules/`) to avoid re-fetching

## RSI (Recursive Self-Improvement) Rules

### Core vs Mutable Split
- **Invariant core** (`agent-core.js`): Never self-modified by RSI
  - `createVFS()`, `execute()`, `createLLMClient()`, `extractCode()`
- **Mutable harness** (`agent-loop.js`): RSI target
  - SYSTEM prompt, `runTurn()`, MAX_RETRIES

### RSI Contract Requirements
When modifying `agent-loop.js`, must honor these invariants:
1. **ESM only** — use `export`, never `module.exports`
2. **Required exports** — `SYSTEM` (string), `MAX_RETRIES` (number), `runTurn` (async function)
3. **`runTurn` signature** — exactly `runTurn(userMessage, state, { llm, execute, extractCode, ui })`
4. **No inlining invariant core** — use `deps.*` instead of redefining core functions
5. **No environment branching** — no `typeof window`, `typeof process`
6. **Use `state.history`** — maintain conversation memory across turns
7. **Use UI adapter** — call `ui.setStatus()`, `ui.showCode()`, `ui.emitEvent()`, `ui.onRetry()`, `ui.onTurnComplete()`

### RSI Safety
- **Human control** via `/program.md` and `/memory/`
- **Branch-based experiments** — RSI runs on GitHub branches
- **Invariant core protection** — agent cannot modify core functions

## Virtual File System (VFS) Rules

### VFS Structure
```
/src/           Working codebase
/harness/       Agent's own runtime (RSI target)
/memory/        Long-term durable facts
/scratch/       Ephemeral planning
/artifacts/     Agent outputs
/skills/*/      Skill definitions
/workflows/*/   Workflow definitions
/program.md     Human steering instructions
```

### VFS Usage
- **All state in VFS** — no direct file system access
- **VFS API only** — use `context.vfs.read()`, `context.vfs.write()`, `context.vfs.list()`
- **Dirty tracking** — files marked dirty when written
- **SHA tracking** — for GitHub synchronization

## Code Style and Conventions

### Emit Protocol
- **Use `context.emit()`** for all output — never raw `console.log`
- **Typed events** — `progress`, `done`, `file_write`, `file_read`, `metric`, `experiment`, `error`

### Error Handling
- **Auto-retry loop** — exceptions feed back to LLM for correction (max 3 retries)
- **Error format** — `{ error: message, attempt: N, maxRetries: 3 }`

### Planning Protocol
- **Multi-step planning** — use `/scratch/plan.md`, `/scratch/current.md`, `/scratch/log.md`
- **Context management** — include dirty files in recent turns, load others on demand

## Agent Skills System

### Skill Structure
- **agentskills.io standard** — YAML frontmatter with `name` and `description`
- **Progressive disclosure** — only names/descriptions in SYSTEM prompt, full instructions loaded on demand
- **VFS-based** — skills live in `/skills/`, activated via `context.vfs.read()`

### Skill Rules
1. YAML frontmatter must have `name` and `description`
2. Frontmatter `name` must match directory name
3. Body must have substantive instructions (50+ chars)

## Security Rules

### Secrets Management
- **Never expose raw API keys** in `context.env`
- **Inject scoped helpers** that use credentials internally
- **No raw secrets** in code or VFS

### Safety Constraints
- **No sandbox bypassing** — respect AsyncFunction boundaries
- **Network proxy** — all browser `fetch()` through `context.fetch`
- **Package allowlist** — enforce via `context.env`

## Build and Deployment Rules

### No Build Process
- **Zero build step** — intentional design choice
- **Direct module loading** — browser harness served over HTTP
- **No bundling** — keep files separate and loadable

### Testing
- **Validation tests** — `test-hydration.mjs`, `test-skills.mjs`
- **Isomorphic testing** — tests must run in both environments

## What NOT to Do (Critical Constraints)

### Architecture
- ❌ Don't add npm dependencies
- ❌ Don't add environment-specific branching in core logic
- ❌ Don't modify invariant core without ADR discussion
- ❌ Don't put raw secrets in code or `context.env`

### Development
- ❌ Don't break harness synchronization
- ❌ Don't use build tools or bundlers
- ❌ Don't modify core functions (`execute()`, `createVFS()`, etc.) without ADR

### Browser
- ❌ Don't use DOM APIs in isomorphic components
- ❌ Don't serve browser harness from `file://` protocol
- ❌ Don't bypass platform proxy for API keys

## File Organization

### Core Files
- `agent-core.js` — Invariant core (never self-modified)
- `agent-loop.js` — Mutable harness (RSI target)
- `agent-rsi.js` — RSI experiment runner
- `agent-harness.mjs` — CLI harness
- `agent-harness.html` — Browser harness

### Documentation
- `ADR.md` — Architectural decisions (13 decisions)
- `RULES.md` — Comprehensive project rules
- `CLAUDE.md` — Claude Code guidance
- `.github/copilot-instructions.md` — Copilot guidance

## CLI Commands Reference

### Interactive Commands
- `:vfs` — List VFS files and state
- `:cat /path` — Print file content
- `:rsi [budget]` — Run harness RSI experiments
- `:skill [budget]` — Run skill RSI experiments
- `:workflow` — List workflows
- `:workflow <name>` — Run workflow
- `:clear` — Reset conversation history
- `:exit` — Quit

### Running the Agent
```sh
# CLI
ANTHROPIC_API_KEY=sk-ant-... node agent-harness.mjs

# Browser (must be served over HTTP)
python3 -m http.server  # then open http://localhost:8000/agent-harness.html
```

## Memory and Context Rules

### Memory Structure
- **Durable memory** — `/memory/` persists across sessions
- **Working memory** — `/scratch/` for session-specific planning
- **Artifacts** — `/artifacts/` for outputs and results

### Context Window
- **Relevance filtering** — include task-relevant files
- **Lazy loading** — load full content on demand
- **Dirty history** — always include recently modified files

## RSI Experiment Rules

### Experiment Loop
1. Snapshot baseline
2. Mutate target (`/harness/*` or `/skills/*`)
3. Validate contract
4. Run experiment evaluation
5. Measure metrics
6. Keep (commit) or discard (revert)

### Metrics Tracking
- Task completion rate
- Retry count
- Turn count
- Test pass rate
- Human score

### Experiment Safety
- **Branch isolation** — experiments on separate branches
- **Budget limits** — configurable iteration caps
- **Human oversight** — merge decisions require human approval
