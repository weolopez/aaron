#!/usr/bin/env node
/**
 * test-system-prompt.mjs — Verify SYSTEM prompt structure and skill delegation
 *
 * Checks:
 *   1. Required sections are present (output format, API reference, emit types, conventions)
 *   2. github-pr skill delegation: SYSTEM has the pointer, NOT the full workflow recipe
 *   3. Universal patterns (error handling, multi-step, backtick warning) remain in SYSTEM
 *   4. Skill index picks up github-pr (the detailed recipe now lives there)
 *   5. SYSTEM prompt stays within a reasonable token budget
 */

import { SYSTEM, buildSkillIndex } from '../src/agent-loop.js';
import { createVFS } from '../src/agent-core.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let passed = 0, failed = 0;

function ok(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

// ── 1. Required always-present sections ──────────────────────────

console.log('\nRequired sections in SYSTEM:');
ok(SYSTEM.includes('Your ONLY output is a single JavaScript code block'),
  'Output format constraint present');
ok(SYSTEM.includes('PRE-FLIGHT CHECKLIST'),
  'PRE-FLIGHT CHECKLIST present');
ok(SYSTEM.includes('context.vfs.read') && SYSTEM.includes('context.vfs.write'),
  'VFS API reference present');
ok(SYSTEM.includes("context.emit"),
  'context.emit documented');
ok(SYSTEM.includes("type: 'done'"),
  "Emit types include 'done'");
ok(SYSTEM.includes("type: 'blocked'"),
  "Emit types include 'blocked'");
ok(SYSTEM.includes('do NOT fake done') || SYSTEM.includes('never omit the terminal emit'),
  'Honest-failure convention documented');
ok(SYSTEM.includes('context.commit'),
  'context.commit documented');
ok(SYSTEM.includes('AVOID NESTED BACKTICK'),
  'Backtick conflict warning present');
ok(SYSTEM.includes('ERROR HANDLING GUIDE'),
  'Error handling guide present');
ok(SYSTEM.includes('MULTI-STEP WORKFLOW PATTERN'),
  'Multi-step workflow pattern present');
ok(SYSTEM.includes('/scratch/') && SYSTEM.includes('/artifacts/'),
  'Conventions (path layout) present');
ok(SYSTEM.includes("context.emit({ type: 'done'") || SYSTEM.includes("type: 'done'"),
  'Done-emit convention present');

// ── 2. github-pr delegated to skill ──────────────────────────────

console.log('\nGitHub delegation (verbose recipe in skill, not SYSTEM):');
ok(SYSTEM.includes('context.github'),
  'context.github mentioned (existence hint)');
ok(SYSTEM.includes('github-pr/SKILL.md'),
  'Pointer to github-pr skill present');

// These step-by-step lines should no longer be in SYSTEM
ok(!SYSTEM.includes('createBranch('),
  'createBranch() recipe NOT in SYSTEM');
ok(!SYSTEM.includes('createPR('),
  'createPR() recipe NOT in SYSTEM');
ok(!SYSTEM.includes('GITHUB WORKFLOW PATTERN'),
  'GITHUB WORKFLOW PATTERN block NOT in SYSTEM');

// ── 3. Token budget ───────────────────────────────────────────────

console.log('\nToken budget:');
// Rough char-to-token ratio ~4:1. Keep SYSTEM under ~900 tokens (~3600 chars).
// The skill index is appended separately, so this measures the base prompt only.
// The verbose GitHub workflow recipe (~450 chars) was moved to the github-pr skill.
const charCount = SYSTEM.length;
ok(charCount < 4000,
  `SYSTEM base is ${charCount} chars (< 4000 target)`);

// ── 4. github-pr skill has the full recipe ────────────────────────

console.log('\ngithub-pr skill completeness:');
const skillPath = join(ROOT, 'skills/github-pr/SKILL.md');
ok(existsSync(skillPath), 'skills/github-pr/SKILL.md exists on disk');

if (existsSync(skillPath)) {
  const skill = readFileSync(skillPath, 'utf8');
  ok(skill.includes('createBranch'), 'Skill documents createBranch');
  ok(skill.includes('createPR'),     'Skill documents createPR');
  ok(skill.includes('context.commit'), 'Skill documents context.commit with branch arg');
  ok(skill.includes('pr_url') || skill.includes('html_url'), 'Skill shows how to emit PR URL');
}

// ── 5. Skill index includes github-pr ────────────────────────────

console.log('\nSkill index:');
const vfs = createVFS();
function loadDirSync(baseDir, vfsPrefix) {
  if (!existsSync(baseDir)) return;
  (function walk(dir, prefix) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const d = join(dir, e.name), v = prefix + e.name;
      if (e.isDirectory()) walk(d, v + '/');
      else { try { vfs.write(v, readFileSync(d, 'utf8')); vfs.markClean(v); } catch {} }
    }
  })(baseDir, vfsPrefix);
}
loadDirSync(join(ROOT, 'skills'), '/skills/');

const idx = buildSkillIndex(vfs);
ok(idx.includes('github-pr'),    'github-pr appears in skill index');
ok(idx.includes('adr-writer'),   'adr-writer appears in skill index');
ok(idx.includes('code-planner'), 'code-planner appears in skill index');
ok(idx.includes('bug-fixer'),    'bug-fixer appears in skill index');
ok(idx.includes('verify'),       'verify appears in skill index');
ok(idx.includes('refactor'),     'refactor appears in skill index');
ok(idx.includes('init'),         'init appears in skill index');
ok(idx.includes("context.vfs.read('/skills/github-pr/SKILL.md')"),
  'Skill index entry shows how to read github-pr skill');

// ── 6. verify skill has the right protocol ───────────────────────

console.log('\nverify skill protocol:');
const verifySkillPath = join(ROOT, 'skills/verify/SKILL.md');
ok(existsSync(verifySkillPath), 'skills/verify/SKILL.md exists on disk');
if (existsSync(verifySkillPath)) {
  const verifySkill = readFileSync(verifySkillPath, 'utf8');
  ok(verifySkill.includes('blocked'), 'verify skill emits blocked on failure');
  ok(verifySkill.includes('PASS') && verifySkill.includes('FAIL'), 'verify skill has PASS/FAIL protocol');
  ok(verifySkill.includes('ground truth') || verifySkill.includes('claim'), 'verify encodes ground-truth principle');
  ok(!verifySkill.includes("type: 'done'") ||
     verifySkill.indexOf("type: 'blocked'") < verifySkill.indexOf("type: 'done'"),
    'verify emits blocked before done in failure path');
}

// ── 7. workflow-runner halts on blocked ───────────────────────────

console.log('\nworkflow-runner blocked halt:');
const runnerPath = join(ROOT, 'src/workflow-runner.js');
ok(existsSync(runnerPath), 'workflow-runner.js exists');
if (existsSync(runnerPath)) {
  const runner = readFileSync(runnerPath, 'utf8');
  ok(runner.includes('onStepBlocked'), 'workflow-runner has onStepBlocked hook');
  ok(runner.includes("ev.type === 'blocked'") || runner.includes("type === 'blocked'"),
    'workflow-runner intercepts blocked events');
  ok(runner.includes('return;') && runner.includes('stepBlockedReason'),
    'workflow-runner halts (returns) when a step is blocked');
}

// ── 9. SYSTEM + skill index stays under combined budget ───────────

console.log('\nCombined SYSTEM + skill index budget:');
const combined = SYSTEM + idx;
ok(combined.length < 10000,
  `SYSTEM + skill index is ${combined.length} chars (< 10000)`);

// ── Summary ───────────────────────────────────────────────────────

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
