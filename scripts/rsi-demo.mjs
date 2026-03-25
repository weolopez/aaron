#!/usr/bin/env node
/**
 * rsi-demo.mjs — Non-interactive RSI demo runner
 * Usage: ANTHROPIC_API_KEY=sk-ant-... node rsi-demo.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from 'node:process';
import { createVFS, execute, createLLMClient, extractCode } from '../src/agent-core.js';
import { runTurn } from '../src/agent-loop.js';
import { runRSI, CONTRACT_RULES } from '../src/agent-rsi.js';

const API_KEY = env.ANTHROPIC_API_KEY ?? '';
if (!API_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }

const llm = createLLMClient({
  model: 'claude-sonnet-4-20250514',
  headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
});

// Minimal UI adapter — just logs to console
const ui = {
  setStatus(s)        { console.log(`  [${s}]`); },
  showCode(code)      { console.log(`  ┌─ code (${code.split('\n').length} lines) ─┐`);
                        for (const l of code.split('\n').slice(0, 8)) console.log(`  │ ${l}`);
                        if (code.split('\n').length > 8) console.log(`  │ ... (${code.split('\n').length - 8} more)`);
                        console.log('  └──────────────────┘'); },
  emitEvent(ev)       { const t = ev.type;
                        const msg = ev.message ?? ev.path ?? ev.reason ?? JSON.stringify(ev.value ?? '');
                        console.log(`  ${t === 'done' ? '✓' : t === 'error' ? '✕' : '◆'}  ${t}: ${msg}`); },
  onRetry(a, m)       { console.log(`  ↺ retry ${a}/${m}`); },
  onTurnComplete(t,v) { console.log(`  turn ${t} complete (${v.list().length} VFS files)`); },
};

// Hydrate VFS
const vfs = createVFS();
for (const f of ['agent-core.js', 'agent-loop.js', 'agent-rsi.js']) {
  try {
    vfs.write(`/harness/${f}`, readFileSync(new URL(f, import.meta.url), 'utf8'));
    vfs.markClean(`/harness/${f}`);
  } catch {}
}

// Disk persistence
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
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

const evalPrompt = 'Write a function called fibonacci(n) that returns the nth fibonacci number. Test it for n=0 through n=9, verify the results are [0,1,1,2,3,5,8,13,21,34], and save a report to /artifacts/fib.md';

const mutatePrompt = [
  'Read /harness/agent-loop.js — this is your own harness code.',
  '',
  'CRITICAL — structural contract you MUST preserve when rewriting this file:',
  ...CONTRACT_RULES.map(r => `  - ${r}`),
  '',
  'The safest approach: modify only the SYSTEM prompt string, then write the entire file back.',
  'Do NOT rewrite the runTurn function or module structure from scratch.',
  '',
  'Propose ONE targeted improvement that could help the agent complete tasks more reliably.',
  'Write the improved version back to /harness/agent-loop.js.',
  'Explain what you changed in a progress emit before the done emit.',
].join('\n');

console.log('\n══════════════════════════════════════════');
console.log('  RSI DEMO — 2 experiments');
console.log('  eval: fibonacci implementation + test');
console.log('══════════════════════════════════════════\n');

try {
  const results = await runRSI({
    evalPrompt,
    mutatePrompt,
    budget: 2,
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

  // Show experiment journal
  const journal = vfs.read('/memory/experiments.jsonl');
  if (journal) {
    console.log('  /memory/experiments.jsonl:');
    for (const line of journal.trim().split('\n')) {
      const e = JSON.parse(line);
      console.log(`    ${e.ts} ${e.kept ? 'kept' : 'disc'} — ${e.reason}`);
    }
    console.log();
  }

  // Show harness diff summary
  const loop = vfs.read('/harness/agent-loop.js');
  if (loop) {
    console.log(`  /harness/agent-loop.js: ${loop.split('\n').length} lines (${loop.length} bytes)`);
    if (vfs.isDirty('/harness/agent-loop.js')) console.log('    (modified ●)');
  }

  // Show artifacts
  const fib = vfs.read('/artifacts/fib.md');
  if (fib) {
    console.log('\n  /artifacts/fib.md:');
    console.log(fib.split('\n').map(l => '    ' + l).join('\n'));
  }

  console.log('\n══════════════════════════════════════════');
  console.log('  DONE');
  console.log('══════════════════════════════════════════\n');

} catch (err) {
  console.error('Fatal:', err.message);
  process.exit(1);
}
