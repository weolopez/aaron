/**
 * test-usecase-modules.mjs
 *
 * Unit tests for:
 *   src/usecase-report.js  — createRunReport, startScenario, addStep,
 *                            addAssertion, finalizeReport, buildRecommendations
 *   src/usecase-runtime.js — extractPRFromEvents, createGitHubHelper,
 *                            createRecordingEmitter, createTestUiAdapter,
 *                            loadDirIntoVfs (smoke)
 *
 * No network calls. No GitHub API. No LLM.
 */

import {
  createRunReport,
  startScenario,
  addStep,
  addAssertion,
  finalizeReport,
  buildRecommendations,
} from '../src/test-support/usecase-report.js';

import {
  extractPRFromEvents,
  createGitHubHelper,
  createRecordingEmitter,
  createTestUiAdapter,
  loadDirIntoVfs,
} from '../src/test-support/usecase-runtime.js';

import { createVFS } from '../src/core/agent-core.js';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

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

// ─────────────────────────────────────────────────────────────
// createRunReport
// ─────────────────────────────────────────────────────────────
console.log('\ncreateRunReport:');

{
  const r = createRunReport({ owner: 'x', repo: 'y', suite: 'test' });
  assert(typeof r === 'object', 'returns an object');
  assert(r.meta.owner === 'x', 'meta.owner set');
  assert(r.meta.repo === 'y', 'meta.repo set');
  assert(r.meta.suite === 'test', 'meta.suite set');
  assert(typeof r.meta.startedAt === 'string', 'meta.startedAt is a string');
  assert(Array.isArray(r.scenarios), 'scenarios is array');
  assert(Array.isArray(r.assertions), 'assertions is array');
  assert(Array.isArray(r.recommendations), 'recommendations is array');
  assert(r.scenarios.length === 0, 'scenarios starts empty');
}

// ─────────────────────────────────────────────────────────────
// startScenario
// ─────────────────────────────────────────────────────────────
console.log('\nstartScenario:');

{
  const r = createRunReport({});
  const s = startScenario(r, 'uc1:init');
  assert(s.name === 'uc1:init', 'scenario name set');
  assert(typeof s.startedAt === 'string', 'startedAt set');
  assert(Array.isArray(s.steps), 'steps array present');
  assert(Array.isArray(s.assertions), 'assertions array present');
  assert(r.scenarios.length === 1, 'scenario pushed onto report');
  assert(r.scenarios[0] === s, 'same reference in report.scenarios');

  const s2 = startScenario(r, 'uc2:bugfix');
  assert(r.scenarios.length === 2, 'second scenario added');
  assert(s2.name === 'uc2:bugfix', 'second scenario name correct');
}

// ─────────────────────────────────────────────────────────────
// addStep
// ─────────────────────────────────────────────────────────────
console.log('\naddStep:');

{
  const r = createRunReport({});
  const s = startScenario(r, 'sc');
  addStep(s, 'Hydrate workspace');
  assert(s.steps.length === 1, 'step added');
  assert(s.steps[0].label === 'Hydrate workspace', 'step label correct');
  assert(s.steps[0].status === 'info', 'default status is info');
  assert(typeof s.steps[0].at === 'string', 'step has timestamp');

  addStep(s, 'Run workflow', 'pass', { duration: 42 });
  assert(s.steps.length === 2, 'second step added');
  assert(s.steps[1].status === 'pass', 'custom status set');
  assert(s.steps[1].details?.duration === 42, 'details passed through');
}

// ─────────────────────────────────────────────────────────────
// addAssertion
// ─────────────────────────────────────────────────────────────
console.log('\naddAssertion:');

{
  const r = createRunReport({});
  const s = startScenario(r, 'sc');

  addAssertion(r, s, 'PR exists', true);
  assert(r.assertions.length === 1, 'assertion added to report');
  assert(s.assertions.length === 1, 'assertion added to scenario');
  assert(r.assertions[0].passed === true, 'passed=true recorded');
  assert(r.assertions[0].label === 'PR exists', 'label correct');
  assert(r.assertions[0].scenario === 'sc', 'scenario name captured');

  addAssertion(r, s, 'Branch deleted', false);
  assert(r.assertions.length === 2, 'second assertion added');
  assert(r.assertions[1].passed === false, 'passed=false recorded');

  // null scenario is allowed
  addAssertion(r, null, 'env var set', true);
  assert(r.assertions.length === 3, 'assertion with null scenario added');
  assert(r.assertions[2].scenario === null, 'scenario field is null');
}

// ─────────────────────────────────────────────────────────────
// finalizeReport
// ─────────────────────────────────────────────────────────────
console.log('\nfinalizeReport:');

