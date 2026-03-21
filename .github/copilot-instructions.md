# Project Guidelines — Aaron

## What This Is

An isomorphic JavaScript coding agent ("aaron") that runs identically in browser and Node.js. The agent's only tool is JavaScript execution via `AsyncFunction` — it writes code to accomplish tasks. Designed for recursive self-improvement (RSI) following Karpathy's autoresearch pattern.

## Architecture

See [ADR.md](../ADR.md) for all architectural decisions. Key concepts:

- **VFS (Virtual File System):** All state lives in a `Map` on `context`. Directories: `/src/`, `/harness/`, `/memory/`, `/scratch/`, `/artifacts/`, `/program.md`
- **Invariant core (`agent-core.js`):** `createVFS()`, `execute()`, `createLLMClient()`, `extractCode()` — never modified by RSI
- **Mutable harness (`agent-loop.js`):** `SYSTEM` prompt, `runTurn()` — subject to RSI, agent reads/modifies via VFS at `/harness/*`
- **Two harnesses:** `agent-harness.html` (browser, zero deps) and `agent-harness.mjs` (CLI, Node 18+, zero npm deps)
- **RSI boundary:** Agent modifies `/harness/*`; humans steer via `/program.md` and `/memory/`; invariant core is never self-modified

## Code Style

- Vanilla JavaScript ESM — no TypeScript, no build step, no npm dependencies
- Node 18+ (native `fetch`, `AsyncFunction`)
- Functions over classes; plain objects over abstractions
- Keep the two harnesses in sync — identical core logic, only UI/IO differs

## Conventions

- **Emit protocol:** All agent output goes through typed `context.emit()` calls — never raw `console.log`
- **Code-as-tool:** The LLM returns a single ```js code block; no other tool-calling mechanism exists
- **Error recovery:** Exceptions auto-feed back to the LLM for self-correction (max 3 retries)
- **Secrets:** Never expose raw API keys in `context.env`; inject scoped helpers that use credentials internally

## Build and Test

No build step. No package manager.

```sh
# Run CLI harness
ANTHROPIC_API_KEY=sk-ant-... node agent-harness.mjs

# Run browser harness
# Open agent-harness.html directly (uses platform proxy for API key)
```

## RSI Contract Rules

When RSI mutates `agent-loop.js`, the result **must** honor these invariants (enforced by `validateContract()` in `agent-rsi.js`):

1. **ESM only** — use `export`, never `module.exports` or `require()`
2. **Required exports** — must export `SYSTEM` (string), `MAX_RETRIES` (number), `runTurn` (async function)
3. **`runTurn` signature** — `runTurn(userMessage, state, { llm, execute, extractCode, ui })` — exactly 3 params with destructured deps
4. **No inlining invariant core** — never redefine `execute()`, `extractCode()`, `createVFS()`, `createLLMClient()`, or use `new Function()` directly. Use `deps.*` instead.
5. **No environment branching** — no `typeof window`, `typeof process`, etc.
6. **Use `state.history`** — conversation memory must be maintained across turns
7. **Use UI adapter** — call `ui.setStatus()`, `ui.showCode()`, `ui.emitEvent()`, `ui.onRetry()`, `ui.onTurnComplete()` — this is how both CLI and browser harnesses render output

Mutations that violate any of these are automatically discarded before the eval phase runs.

## What Not to Do

- Don't add npm dependencies — the zero-dep constraint is intentional
- Don't add environment-specific branching (`if (typeof window !== 'undefined')`) in core logic
- Don't modify the invariant core (`agent-core.js`: `execute()`, `createVFS()`, `createLLMClient()`, `extractCode()`) without ADR discussion
- Don't put raw secrets in code or `context.env`
- The browser harness must be served over HTTP (e.g. `python3 -m http.server`) for module imports to work
