#!/usr/bin/env node
/**
 * rsi-workflow.mjs — Harness RSI with complex multi-step workflow eval
 *
 * Tests whether the agent can handle a multi-step todo app build:
 *   1. Create state module
 *   2. Build TodoItem, TodoList, TodoApp components
 *   3. Write tests
 *   4. Generate README
 *   5. Emit progress after each step
 *
 * Usage: ANTHROPIC_API_KEY=sk-ant-... node rsi-workflow.mjs [budget]
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, argv } from 'node:process';
import { createVFS, execute, createLLMClient, extractCode } from '../src/agent-core.js';
import { runTurn, buildSkillIndex } from '../src/agent-loop.js';
import { runRSI, CONTRACT_RULES } from '../src/agent-rsi.js';

const API_KEY = env.ANTHROPIC_API_KEY ?? '';
if (!API_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }

const budget = parseInt(argv[2], 10) || 5;

const llm = createLLMClient({
  model: 'claude-sonnet-4-20250514',
  headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
});

// Minimal UI adapter
const ui = {
  setStatus(s)        { console.log(`  [${s}]`); },
  showCode(code)      { const lines = code.split('\n');
                        console.log(`  ┌─ code (${lines.length} lines) ─┐`);
                        for (const l of lines.slice(0, 8)) console.log(`  │ ${l}`);
                        if (lines.length > 8) console.log(`  │ ... (${lines.length - 8} more)`);
                        console.log('  └──────────────────┘'); },
  emitEvent(ev)       { const t = ev.type;
                        const msg = ev.message ?? ev.path ?? ev.reason ?? JSON.stringify(ev.value ?? '');
                        console.log(`  ${t === 'done' ? '✓' : t === 'error' ? '✕' : '◆'}  ${t}: ${msg}`); },
  onRetry(a, m)       { console.log(`  ↺ retry ${a}/${m}`); },
  onTurnComplete(t,v) { console.log(`  turn ${t} complete (${v.list().length} VFS files)`); },
};

// Hydrate VFS
const vfs = createVFS();
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

for (const f of ['agent-core.js', 'agent-loop.js', 'agent-rsi.js']) {
  try {
    vfs.write(`/harness/${f}`, readFileSync(join(ROOT, 'src', f), 'utf8'));
    vfs.markClean(`/harness/${f}`);
  } catch {}
}

// Load skills recursively
function loadDirToVFS(baseDir, vfsPrefix, vfs) {
  let entries;
  try { entries = readdirSync(baseDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(baseDir, e.name);
    const vfsPath = vfsPrefix + e.name;
    if (e.isDirectory()) {
      loadDirToVFS(full, vfsPath + '/', vfs);
    } else {
      try {
        vfs.write(vfsPath, readFileSync(full, 'utf8'));
        vfs.markClean(vfsPath);
      } catch {}
    }
  }
}

const skillsDir = join(ROOT, 'skills');
try { loadDirToVFS(skillsDir, '/skills/', vfs); } catch {}

// Disk persistence
const VFS_DISK_MAP = {
  '/harness/': 'src/',
  '/memory/':  'memory/',
  '/artifacts/': 'artifacts/',
};

function flushToDisk(vfs, paths) {
  const written = [];
  for (const p of paths) {
    let diskPath = null;
    for (const [prefix, diskPrefix] of Object.entries(VFS_DISK_MAP)) {
      if (p.startsWith(prefix)) {
        diskPath = join(ROOT, diskPrefix, p.slice(prefix.length));
        break;
      }
    }
    if (!diskPath) continue;
    const content = vfs.read(p);
    if (content === null) continue;
    mkdirSync(dirname(diskPath), { recursive: true });
    writeFileSync(diskPath, content, 'utf8');
    written.push(p);
  }
  return written;
}

const context = {
  vfs,
  fetch: (...a) => fetch(...a),
  emit: (ev) => ui.emitEvent(ev),
  env: {},
  skillIndex: buildSkillIndex(vfs),
  async commit(msg = 'commit') {
    const dirty = vfs.list().filter(p => vfs.isDirty(p));
    const written = flushToDisk(vfs, dirty);
    for (const p of dirty) vfs.markClean(p);
    if (written.length > 0) console.log(`  ◆  flushed ${written.length} files to disk`);
    return dirty;
  },
};

const state = { history: [], turn: 0, context };
const deps = { llm, execute, extractCode, ui, runTurn };
const log = (msg) => console.log(`  rsi  ${msg}`);

// ── Complex multi-step eval prompt ──
const evalPrompt = [
  'Build a complete todo application with these requirements. You MUST complete ALL steps in a single code block:',
  '',
  '1. Create /artifacts/todo-state.js — a state management module with:',
  '   - createTodoState() factory returning { todos: [], nextId: 1 }',
  '   - addTodo(state, text) — returns new state with added todo { id, text, done: false }',
  '   - toggleTodo(state, id) — returns new state with toggled done flag',
  '   - deleteTodo(state, id) — returns new state without that todo',
  '   - getStats(state) — returns { total, completed, remaining }',
  '   Emit progress after this step.',
  '',
  '2. Create /artifacts/todo-components.js — pure render functions:',
  '   - TodoItem({ todo, onToggle, onDelete }) — renders a single todo with checkbox and delete button',
  '   - TodoList({ todos, handlers }) — renders the full list',
  '   - TodoApp({ state, handlers }) — composes TodoList with a stats bar and add form',
  '   All must escape user content (XSS prevention) and use semantic HTML.',
  '   Emit progress after this step.',
  '',
  '3. Create /artifacts/todo.test.js — tests that verify:',
  '   - State: add, toggle, delete, getStats all work correctly',
  '   - Components: render correct HTML, handle empty state, escape XSS',
  '   - Integration: add todos → render → verify HTML contains them',
  '   Run all assertions and report results.',
  '   Emit progress after this step.',
  '',
  '4. Create /artifacts/todo-README.md — a short README documenting:',
  '   - What the app does',
  '   - Module API (state + components)',
  '   - How to use the components',
  '   Emit progress after this step.',
  '',
  '5. Emit a final metric with { name: "files_created", value: N, unit: "files" }',
  '   Then emit done.',
].join('\n');

// ── Mutation prompt ──
const mutatePrompt = [
  'Read /harness/agent-loop.js — this is your own harness code.',
  '',
  'CRITICAL — structural contract you MUST preserve when rewriting this file:',
  ...CONTRACT_RULES.map(r => `  - ${r}`),
  '',
  'EXTREMELY IMPORTANT — BACKTICK ESCAPING:',
  '  The SYSTEM prompt is a template literal (wrapped in backticks).',
  '  Any backticks INSIDE the SYSTEM string MUST be escaped as \\` (backslash-backtick).',
  '  Example: \\`\\`\\`js produces the string ```js in the prompt.',
  '  If you strip the escaping, the file will be syntactically broken.',
  '  The SAFEST approach: only modify the TEXT CONTENT of the SYSTEM string,',
  '  keeping the existing escape patterns exactly as they are.',
  '',
  'The eval task is a COMPLEX MULTI-STEP WORKFLOW: build a todo app with state module, 3 components, tests, and README — all in one code block.',
  '',
  'Analyze where the current SYSTEM prompt falls short for multi-step workflows:',
  '  - Does it guide the agent to plan before coding?',
  '  - Does it explain how to emit progress at each step?',
  '  - Does it show patterns for building multiple files in one turn?',
  '  - Does it encourage testing and verification?',
  '',
  'Propose ONE targeted improvement to the SYSTEM prompt that would help with multi-step workflows.',
  'The safest approach: modify only the SYSTEM prompt string, then write the entire file back.',
  'Do NOT rewrite the runTurn function or module structure from scratch.',
  '',
  'Write the improved version back to /harness/agent-loop.js.',
  'Explain what you changed in a progress emit before the done emit.',
].join('\n');

console.log('\n══════════════════════════════════════════');
console.log('  HARNESS RSI — Complex Workflow Eval');
console.log(`  Budget: ${budget} experiments`);
console.log('  Eval: Multi-step todo app (state + components + tests + README)');
console.log('══════════════════════════════════════════\n');

try {
  const results = await runRSI({
    evalPrompt,
    mutatePrompt,
    budget,
    state,
    deps,
    log,
  });

  console.log('\n══════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('══════════════════════════════════════════\n');

  for (const [i, r] of results.entries()) {
    console.log(`  experiment ${i + 1}: ${r.kept ? 'KEPT ✓' : 'DISCARDED ✕'}`);
    console.log(`    baseline:   completed=${r.baseline.completed} errors=${r.baseline.errors} retries=${r.baseline.retries} ${r.baseline.durationMs}ms`);
    console.log(`    experiment: completed=${r.experiment.completed} errors=${r.experiment.errors} retries=${r.experiment.retries} ${r.experiment.durationMs}ms`);
    console.log(`    reason: ${r.reason}`);
    console.log();
  }

  const kept = results.filter(r => r.kept).length;
  console.log(`  Total: ${kept}/${results.length} kept\n`);

  // Show experiment journal
  const journal = vfs.read('/memory/experiments.jsonl');
  if (journal) {
    const entries = journal.trim().split('\n').filter(Boolean);
    console.log(`  /memory/experiments.jsonl: ${entries.length} entries`);
    // Show last N entries
    const recent = entries.slice(-budget * 2);
    for (const line of recent) {
      const e = JSON.parse(line);
      console.log(`    ${e.ts} ${e.kept ? 'kept' : 'disc'} — ${e.reason}`);
    }
    console.log();
  }

  // Show harness state
  const loop = vfs.read('/harness/agent-loop.js');
  if (loop) {
    console.log(`  /harness/agent-loop.js: ${loop.split('\n').length} lines (${loop.length} bytes)`);
    if (vfs.isDirty('/harness/agent-loop.js')) console.log('    (modified ●)');
  }

  console.log('\n══════════════════════════════════════════');
  console.log('  RSI COMPLETE');
  console.log('══════════════════════════════════════════\n');
} catch (err) {
  console.error('RSI failed:', err);
  process.exit(1);
}