{
  const r = createRunReport({});
  const s = startScenario(r, 'sc');
  addAssertion(r, s, 'a', true);
  addAssertion(r, s, 'b', true);
  addAssertion(r, s, 'c', false);

  const result = finalizeReport(r);
  assert(result === r, 'returns same report object');
  assert(typeof r.meta.finishedAt === 'string', 'finishedAt set');
  assert(r.meta.summary.total === 3, 'summary.total correct');
  assert(r.meta.summary.passed === 2, 'summary.passed correct');
  assert(r.meta.summary.failed === 1, 'summary.failed correct');
  assert(Array.isArray(r.recommendations), 'recommendations populated');
}

// ─────────────────────────────────────────────────────────────
// buildRecommendations — rule triggers
// ─────────────────────────────────────────────────────────────
console.log('\nbuildRecommendations:');

{
  // All pass → maintenance rec
  const rPass = createRunReport({});
  const sPass = startScenario(rPass, 'sc');
  addStep(sPass, 'a'); addStep(sPass, 'b'); addStep(sPass, 'c');
  addAssertion(rPass, sPass, 'ok', true);
  addAssertion(rPass, sPass, 'ok2', true);
  const recs = buildRecommendations(rPass);
  const categories = recs.map(r => r.category);
  assert(categories.includes('maintenance'), 'all-pass triggers maintenance rec');
  assert(!categories.includes('reliability'), 'no reliability rec when all pass');

  // Has failures → reliability rec
  const rFail = createRunReport({});
  const sFail = startScenario(rFail, 'sc');
  addStep(sFail, 'a'); addStep(sFail, 'b'); addStep(sFail, 'c');
  addAssertion(rFail, sFail, 'bad', false);
  const failRecs = buildRecommendations(rFail);
  const failCats = failRecs.map(r => r.category);
  assert(failCats.includes('reliability'), 'failed assertion triggers reliability rec');
  assert(!failCats.includes('maintenance'), 'no maintenance rec when there are failures');
  assert(failRecs[0].evidence?.length > 0, 'evidence list populated for reliability rec');

  // Sparse scenario (<3 steps) → observability rec
  const rSparse = createRunReport({});
  const sSparse = startScenario(rSparse, 'sparse-sc');
  addStep(sSparse, 'onlyone');
  addAssertion(rSparse, sSparse, 'x', true);
  const sparseRecs = buildRecommendations(rSparse);
  const sparseCats = sparseRecs.map(r => r.category);
  assert(sparseCats.includes('observability'), 'sparse scenario triggers observability rec');

  // Empty report → no recommendations
  const rEmpty = createRunReport({});
  assert(buildRecommendations(rEmpty).length === 0, 'empty report has no recommendations');
}

// ─────────────────────────────────────────────────────────────
// extractPRFromEvents
// ─────────────────────────────────────────────────────────────
console.log('\nextractPRFromEvents:');

{
  // pr_number and pr_url present
  const events = [
    { type: 'progress', message: 'doing stuff' },
    { type: 'result', value: { pr_number: 42, pr_url: 'https://github.com/o/r/pull/42' } },
  ];
  const { prNumber, prUrl } = extractPRFromEvents(events);
  assert(prNumber === 42, 'extracts pr_number from result event');
  assert(prUrl === 'https://github.com/o/r/pull/42', 'extracts pr_url from result event');

  // pr_url only — number extracted via regex
  const events2 = [
    { type: 'result', value: { pr_url: 'https://github.com/o/r/pull/99' } },
  ];
  const { prNumber: n2, prUrl: u2 } = extractPRFromEvents(events2);
  assert(n2 === 99, 'extracts pr number from pr_url via regex');
  assert(u2 === 'https://github.com/o/r/pull/99', 'pr_url preserved in url-only mode');

  // Returns most recent result
  const events3 = [
    { type: 'result', value: { pr_number: 10 } },
    { type: 'result', value: { pr_number: 20 } },
  ];
  const { prNumber: n3 } = extractPRFromEvents(events3);
  assert(n3 === 20, 'returns most recent result event');

  // No result events
  const { prNumber: none } = extractPRFromEvents([{ type: 'progress', message: 'x' }]);
  assert(none === null, 'returns null when no result events');

  // Empty array
  const { prNumber: empty } = extractPRFromEvents([]);
  assert(empty === null, 'returns null for empty array');
}

// ─────────────────────────────────────────────────────────────
// createRecordingEmitter
// ─────────────────────────────────────────────────────────────
console.log('\ncreateRecordingEmitter:');

{
  const events = [];
  const emit = createRecordingEmitter(events, { print: false });

  emit({ type: 'progress', message: 'hello' });
  assert(events.length === 1, 'event recorded in array');
  assert(events[0].type === 'progress', 'event type preserved');
  assert(events[0].message === 'hello', 'event message preserved');

  emit({ type: 'done', message: 'finished' });
  assert(events.length === 2, 'second event recorded');

  const events2 = [];
  const emit2 = createRecordingEmitter(events2, { print: false });
  emit2({ type: 'error', message: 'boom' });
  assert(events2[0].type === 'error', 'error event recorded');
}

