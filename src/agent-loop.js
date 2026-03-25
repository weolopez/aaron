/**
 * agent-loop.js — Mutable harness (subject to RSI)
 *
 * The agent can read this file at /harness/agent-loop.js in the VFS,
 * propose modifications, evaluate them, and commit or discard.
 * See ADR.md Decision 11.
 *
 * Exports: SYSTEM, MAX_RETRIES, runTurn
 */

import { getLLMClient } from './llm-client.js';
import { saveSession } from './session.js';

// ════════════════════════════════════════════════════
// SYSTEM PROMPT
// ════════════════════════════════════════════════════

export const SYSTEM = `You are a coding agent operating in an isomorphic JavaScript environment.

Your ONLY output is a single JavaScript code block:

\`\`\`js
// your code here
\`\`\`

PRE-FLIGHT CHECKLIST (ALWAYS DO THIS FIRST):
  ✓ Validate inputs: Does the file/path exist? Check context.vfs.list() if uncertain
  ✓ Check environment: Review context.env for feature flags before complex operations
  ✓ Define success criteria: What does done look like? (files created, tests passing, etc.)
  ✓ Plan error recovery: If a fetch/read/write fails, what's your fallback?
  ✓ Use try/catch: Wrap risky operations (fetch, JSON.parse, regex matches) with error context

The code runs inside an async function. You have access to a \`context\` object:

  context.vfs.read(path)            → string | null
  context.vfs.write(path, content)  → void
  context.vfs.list()                → string[]
  context.emit({ type, ...fields }) → void
  context.fetch(url, options)       → Promise<Response>
  context.env                       → {}  (config, feature flags)
  context.commit(message)           → Promise<string[]>  (persist dirty files, called automatically after each turn)

Emit event types:
  { type: 'progress',   message: 'string' }
  { type: 'result',     value: any }
  { type: 'file_write', path: 'string' }
  { type: 'file_read',  path: 'string' }
  { type: 'done',       message: 'string' }
  { type: 'metric',     name: 'string', value: number, unit: 'string' }

MULTI-STEP WORKFLOW PATTERN (for tasks requiring multiple files or phases):
  1. PLAN FIRST: Write a build plan to /scratch/plan.md before coding
  2. EMIT PROGRESS: context.emit({ type: 'progress', message: 'Step N: ...' }) between major steps
  3. BUILD IN ORDER: dependency order (utilities -> components -> tests -> docs)
  4. TEST AS YOU GO: verify each piece before building the next
  5. EMIT METRICS: report measurable outcomes (files created, tests passed)

CRITICAL - AVOID NESTED BACKTICK CONFLICTS:
  When writing multi-line file content to VFS, use string concatenation or arrays
  instead of template literals if the content might contain backticks (markdown
  code fences, template literals, etc.). Nested backticks break code extraction.
  GOOD: const lines = ['# Title', '', '## Usage']; context.vfs.write(path, lines.join('\n'));
  GOOD: context.vfs.write(path, '# Heading\n\n' + 'Body text\n');

ERROR HANDLING GUIDE:
  • context.vfs.read(path) returns null if file doesn't exist → check before using
  • context.fetch() may timeout or 4xx/5xx → check response.ok, wrap in try/catch
  • context.commit() can fail if VFS is locked → emit error state clearly, suggest retry
  • Always emit { type: 'progress' } with the error context before giving up

Conventions:
  - Write scratch / planning work to /scratch/<task-slug>/*
  - Write final outputs to /artifacts/<task-slug>/<file>  (NEVER directly to /artifacts/<file>)
  - Write durable memory to /memory/*
  - Your own harness code is at /harness/* -- you can read and improve it
  - ALWAYS end with: context.emit({ type: 'done', message: '...' })
  - Emit progress updates for multi-step work
  - Emit metrics for measurable outcomes
  - No text outside the code block`;

// ════════════════════════════════════════════════════
// SKILL DISCOVERY (Agent Skills standard — agentskills.io)
// ════════════════════════════════════════════════════

/** Parse YAML frontmatter from a SKILL.md file. Returns { name, description } or null. */
export function parseSkillFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const yaml = match[1];
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) return null;
  return { name, description };
}

/** Scan VFS for skill SKILL.md files, return formatted index string for SYSTEM prompt. */
export function buildSkillIndex(vfs) {
  const skills = [];
  const allPaths = vfs.list();
  for (const path of allPaths) {
    if (!path.startsWith('/skills/') || !path.endsWith('/SKILL.md')) continue;
    const parts = path.split('/');
    if (parts.length !== 4) continue; // /skills/<name>/SKILL.md
    const content = vfs.read(path);
    if (!content) continue;
    const meta = parseSkillFrontmatter(content);
    if (!meta) continue;
    // Discover supplementary files (references/, scripts/, assets/)
    const prefix = `/skills/${meta.name}/`;
    const resources = allPaths
      .filter(p => p.startsWith(prefix) && p !== path)
      .map(p => p.slice(prefix.length));
    skills.push({ ...meta, path, resources });
  }
  if (skills.length === 0) return '';
  let index = '\nAVAILABLE SKILLS \u2014 read the full SKILL.md when the task matches:\n';
  index += '  Skills may bundle references/ and scripts/ \u2014 SKILL.md will tell you what to read.\n';
  for (const s of skills) {
    index += `  - ${s.name}: ${s.description} \u2192 context.vfs.read('${s.path}')`;
    if (s.resources.length > 0) index += ` [+${s.resources.length} files]`;
    index += '\n';
  }
  return index;
}

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
export async function runTurn(userMessage, state, { execute, extractCode, ui }) {
  const llm = getLLMClient();
  state.history.push({ role: 'user', content: userMessage });
  ui.setStatus('thinking');

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const systemPrompt = state.context.skillIndex
        ? SYSTEM + state.context.skillIndex
        : SYSTEM;
      const data = await llm.call(state.history, systemPrompt);
      const { code } = extractCode(data);

      state.history.push({ role: 'assistant', content: data.content });

      ui.showCode(code);
      ui.setStatus('running');

      await execute(code, state.context);

      // Auto-commit dirty files to disk
      const dirty = state.context.vfs.list().filter(p => state.context.vfs.isDirty(p));
      if (dirty.length > 0 && state.context.commit) {
        await state.context.commit('auto');
      }

      // Success
      state.turn++;
      ui.setStatus('idle');
      ui.onTurnComplete(state.turn, state.context.vfs);

      // Persist session
      await saveSession(state, state.context.vfs);

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
