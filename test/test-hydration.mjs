#!/usr/bin/env node
import { createVFS } from '../src/core/agent-core.js';
import { SYSTEM, MAX_RETRIES, runTurn } from '../src/harness/agent-loop.js';
import { runSkillRSI, buildSkillScorer } from '../src/harness/agent-rsi.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Verify exports
console.log('agent-core.js: OK');
console.log('agent-loop.js: SYSTEM length=' + SYSTEM.length + ', MAX_RETRIES=' + MAX_RETRIES + ', runTurn=' + typeof runTurn);
console.log('agent-rsi.js:  runSkillRSI=' + typeof runSkillRSI + ', buildSkillScorer=' + typeof buildSkillScorer);

// Simulate hydrateHarness
const vfs = createVFS();
const harnessFiles = { 'agent-core.js': 'src/core', 'agent-loop.js': 'src/harness', 'agent-rsi.js': 'src/harness' };
for (const [f, dir] of Object.entries(harnessFiles)) {
  vfs.write('/harness/' + f, readFileSync(join(ROOT, dir, f), 'utf8'));
  vfs.markClean('/harness/' + f);
}
vfs.write('/harness/agent-harness.mjs', readFileSync(join(ROOT, 'agent-harness.mjs'), 'utf8'));
vfs.markClean('/harness/agent-harness.mjs');
const ad = join(ROOT, 'artifacts');
if (existsSync(ad)) {
  for (const e of readdirSync(ad, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    vfs.write('/artifacts/' + e.name, readFileSync(join(ad, e.name), 'utf8'));
    vfs.markClean('/artifacts/' + e.name);
  }
}
const md = join(ROOT, 'memory');
if (existsSync(md)) {
  for (const f of readdirSync(md)) {
    vfs.write('/memory/' + f, readFileSync(join(md, f), 'utf8'));
    vfs.markClean('/memory/' + f);
  }
}

const paths = vfs.list();
console.log('\nVFS hydrated: ' + paths.length + ' files');
const groups = {};
for (const p of paths) {
  const dir = '/' + p.split('/')[1] + '/';
  groups[dir] = (groups[dir] || 0) + 1;
}
for (const [dir, count] of Object.entries(groups)) {
  console.log('  ' + dir + ' -> ' + count + ' files');
}
console.log('\nAll checks passed.');
