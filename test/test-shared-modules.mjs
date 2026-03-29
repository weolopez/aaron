/**
 * test-shared-modules.mjs
 *
 * Focused tests for new shared modules:
 * - src/commit.js
 * - src/commands.js
 *
 * Also includes a lightweight wiring regression check for agent-harness.mjs
 * to ensure the CLI uses the shared helpers.
 */

import { readFileSync } from 'node:fs';
import { createVFS } from '../src/agent-core.js';
import { createCommitFn } from '../src/commit.js';
import { parseWorkflowArgs, dispatchWorkflowCommand } from '../src/commands.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL: ${msg}`);
  }
}

console.log('\nparseWorkflowArgs:');

{
  const p = parseWorkflowArgs('');
  assert(p.action === 'list', 'empty args parse as list');
}

{
  const p = parseWorkflowArgs('create alpha build a thing');
  assert(p.action === 'create', 'create parses action');
  assert(p.name === 'alpha', 'create parses name');
  assert(p.goal === 'build a thing', 'create parses goal');
}

{
  const p = parseWorkflowArgs('improve alpha tighten prompts');
  assert(p.action === 'improve', 'improve parses action');
  assert(p.name === 'alpha', 'improve parses name');
  assert(p.feedback === 'tighten prompts', 'improve parses feedback');
}

{
  const p = parseWorkflowArgs('rsi alpha 7');
  assert(p.action === 'rsi', 'rsi parses action');
  assert(p.name === 'alpha', 'rsi parses name');
  assert(p.budget === 7, 'rsi parses budget');
}

{
  const p = parseWorkflowArgs('my-workflow');
  assert(p.action === 'run', 'fallback parses as run');
  assert(p.name === 'my-workflow', 'run parses workflow name');
}

console.log('\ndispatchWorkflowCommand:');

{
  const vfs = createVFS();
  const state = { history: [], turn: 0, context: { vfs } };
  let runTurnCalls = 0;
  const deps = {
    runTurn: async () => { runTurnCalls++; },
  };

  let lastError = '';
  const callbacks = {
    onError: (m) => { lastError = m; },
    onNotFound: () => {},
    onList: () => {},
    onUserMsg: () => {},
    onRSIStart: () => {},
    onRSIDone: () => {},
    onRunStart: () => {},
    stepCallbacks: {},
  };

  const res = await dispatchWorkflowCommand('create demo test goal', {
    vfs,
    state,
    deps,
    getLLMClient: () => null,
    callbacks,
  });

  assert(res.ok === true, 'create command returns ok=true');
  assert(runTurnCalls === 1, 'create command delegates to runTurn');
  assert(lastError === '', 'create command emits no error');
}

{
  const vfs = createVFS();
  const state = { history: [], turn: 0, context: { vfs } };
  const deps = { runTurn: async () => {} };
  let notFound = '';

  const callbacks = {
    onError: () => {},
    onNotFound: (name) => { notFound = name; },
    onList: () => {},
    onUserMsg: () => {},
    onRSIStart: () => {},
    onRSIDone: () => {},
    onRunStart: () => {},
    stepCallbacks: {},
  };

  const res = await dispatchWorkflowCommand('improve missing improve text', {
    vfs,
    state,
    deps,
    getLLMClient: () => null,
    callbacks,
  });

  assert(res.ok === false, 'improve on missing workflow returns ok=false');
  assert(notFound === 'missing', 'improve on missing workflow calls onNotFound');
}

{
  const vfs = createVFS();
  const state = { history: [], turn: 0, context: { vfs } };
  const deps = { runTurn: async () => {} };
  let listCount = -1;

  // Seed one workflow file for listWorkflows
  vfs.write('/workflows/demo.json', JSON.stringify({ name: 'demo', description: 'x', steps: [] }));
  vfs.markClean('/workflows/demo.json');

  const callbacks = {
    onError: () => {},
    onNotFound: () => {},
    onList: (arr) => { listCount = arr.length; },
    onUserMsg: () => {},
    onRSIStart: () => {},
    onRSIDone: () => {},
    onRunStart: () => {},
    stepCallbacks: {},
  };

  const res = await dispatchWorkflowCommand('list', {
    vfs,
    state,
    deps,
    getLLMClient: () => null,
    callbacks,
  });

  assert(res.ok === true, 'list command returns ok=true');
  assert(listCount === 1, 'list command returns workflows via callback');
}

