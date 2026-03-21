#!/usr/bin/env node
import { createVFS } from './agent-core.js';
import { SYSTEM, MAX_RETRIES, runTurn } from './agent-loop.js';
import { runRSI, CONTRACT_RULES } from './agent-rsi.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Verify exports
console.log('agent-core.js: OK');
console.log('agent-loop.js: SYSTEM length=' + SYSTEM.length + ', MAX_RETRIES=' + MAX_RETRIES + ', runTurn=' + typeof runTurn);
console.log('agent-rsi.js:  runRSI=' + typeof runRSI + ', CONTRACT_RULES=' + CONTRACT_RULES.length + ' rules');

// Simulate hydrateHarness
const vfs = createVFS();
for (const f of ['agent-core.js', 'agent-loop.js', 'agent-rsi.js', 'agent-harness.mjs']) {
  vfs.write('/harness/' + f, readFileSync(join(__dirname, f), 'utf8'));
  vfs.markClean('/harness/' + f);
}
const ad = join(__dirname, 'artifacts');
if (existsSync(ad)) {
  for (const f of readdirSync(ad)) {
    vfs.write('/artifacts/' + f, readFileSync(join(ad, f), 'utf8'));
    vfs.markClean('/artifacts/' + f);
  }
}
const md = join(__dirname, 'memory');
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