// ─────────────────────────────────────────────────────────────
// createTestUiAdapter
// ─────────────────────────────────────────────────────────────
console.log('\ncreateTestUiAdapter:');

{
  const events = [];
  const emit = (ev) => events.push(ev);
  const ui = createTestUiAdapter(emit);

  assert(typeof ui.setStatus === 'function', 'setStatus is a function');
  assert(typeof ui.showCode === 'function', 'showCode is a function');
  assert(typeof ui.emitEvent === 'function', 'emitEvent is a function');
  assert(typeof ui.onRetry === 'function', 'onRetry is a function');
  assert(typeof ui.onTurnComplete === 'function', 'onTurnComplete is a function');

  // emitEvent should route to the provided emit fn
  ui.emitEvent({ type: 'done', message: 'ok' });
  assert(events.length === 1, 'emitEvent routes to emit fn');
  assert(events[0].type === 'done', 'event type preserved via ui.emitEvent');

  // setStatus and showCode are no-ops — shouldn't throw
  let noop = false;
  try { ui.setStatus('working'); ui.showCode('x'); noop = true; } catch {}
  assert(noop, 'setStatus and showCode do not throw');
}

// ─────────────────────────────────────────────────────────────
// createGitHubHelper
// ─────────────────────────────────────────────────────────────
console.log('\ncreateGitHubHelper:');

{
  const calls = [];
  // Stub GitHub client
  const client = {
    getBranch: async (o, r, b) => { calls.push({ method: 'getBranch', o, r, b }); return { sha: 'abc123' }; },
    createBranch: async (o, r, n, s) => { calls.push({ method: 'createBranch', o, r, n, s }); },
    createPR: async (o, r, opts) => { calls.push({ method: 'createPR' }); return { number: 1 }; },
    listPRs: async (o, r, state) => { calls.push({ method: 'listPRs', state }); return []; },
    getPR: async (o, r, n) => { calls.push({ method: 'getPR', n }); return { number: n }; },
    mergePR: async (o, r, n, opts) => { calls.push({ method: 'mergePR' }); },
    deleteBranch: async (o, r, n) => { calls.push({ method: 'deleteBranch', n }); },
  };

  const gh = createGitHubHelper(client, { owner: 'myorg', repo: 'myrepo', ref: 'main', base: 'main' });

  assert(gh.owner === 'myorg', 'owner bound');
  assert(gh.repo === 'myrepo', 'repo bound');
  assert(gh.ref === 'main', 'ref bound');

  // getLatestSha
  const sha = await gh.getLatestSha();
  assert(sha === 'abc123', 'getLatestSha returns branch sha');
  assert(calls[0].method === 'getBranch', 'getLatestSha calls getBranch');

  // createBranch
  await gh.createBranch('feat/test');
  const createBranchCall = calls.find(c => c.method === 'createBranch');
  assert(createBranchCall !== undefined, 'createBranch delegates to client');
  assert(createBranchCall.n === 'feat/test', 'branch name passed');

  // listPRs
  await gh.listPRs('closed');
  const listCall = calls.find(c => c.method === 'listPRs');
  assert(listCall?.state === 'closed', 'listPRs passes state');

  // getPR
  const pr = await gh.getPR(7);
  assert(pr.number === 7, 'getPR returns result');

  // deleteBranch
  await gh.deleteBranch('feat/old');
  const deleteCall = calls.find(c => c.method === 'deleteBranch');
  assert(deleteCall?.n === 'feat/old', 'deleteBranch passes name');
}

// ─────────────────────────────────────────────────────────────
// loadDirIntoVfs (smoke — just skills directory)
// ─────────────────────────────────────────────────────────────
console.log('\nloadDirIntoVfs:');

{
  const skillsDir = join(ROOT, 'skills');
  if (existsSync(skillsDir)) {
    const vfs = createVFS();
    await loadDirIntoVfs(vfs, skillsDir, '/skills/');
    const files = vfs.list().filter(p => p.startsWith('/skills/'));
    assert(files.length > 0, `loaded ${files.length} files from skills/ into VFS`);
    assert(files.some(p => p.endsWith('SKILL.md')), 'at least one SKILL.md loaded');
  } else {
    // No skills directory in this checkout — skip gracefully
    assert(true, 'skills/ dir not present — loadDirIntoVfs skipped (ok)');
  }

  // Non-existent directory should not throw
  const vfs2 = createVFS();
  let threw = false;
  try {
    await loadDirIntoVfs(vfs2, join(ROOT, '__nonexistent__'), '/x/');
  } catch {
    threw = true;
  }
  assert(!threw, 'loadDirIntoVfs does not throw for missing directory');
  assert(vfs2.list().length === 0, 'VFS empty after loading missing directory');
}

// ─────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