console.log('\ncreateCommitFn:');

{
  const vfs = createVFS();
  vfs.write('/src/a.js', 'a');
  vfs.write('/memory/note.md', 'n');

  const flushCalls = [];
  const pushCalls = [];
  const emitted = [];

  const commit = createCommitFn({
    vfs,
    getGitHub: () => null,
    commitToGitHub: async (...args) => { pushCalls.push(args); },
    emit: (ev) => emitted.push(ev),
    onFlush: (_v, dirty) => flushCalls.push([...dirty]),
  });

  const dirty = await commit('msg');

  assert(dirty.length === 2, 'commit returns all dirty files');
  assert(flushCalls.length === 1, 'commit calls onFlush once');
  assert(pushCalls.length === 0, 'commit skips GitHub push when not configured');
  assert(vfs.isDirty('/src/a.js') === false, 'commit marks /src/a.js clean');
  assert(vfs.isDirty('/memory/note.md') === false, 'commit marks /memory/note.md clean');
  assert(emitted.length === 0, 'commit emits nothing on clean local-only success');
}

{
  const vfs = createVFS();
  vfs.write('/src/a.js', 'a');
  vfs.write('/workflows/w.json', '{}');
  vfs.write('/scratch/plan.md', 'x');

  const pushCalls = [];
  const commit = createCommitFn({
    vfs,
    getGitHub: () => ({ client: { kind: 'mock' }, config: { owner: 'o', repo: 'r', ref: 'main' } }),
    commitToGitHub: async (_vfs, _client, opts) => { pushCalls.push(opts); },
    emit: () => {},
    ghPrefixes: ['/src/', '/workflows/'],
  });

  await commit('hello', 'dev');

  assert(pushCalls.length === 2, 'commit pushes once per dirty configured prefix');
  assert(pushCalls[0].branch === 'dev', 'commit uses explicit branch override');
  assert(pushCalls.every(c => ['/src/', '/workflows/'].includes(c.pathPrefix)), 'commit pushes only configured prefixes');
}

{
  const vfs = createVFS();
  vfs.write('/src/a.js', 'a');

  const emitted = [];
  const commit = createCommitFn({
    vfs,
    getGitHub: () => ({ client: {}, config: { owner: 'o', repo: 'r', ref: 'main' } }),
    commitToGitHub: async () => { throw new Error('boom'); },
    emit: (ev) => emitted.push(ev),
  });

  await commit('msg');

  assert(emitted.some(ev => ev.type === 'progress' && String(ev.message || '').includes('GitHub push failed: boom')), 'commit emits progress on GitHub push failure');
  assert(vfs.isDirty('/src/a.js') === false, 'commit still marks files clean after push failure');
}

console.log('\nCLI wiring regression (agent-harness.mjs):');

{
  const cli = readFileSync(new URL('../agent-harness.mjs', import.meta.url), 'utf8');

  assert(cli.includes("import { createCommitFn } from './src/commit.js';"), 'CLI imports createCommitFn from shared module');
  assert(cli.includes("import { dispatchWorkflowCommand } from './src/commands.js';"), 'CLI imports dispatchWorkflowCommand from shared module');

  const createCommitCount = (cli.match(/createCommitFn\(/g) || []).length;
  assert(createCommitCount >= 3, 'CLI uses createCommitFn in all context builders');

  assert(cli.includes('await dispatchWorkflowCommand(wfArgs,'), 'CLI REPL workflow command delegates to dispatchWorkflowCommand');
  assert(!cli.includes("async commit(message = 'commit'"), 'CLI no longer has inline async commit implementation');
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('All tests passed\n');
