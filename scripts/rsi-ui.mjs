#!/usr/bin/env node
/**
 * rsi-ui.mjs — Isomorphic UI creation RSI runner
 *
 * Runs 5 escalating UI use cases through the RSI loop.
 * Each round evaluates the agent's ability to create isomorphic UI components
 * (plain JS that produces valid HTML, works in both browser and Node/VFS).
 *
 * After a success criteria is met for a use case, the next use case begins.
 *
 * Usage: ANTHROPIC_API_KEY=sk-ant-... node rsi-ui.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from 'node:process';
import { createVFS, execute, createLLMClient, extractCode } from '../src/agent-core.js';
import { runTurn } from '../src/agent-loop.js';
import { runExperiment } from '../src/agent-rsi.js';

const API_KEY = env.ANTHROPIC_API_KEY ?? '';
if (!API_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }

const llm = createLLMClient({
  model: 'claude-sonnet-4-20250514',
  headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
});

// ════════════════════════════════════════════════════
// MINIMAL UI ADAPTER
// ════════════════════════════════════════════════════

const ui = {
  setStatus(s)        { console.log(`  [${s}]`); },
  showCode(code)      { const n = code.split('\n').length;
                        console.log(`  ┌─ code (${n} lines) ─┐`);
                        for (const l of code.split('\n').slice(0, 6)) console.log(`  │ ${l}`);
                        if (n > 6) console.log(`  │ ... (${n - 6} more)`);
                        console.log('  └──────────────────┘'); },
  emitEvent(ev)       { const t = ev.type;
                        const msg = ev.message ?? ev.path ?? ev.reason ?? JSON.stringify(ev.value ?? '');
                        console.log(`  ${t === 'done' ? '✓' : t === 'error' ? '✕' : '◆'}  ${t}: ${msg}`); },
  onRetry(a, m)       { console.log(`  ↺ retry ${a}/${m}`); },
  onTurnComplete(t,v) { console.log(`  turn ${t} complete (${v.list().length} VFS files)`); },
};

// ════════════════════════════════════════════════════
// VFS + DISK PERSISTENCE
// ════════════════════════════════════════════════════

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function hydrateVFS(vfs) {
  for (const f of ['agent-core.js', 'agent-loop.js', 'agent-rsi.js']) {
    try {
      vfs.write(`/harness/${f}`, readFileSync(join(ROOT, 'src', f), 'utf8'));
      vfs.markClean(`/harness/${f}`);
    } catch {}
  }
}

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

// ════════════════════════════════════════════════════
// 5 ESCALATING UI USE CASES
// ════════════════════════════════════════════════════

const UI_CASES = [
  {
    name: 'Counter component',
    eval: [
      'Create an isomorphic counter UI component as a pure JavaScript function.',
      'The function `renderCounter(count)` should:',
      '  - Accept a number and return an HTML string',
      '  - Produce: <div class="counter"><span class="count">{count}</span><button class="inc">+</button><button class="dec">-</button></div>',
      '  - Work identically whether called in browser or Node (no DOM APIs in the render)',
      'Write the function to /artifacts/counter.js',
      'Test it: call renderCounter(0), renderCounter(5), renderCounter(-1)',
      'Verify each output contains the correct count value and both buttons',
      'Emit a metric { name: "tests_passed", value: N } where N is how many passed (should be 3)',
      'Save test results to /artifacts/counter-test.md',
    ].join('\n'),
  },
  {
    name: 'Todo list component',
    eval: [
      'Create an isomorphic todo list UI component as pure JavaScript functions.',
      'Implement these functions and write them to /artifacts/todo.js:',
      '  - `createTodoState()` → returns { items: [], nextId: 1 }',
      '  - `addTodo(state, text)` → returns new state with item added { id, text, done: false }',
      '  - `toggleTodo(state, id)` → returns new state with item toggled',
      '  - `renderTodoList(state)` → returns HTML string:',
      '    <ul class="todo-list">{items}</ul> where each item is:',
      '    <li class="todo-item {done ? "completed" : ""}" data-id="{id}"><input type="checkbox" {done ? "checked" : ""}/><span>{text}</span></li>',
      'Test: create state, add "Buy milk", add "Walk dog", toggle first item',
      'Verify: 2 items rendered, first has class "completed" and checked attribute, second does not',
      'Emit metric { name: "tests_passed", value: N } (should be 4: create, add, toggle, render)',
      'Save results to /artifacts/todo-test.md',
    ].join('\n'),
  },
  {
    name: 'Form with validation',
    eval: [
      'Create an isomorphic form component with validation as pure JavaScript.',
      'Write to /artifacts/form.js:',
      '  - `validateField(name, value, rules)` → { valid: bool, error: string|null }',
      '    rules: { required?: bool, minLength?: number, pattern?: RegExp }',
      '  - `validateForm(fields)` → { valid: bool, errors: { [field]: string } }',
      '    fields: [{ name, value, rules }]',
      '  - `renderForm(fields, errors)` → HTML string with form, inputs, error messages',
      '    Each field: <div class="field"><label>{name}</label><input name="{name}" value="{value}"/>{error ? <span class="error">{error}</span> : ""}</div>',
      '    Wrap in: <form class="validated-form">...</form>',
      'Test: validate empty required field (should fail), short password (minLength: 8), valid email (pattern)',
      'Render form with errors and verify error spans appear for invalid fields only',
      'Emit metric { name: "tests_passed", value: N } (should be 5: 3 validations + form valid/invalid render)',
      'Save to /artifacts/form-test.md',
    ].join('\n'),
  },
  {
    name: 'Data table with sorting',
    eval: [
      'Create an isomorphic data table component as pure JavaScript.',
      'Write to /artifacts/table.js:',
      '  - `sortData(data, column, direction)` → sorted array (direction: "asc"|"desc")',
      '  - `renderTable(data, columns, sortColumn, sortDir)` → HTML string:',
      '    <table class="data-table">',
      '      <thead><tr>{columns.map(c => <th class="{c === sortColumn ? "sorted " + sortDir : ""}" data-col="{c}">{c}</th>)}</tr></thead>',
      '      <tbody>{rows as <tr>{cells as <td>{value}</td>}</tr>}</tbody>',
      '    </table>',
      '  - `paginateData(data, page, pageSize)` → { rows: [], totalPages: number, currentPage: number }',
      'Test with data: [{name:"Alice",age:30},{name:"Bob",age:25},{name:"Carol",age:35}]',
      'Sort by age asc → verify Bob first. Sort by name desc → verify Carol first.',
      'Paginate with pageSize 2 → verify 2 pages, first page has 2 rows.',
      'Emit metric { name: "tests_passed", value: N } (should be 4: sort asc, sort desc, paginate, render)',
      'Save to /artifacts/table-test.md',
    ].join('\n'),
  },
  {
    name: 'Component composition (dashboard)',
    eval: [
      'Create an isomorphic dashboard that composes the previous components.',
      'Read /artifacts/counter.js, /artifacts/todo.js, /artifacts/form.js, /artifacts/table.js from VFS.',
      'If any are missing, create minimal versions inline.',
      'Write to /artifacts/dashboard.js:',
      '  - `renderDashboard(state)` → HTML string composing:',
      '    <div class="dashboard">',
      '      <section class="widget" data-widget="counter">{counter}</section>',
      '      <section class="widget" data-widget="todos">{todo list}</section>',
      '      <section class="widget" data-widget="stats">{table of stats}</section>',
      '    </div>',
      '  - `createDashboardState()` → { counter: 0, todos: createTodoState(), stats: [{...}] }',
      'Test: create dashboard state, render it, verify output contains all 3 sections',
      'Verify: class "dashboard" present, 3 sections with data-widget attributes, each section has content',
      'Emit metric { name: "tests_passed", value: N } (should be 4: state, render, sections, content)',
      'Save to /artifacts/dashboard-test.md',
    ].join('\n'),
  },
];

const MUTATE_PROMPT = [
  'Read /harness/agent-loop.js — this is your own harness code.',
  '',
  'Your job: improve ONLY the SYSTEM prompt string to help the agent create better isomorphic UI components.',
  '',
  'Follow this EXACT procedure:',
  '1. Read the file: const source = context.vfs.read("/harness/agent-loop.js")',
  '2. Find the SYSTEM prompt string (the template literal after "export const SYSTEM =")',
  '3. Add or improve guidance in the SYSTEM prompt about:',
  '   - Isomorphic UI patterns (pure functions returning HTML strings)',
  '   - Component composition (renderX(props) → HTML)',
  '   - State management patterns (createState → state, updateState → newState)',
  '   - Testing strategies (verify output contains expected HTML fragments)',
  '4. Use string replacement to swap ONLY the SYSTEM prompt content in the source',
  '5. Write the modified source back: context.vfs.write("/harness/agent-loop.js", modifiedSource)',
  '',
  'CRITICAL — do NOT change anything outside the SYSTEM template literal string:',
  '  - Do NOT modify the runTurn function',
  '  - Do NOT change exports, imports, or module structure',
  '  - Do NOT add new functions or variables',
  '  - The file must still have: export const SYSTEM, export const MAX_RETRIES, export async function runTurn',
  '',
  'Explain what you added to the SYSTEM prompt in a progress emit, then emit done.',
].join('\n');

// ════════════════════════════════════════════════════
// CASCADING RSI LOOP
// ════════════════════════════════════════════════════

async function runCascadingRSI() {
  const vfs = createVFS();
  hydrateVFS(vfs);

  const context = {
    vfs,
    fetch: (...a) => fetch(...a),
    emit: (ev) => ui.emitEvent(ev),
    env: {},
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

  const allResults = [];

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  ISOMORPHIC UI RSI — 5 escalating use cases         ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  for (let round = 0; round < UI_CASES.length; round++) {
    const useCase = UI_CASES[round];
    const maxAttempts = 3; // max RSI experiments per use case before moving on

    console.log(`\n┌──────────────────────────────────────────────────────┐`);
    console.log(`│  Round ${round + 1}/5: ${useCase.name.padEnd(42)} │`);
    console.log(`└──────────────────────────────────────────────────────┘\n`);

    let succeeded = false;

    for (let attempt = 0; attempt < maxAttempts && !succeeded; attempt++) {
      log(`\n─── attempt ${attempt + 1}/${maxAttempts} for "${useCase.name}" ───\n`);

      const result = await runExperiment({
        evalPrompt: useCase.eval,
        mutatePrompt: MUTATE_PROMPT,
        state,
        deps,
        log,
      });

      result.useCase = useCase.name;
      result.round = round + 1;
      result.attempt = attempt + 1;
      allResults.push(result);

      // Success criteria: experiment completed (baseline or experiment)
      // The eval task itself validates correctness via test assertions
      if (result.kept || (result.baseline && result.baseline.completed)) {
        succeeded = true;
        log(`✓ use case "${useCase.name}" passed — advancing to next`);
      } else {
        log(`✕ attempt ${attempt + 1} did not pass — retrying`);
      }
    }

    if (!succeeded) {
      log(`⚠ use case "${useCase.name}" failed after ${maxAttempts} attempts — moving on`);
    }

    // Flush after each round
    const dirty = vfs.list().filter(p => vfs.isDirty(p));
    if (dirty.length > 0) {
      const written = flushToDisk(vfs, dirty);
      for (const p of dirty) vfs.markClean(p);
      if (written.length > 0) log(`flushed ${written.length} files to disk`);
    }
  }

  // ════════════════════════════════════════════════════
  // FINAL REPORT
  // ════════════════════════════════════════════════════

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  RESULTS                                             ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  for (const r of allResults) {
    const status = r.kept ? 'KEPT ✓' : (r.reason?.startsWith('contract') ? 'CONTRACT ✕' : 'DISC ✕');
    console.log(`  Round ${r.round} "${r.useCase}" attempt ${r.attempt}: ${status}`);
    if (r.baseline) {
      console.log(`    baseline:   completed=${r.baseline.completed} errors=${r.baseline.errors} retries=${r.baseline.retries} ${r.baseline.durationMs}ms`);
    }
    if (r.experiment) {
      console.log(`    experiment: completed=${r.experiment.completed} errors=${r.experiment.errors} retries=${r.experiment.retries} ${r.experiment.durationMs}ms`);
    }
    console.log(`    reason: ${r.reason}`);
    console.log();
  }

  // Summary
  const kept = allResults.filter(r => r.kept).length;
  const contractFails = allResults.filter(r => r.reason?.startsWith('contract')).length;
  console.log(`  Total: ${allResults.length} experiments, ${kept} kept, ${contractFails} contract violations`);

  // Show experiment journal
  const journal = vfs.read('/memory/experiments.jsonl');
  if (journal) {
    const entries = journal.trim().split('\n').filter(Boolean).length;
    console.log(`  /memory/experiments.jsonl: ${entries} entries`);
  }

  // Show artifacts
  console.log('\n  Artifacts:');
  for (const p of vfs.list().filter(p => p.startsWith('/artifacts/'))) {
    const size = vfs.size(p);
    console.log(`    ${p} (${size}b)`);
  }

  // Show harness state
  const loop = vfs.read('/harness/agent-loop.js');
  if (loop) {
    console.log(`\n  /harness/agent-loop.js: ${loop.split('\n').length} lines (${loop.length} bytes)`);
  }

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  DONE');
  console.log('══════════════════════════════════════════════════════\n');

  return allResults;
}

// ════════════════════════════════════════════════════
// RUN
// ════════════════════════════════════════════════════

runCascadingRSI().catch(err => {
  console.error('Fatal:', err.message, err.stack);
  process.exit(1);
});
