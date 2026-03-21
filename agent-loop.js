/**
 * agent-loop.js — Mutable harness (subject to RSI)
 *
 * The agent can read this file at /harness/agent-loop.js in the VFS,
 * propose modifications, evaluate them, and commit or discard.
 * See ADR.md Decision 11.
 *
 * Exports: SYSTEM, MAX_RETRIES, runTurn
 */

// ════════════════════════════════════════════════════
// SYSTEM PROMPT
// ════════════════════════════════════════════════════

export const SYSTEM = `\
You are a coding agent operating in an isomorphic JavaScript environment.

Your ONLY output is a single JavaScript code block:

\`\`\`js
// your code here
\`\`\`

The code runs inside an async function. You have access to a \`context\` object:

  context.vfs.read(path)            → string | null
  context.vfs.write(path, content)  → void
  context.vfs.list()                → string[]
  context.emit({ type, ...fields }) → void
  context.fetch(url, options)       → Promise<Response>
  context.env                       → {}  (config, feature flags)
  context.commit(message)           → Promise<string[]>  (persist dirty files)

Emit event types:
  { type: 'progress',   message: 'string' }
  { type: 'result',     value: any }
  { type: 'file_write', path: 'string' }
  { type: 'file_read',  path: 'string' }
  { type: 'done',       message: 'string' }
  { type: 'metric',     name: 'string', value: number, unit: 'string' }

Conventions:
  - Write scratch / planning work to /scratch/*
  - Write final outputs to /artifacts/*
  - Write durable memory to /memory/*
  - Your own harness code is at /harness/* — you can read and improve it
  - ALWAYS end with: context.emit({ type: 'done', message: '...' })
  - Emit progress updates for multi-step work
  - Emit metrics for measurable outcomes
  - No text outside the code block`;

// ════════════════════════════════════════════════════
// AGENT LOOP
// ════════════════════════════════════════════════════

export const MAX_RETRIES = 3;

/**
 * Run a single conversation turn.
 *
 * UI adapter interface:
 *   ui.setStatus(s)              — 'thinking' | 'running' | 'idle' | 'error' | string
 *   ui.showCode(code)            — render the code block
 *   ui.emitEvent(ev)             — display a typed event
 *   ui.onRetry(attempt, max)     — show retry indicator
 *   ui.onTurnComplete(turn, vfs) — refresh display after successful turn
 */
export async function runTurn(userMessage, state, { llm, execute, extractCode, ui }) {
  state.history.push({ role: 'user', content: userMessage });
  ui.setStatus('thinking');

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const data = await llm.call(state.history, SYSTEM);
      const { code } = extractCode(data);

      state.history.push({ role: 'assistant', content: data.content });

      ui.showCode(code);
      ui.setStatus('running');

      await execute(code, state.context);

      // Success
      state.turn++;
      ui.setStatus('idle');
      ui.onTurnComplete(state.turn, state.context.vfs);
      return;

    } catch (err) {
      ui.emitEvent({ type: 'error', message: `[attempt ${attempt + 1}] ${err.message}` });

      if (attempt + 1 < MAX_RETRIES) {
        ui.onRetry(attempt + 1, MAX_RETRIES);
        state.history.push({
          role: 'user',
          content: `Error on attempt ${attempt + 1}/${MAX_RETRIES}: ${err.message}\n\nPlease fix and try again. Return only the corrected code block.`,
        });
      } else {
        ui.setStatus('error');
      }
    }
  }
}
