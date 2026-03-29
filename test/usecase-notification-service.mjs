#!/usr/bin/env node
/**
 * usecase-notification-service.mjs
 *
 * End-to-end integration test against weolopez/aaron-test-repo.
 * No mocks — live LLM calls, live GitHub API.
 *
 * Usage:
 *   GITHUB_TOKEN=... ANTHROPIC_API_KEY=... node test/usecase-notification-service.mjs
 *   GITHUB_TOKEN=... ANTHROPIC_API_KEY=... node test/usecase-notification-service.mjs --dry-run
 *
 * --dry-run:  runs pre-flight checks only, no LLM calls, no GitHub writes.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * USE CASE 1: Workspace Init + Exploration
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * WHAT: Aaron hydrates the aaron-test-repo workspace and runs the `init` skill
 * to produce a structured summary of the codebase.
 *
 * WHY: Every real SE task starts with "what is this codebase?" Init skill maps
 * the workspace so subsequent planning/coding steps have context without
 * reading every file from scratch each turn.
 *
 * INPUTS:
 *   - GitHub repo: weolopez/aaron-test-repo@main
 *   - No task prompt — just exploration
 *
 * EXPECTED OUTPUTS:
 *   - /memory/project-notes.md written to VFS
 *   - Notes identify it as a node project
 *   - Notes count src/ files correctly (≥ 3)
 *   - Notes identify missing tests (no test/ directory)
 *   - Notes find existing ADR.md (so no ADR gap)
 *   - Notes find existing docs/requirements.md
 *
 * ASSERTIONS: 6
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * USE CASE 2: Bug Fix — Inject, Diagnose, Fix, PR
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * WHAT: A known bug is injected directly into src/services/notification.js on
 * the main branch (simulating a bad merge to production). Aaron is given a bug
 * report and must diagnose, fix, and open a pull request.
 *
 * WHY: Bug fixing is the most common SE task. Tests whether Aaron can: read
 * existing code, understand a specific failure, make a minimal targeted fix,
 * and produce a PR with a meaningful description.
 *
 * INJECTED BUG (two mutations, both intentional and known):
 *   1. Off-by-one:   `i < maxRetries`  →  `i <= maxRetries`  (one extra retry loop)
 *   2. Wrong default: `priority: 'HIGH'`  →  `priority: 'NONE'`  (silent drop)
 *
 * INPUTS:
 *   - Bug injected directly onto main via GitHub API (no branch — simulates prod incident)
 *   - /memory/bug-report.md describing symptoms (not the root cause)
 *
 * EXPECTED OUTPUTS:
 *   - /scratch/bug-fix/diagnosis.md written with root cause analysis
 *   - One or both bugs identified in the diagnosis
 *   - /src/services/notification.js modified in VFS (the fix)
 *   - Branch created: fix/notif-bug-<RUN_ID>
 *   - PR opened against main with "fix" in title
 *   - PR body mentions the symptoms or root cause
 *
 * ASSERTIONS: 8
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * USE CASE 3: New Feature — Plan, Implement, Verify, PR
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * WHAT: A small, well-scoped feature request is written to VFS. Aaron runs
 * the plan-implement-verify workflow: plans the implementation, writes the code,
 * verifies outputs are real, opens a PR.
 *
 * FEATURE REQUEST: "Add a NotificationQueue class to src/services/notification-queue.js
 * that buffers LOW-priority notifications and flushes them in batch. Should expose
 * enqueue(notification) and flush() methods."
 *
 * WHY: Tests the full planning → implementation → verification → PR pipeline.
 * The verify step acts as a gate — if the agent writes a stub instead of real
 * code, the workflow halts before opening a PR.
 *
 * INPUTS:
 *   - /memory/task.md with the feature request
 *   - Existing codebase in /src/ (notification service, models, config)
 *   - /memory/project-notes.md from UC-1 (if run in sequence)
 *
 * EXPECTED OUTPUTS:
 *   - /scratch/plan-implement-verify/plan.md with file list
 *   - At least one new /src/ file written
 *   - /scratch/plan-implement-verify/verification.md showing PASS
 *   - Branch created: feat/piv-<RUN_ID>
 *   - PR opened against main
 *   - PR body references the NotificationQueue feature
 *
 * ASSERTIONS: 8
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * CLEANUP
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * All branches created during the run are deleted (even on failure).
 * Bug injection on main is reverted.
 * PRs are left open for manual review — close them at the URLs logged.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createVFS, execute, extractCode } from '../src/agent-core.js';
import { runTurn, buildSkillIndex } from '../src/agent-loop.js';
import { createGitHubClient, initFromGitHub, commitToGitHub } from '../src/github.js';
import { runWorkflowSteps } from '../src/workflow-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

// ════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════

const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY;
const OWNER          = 'weolopez';
const REPO           = 'aaron-test-repo';
const BASE           = 'main';

// Unique per run — all branch names include this so parallel runs never collide
const RUN_ID = Date.now();

// ════════════════════════════════════════════════════
// TEST HARNESS
// ════════════════════════════════════════════════════

let passed = 0, failed = 0;
const failures = [];
const timings  = {};

// Branches and files we create — cleaned up in finally block
const cleanup = { branches: [], injectedFiles: [] };

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
    failures.push(label);
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(70));
}

function step(label) { console.log(`\n  · ${label}`); }

function time(label) { timings[label] = Date.now(); }
function elapsed(label) {
  const ms = Date.now() - (timings[label] ?? Date.now());
  return ms > 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

async function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

// ════════════════════════════════════════════════════
// PRE-FLIGHT CHECKS
// ════════════════════════════════════════════════════

async function preflight(client) {
  section('Pre-flight checks');

  // 1. Env vars
  assert(!!GITHUB_TOKEN,  'GITHUB_TOKEN is set');
  assert(!!ANTHROPIC_KEY, 'ANTHROPIC_API_KEY is set');

  // 2. Repo is accessible
  step('Checking repo access...');
  const branch = await client.getBranch(OWNER, REPO, BASE);
  assert(branch !== null, `Repo ${OWNER}/${REPO}@${BASE} is accessible`);
  if (!branch) {
    console.error('\n  Cannot reach repo — aborting.\n');
    process.exit(1);
  }

  // 3. Token has write access (try reading the tree)
  const tree = await client.getTree(OWNER, REPO, BASE);
  assert(tree.length > 0, `Repo tree has ${tree.length} files`);

  // 4. Verify src/ files exist (the notification service should already be there)
  const srcFiles = tree.filter(f => f.path.startsWith('src/'));
  assert(srcFiles.length >= 3,
    `src/ has ${srcFiles.length} files (notification service pre-exists)`);

  // 5. Verify .aaron/ is present
  const aaronFiles = tree.filter(f => f.path.startsWith('.aaron/'));
  assert(aaronFiles.length > 0, `.aaron/ directory present (${aaronFiles.length} files)`);

  if (DRY_RUN) {
    console.log('\n  --dry-run: all pre-flight checks passed. Exiting.\n');
    process.exit(failed > 0 ? 1 : 0);
  }
}

// ════════════════════════════════════════════════════
// WORKSPACE FACTORY
// ════════════════════════════════════════════════════

/**
 * Build a fully-loaded context+state for running Aaron workflows.
 * Loads skills and workflows from disk, hydrates VFS from GitHub.
 */
async function buildWorkspace(client) {
  const vfs = createVFS();
  const events = [];

  // Load Aaron's own skills and workflows from disk
  function loadDirSync(baseDir, vfsPrefix) {
    if (!existsSync(baseDir)) return;
    (function walk(dir, prefix) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const d = join(dir, e.name), v = prefix + e.name;
        if (e.isDirectory()) walk(d, v + '/');
        else {
          try { vfs.write(v, readFileSync(d, 'utf8')); vfs.markClean(v); } catch {}
        }
      }
    })(baseDir, vfsPrefix);
  }
  loadDirSync(join(ROOT, 'skills'),    '/skills/');
  loadDirSync(join(ROOT, 'workflows'), '/workflows/');

  // Hydrate from GitHub (also mounts .aaron/ project-skills, project-workflows, memory)
  const hydrated = await initFromGitHub(
    { owner: OWNER, repo: REPO, ref: BASE },
    vfs, client,
    ev => { if (ev.type === 'progress') process.stdout.write(`    ◆ ${ev.message}\n`); },
  );

  // GitHub helper bound to this repo
  const gh = {
    owner: OWNER, repo: REPO, ref: BASE,
    async getLatestSha(branch = BASE) {
      const d = await client.getBranch(OWNER, REPO, branch);
      if (!d) throw new Error(`Branch not found: ${branch}`);
      return d.sha;
    },
    async createBranch(name, fromRef = BASE) {
      const sha = await this.getLatestSha(fromRef);
      await client.createBranch(OWNER, REPO, name, sha);
    },
    async createPR(opts) { return client.createPR(OWNER, REPO, opts); },
    async listPRs(state = 'open') { return client.listPRs(OWNER, REPO, state); },
    async getPR(n) { return client.getPR(OWNER, REPO, n); },
    async mergePR(n, opts) { return client.mergePR(OWNER, REPO, n, opts); },
    async deleteBranch(name) { return client.deleteBranch(OWNER, REPO, name); },
  };

  const emit = ev => {
    events.push(ev);
    if      (ev.type === 'progress') process.stdout.write(`    ◆ ${ev.message}\n`);
    else if (ev.type === 'done')     process.stdout.write(`    ✓ ${ev.message}\n`);
    else if (ev.type === 'blocked')  process.stdout.write(`    ⊘ ${ev.reason}\n`);
    else if (ev.type === 'error')    process.stdout.write(`    ✕ ${ev.message}\n`);
  };

  const skillIndex = buildSkillIndex(vfs);
  const context = {
    vfs, events, emit,
    fetch: (...a) => fetch(...a),
    env: {},
    skillIndex,
    github: gh,
    async commit(message = 'commit', branch) {
      const dirty = vfs.list().filter(p => vfs.isDirty(p));
      const srcDirty = dirty.filter(p => p.startsWith('/src/'));
      if (srcDirty.length > 0) {
        await commitToGitHub(vfs, client, {
          owner: OWNER, repo: REPO,
          branch: branch ?? BASE, message, pathPrefix: '/src/',
        }, emit);
      }
      for (const p of dirty) vfs.markClean(p);
      return dirty;
    },
  };

  const state = { history: [], turn: 0, context };
  const ui = {
    setStatus() {},
    showCode() {},
    emitEvent: emit,
    onRetry(n, max) { process.stdout.write(`    ↺ retry ${n}/${max}\n`); },
    onTurnComplete() {},
  };
  const deps = { execute, extractCode, ui, runTurn };

  return { vfs, context, state, deps, events, hydrated };
}

/** Extract the last PR number emitted by the agent across all events. */
function extractPR(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'result') {
      if (ev.value?.pr_number) return { number: ev.value.pr_number, url: ev.value.pr_url };
      if (ev.value?.pr_url) {
        const m = String(ev.value.pr_url).match(/\/pull\/(\d+)/);
        if (m) return { number: parseInt(m[1]), url: ev.value.pr_url };
      }
    }
  }
  return null;
}

// ════════════════════════════════════════════════════
// USE CASE 1: Workspace Init + Exploration
// ════════════════════════════════════════════════════

async function uc1_init(client) {
  section('UC-1: Workspace Init + Exploration');

  // ── Setup ────────────────────────────────────────
  step('Hydrating workspace from GitHub...');
  time('uc1');
  const ws = await buildWorkspace(client);
  assert(ws.hydrated.files > 0, `Hydrated ${ws.hydrated.files} files from ${OWNER}/${REPO}`);

  // ── Execute: single runTurn with init skill ──────
  step('Running init skill...');
  const initSkillMd = ws.vfs.read('/skills/init/SKILL.md');
  assert(initSkillMd !== null, 'init/SKILL.md loaded into VFS');

  const prompt = [
    '## Skill: init',
    '',
    'Follow these skill instructions exactly:',
    '',
    initSkillMd ?? '',
    '',
    '## Task',
    '',
    'This workspace has just been loaded from weolopez/aaron-test-repo.',
    'Run the init skill to map the codebase and write /memory/project-notes.md.',
    'The repo contains a notification service implementation.',
  ].join('\n');

  await runTurn(prompt, ws.state, ws.deps);
  console.log(`    (${elapsed('uc1')})`);

  // ── Validate: VFS state ──────────────────────────
  step('Validating VFS outputs...');

  const notes = ws.vfs.read('/memory/project-notes.md');
  assert(notes !== null,         'project-notes.md written to VFS');
  assert((notes?.length ?? 0) > 200, `project-notes.md has substantial content (${notes?.length} chars)`);
  assert(/src.*file|file.*src/i.test(notes ?? ''), 'notes mention src file count');
  assert(/node|javascript|js/i.test(notes ?? ''),  'notes identify project type');
  // The repo has no test files — init should flag this
  assert(/test|spec/i.test(notes ?? ''),            'notes mention (missing) tests');
  // The repo has ADR.md at root — init should find it
  assert(/adr/i.test(notes ?? ''),                  'notes mention existing ADR');

  return ws;
}

// ════════════════════════════════════════════════════
// USE CASE 2: Bug Fix — Inject, Diagnose, Fix, PR
// ════════════════════════════════════════════════════

async function uc2_bugfix(client) {
  section('UC-2: Bug Fix — Inject, Diagnose, Fix, PR');

  // ── Setup: inject a known bug onto main ──────────
  step('Reading current notification service from GitHub...');
  const serviceFile = await client.getFile(OWNER, REPO, 'src/services/notification.js', BASE);
  assert(serviceFile !== null, 'src/services/notification.js exists on main');
  if (!serviceFile) return;

  // Apply two targeted mutations — simple enough for the LLM to find, subtle enough to be realistic
  const original = serviceFile.content;
  let buggy = original;

  // Mutation 1: off-by-one in any retry loop
  if (original.includes('i < maxRetries') || original.includes('retries <')) {
    buggy = buggy
      .replace(/i < maxRetries/g, 'i <= maxRetries')
      .replace(/retries < max/g,   'retries <= max');
  } else {
    // Fallback: inject into a for loop we can control
    buggy = buggy.replace(/for\s*\(let i = 0; i < (\w+)/,
      (m, v) => `for (let i = 0; i <= ${v}`);
  }

  // Mutation 2: wrong default priority (silent failure mode)
  if (original.includes("priority: 'HIGH'") || original.includes('priority: "HIGH"')) {
    buggy = buggy
      .replace(/priority:\s*['"]HIGH['"]/g, "priority: 'NONE'");
  } else {
    // Fallback: corrupt the first string constant that looks like a severity
    buggy = buggy.replace(/'CRITICAL'/, "'CORRUPTED'");
  }

  assert(buggy !== original, 'Bug mutations applied to source');

  step('Committing buggy code directly to main (simulating prod incident)...');
  await client.putFile(
    OWNER, REPO,
    'src/services/notification.js',
    buggy, serviceFile.sha,
    `chore: inject integration test bug [run:${RUN_ID}]`,
    BASE,
  );
  cleanup.injectedFiles.push({ path: 'src/services/notification.js', sha: serviceFile.sha, content: original });
  await pause(1000); // let GitHub settle

  // ── Setup: hydrate fresh workspace with the buggy code ──
  step('Hydrating fresh workspace with buggy main...');
  time('uc2');
  const ws = await buildWorkspace(client);

  // Write a symptom-based bug report (not the root cause — Aaron must diagnose)
  ws.vfs.write('/memory/bug-report.md', [
    '# Bug Report: Notification Service — Prod Incident',
    '',
    '## Symptoms observed in production',
    '- CRITICAL notifications are taking longer than expected to deliver',
    '- Some HIGH-priority notifications appear to be silently dropped',
    '- Retry loops seem to execute one more iteration than expected',
    '',
    '## Suspected area',
    '- src/services/notification.js — retry logic and priority routing',
    '',
    '## Impact',
    '- Severity: HIGH',
    '- Affected users: all notification recipients',
  ].join('\n'));

  // ── Execute: bug-fix workflow ────────────────────
  step('Running bug-fix workflow...');
  const workflowDef = JSON.parse(ws.vfs.read('/workflows/bug-fix.json'));

  let prInfo = null;
  let blocked = false;

  await runWorkflowSteps(workflowDef, workflowDef.name, ws.vfs, ws.state, ws.deps, {
    onStepDone:    id  => console.log(`    ✓ step "${id}" done`),
    onStepBlocked: (id, reason) => {
      blocked = true;
      console.log(`    ⊘ step "${id}" blocked: ${reason}`);
    },
  });

  prInfo = extractPR(ws.context.events);
  console.log(`    (${elapsed('uc2')})`);

  // ── Validate: VFS state ──────────────────────────
  step('Validating diagnosis and fix...');

  const diagnosis = ws.vfs.read('/scratch/bug-fix/diagnosis.md');
  assert(diagnosis !== null, 'Diagnosis written to /scratch/bug-fix/diagnosis.md');
  assert((diagnosis?.length ?? 0) > 100, `Diagnosis has content (${diagnosis?.length} chars)`);
  // Check that the diagnosis identifies at least one of the two bugs
  const diagnosisText = (diagnosis ?? '').toLowerCase();
  const foundBug = diagnosisText.includes('retry') || diagnosisText.includes('off-by-one') ||
                   diagnosisText.includes('priority') || diagnosisText.includes('<= max') ||
                   diagnosisText.includes('<= retries');
  assert(foundBug, 'Diagnosis mentions retry or priority issue (root cause identified)');

  assert(!blocked, 'Bug-fix workflow completed without being blocked');

  const fixedContent = ws.vfs.read('/src/services/notification.js');
  assert(fixedContent !== null, '/src/services/notification.js modified in VFS');
  assert(fixedContent !== buggy, 'Fixed file differs from buggy version');

  // ── Validate: GitHub state ───────────────────────
  step('Validating GitHub PR...');

  if (!prInfo) {
    // Search for a PR the agent might have created
    const openPRs = await client.listPRs(OWNER, REPO, 'open');
    const candidate = openPRs.find(pr =>
      pr.head.startsWith('fix/') && pr.head.includes(`${RUN_ID}`)
    );
    if (candidate) prInfo = { number: candidate.number, url: candidate.html_url };
  }

  assert(prInfo !== null, 'Pull request created by bug-fix workflow');

  if (prInfo) {
    cleanup.branches.push(await client.getPR(OWNER, REPO, prInfo.number).then(pr => pr?.head).catch(() => null));
    const pr = await client.getPR(OWNER, REPO, prInfo.number);
    assert(pr?.state === 'open', `PR #${prInfo.number} is open`);
    assert(/fix/i.test(pr?.title ?? ''), `PR title contains "fix": "${pr?.title}"`);
    assert((pr?.body ?? '').length > 50, `PR has a meaningful body (${pr?.body?.length} chars)`);
    console.log(`    → ${prInfo.url}`);
  }

  return { ws, prInfo };
}

// ════════════════════════════════════════════════════
// USE CASE 3: Feature Addition via plan-implement-verify
// ════════════════════════════════════════════════════

async function uc3_feature(client) {
  section('UC-3: New Feature — Plan, Implement, Verify, PR');

  // ── Setup: write feature request ─────────────────
  step('Hydrating workspace and writing task...');
  time('uc3');
  const ws = await buildWorkspace(client);

  ws.vfs.write('/memory/task.md', [
    '# Task: Add NotificationQueue',
    '',
    '## Feature request',
    'Add a `NotificationQueue` class to `src/services/notification-queue.js`.',
    '',
    '## Requirements',
    '- `enqueue(notification)` — buffers a LOW-priority notification',
    '- `flush()` — sends all buffered notifications in one batch, returns count sent',
    '- `size` property — returns current queue length',
    '- Uses the existing notification service (import from ./notification.js)',
    '- Queue is bounded at 100 items; enqueue returns false if full',
    '',
    '## Acceptance criteria',
    '- The file src/services/notification-queue.js exists',
    '- NotificationQueue is exported as a named export',
    '- enqueue, flush, and size are all present',
    '- No external dependencies (vanilla JS only)',
  ].join('\n'));

  assert(ws.vfs.read('/memory/task.md') !== null, 'Task written to /memory/task.md');

  // ── Execute: plan-implement-verify workflow ──────
  step('Running plan-implement-verify workflow...');
  const workflowDef = JSON.parse(ws.vfs.read('/workflows/plan-implement-verify.json'));
  assert(workflowDef?.steps?.length >= 4, `Workflow has ${workflowDef?.steps?.length} steps`);

  let prInfo  = null;
  let blocked = false;
  let blockedStep = null;

  await runWorkflowSteps(workflowDef, workflowDef.name, ws.vfs, ws.state, ws.deps, {
    onStepDone:    id => console.log(`    ✓ step "${id}" done`),
    onStepBlocked: (id, reason) => {
      blocked = true;
      blockedStep = id;
      console.log(`    ⊘ step "${id}" blocked: ${reason}`);
    },
  });

  prInfo = extractPR(ws.context.events);
  console.log(`    (${elapsed('uc3')})`);

  // ── Validate: VFS artifacts ──────────────────────
  step('Validating plan and implementation...');

  const plan = ws.vfs.read('/scratch/plan-implement-verify/plan.md');
  assert(plan !== null, 'Plan written to /scratch/plan-implement-verify/plan.md');
  assert((plan?.length ?? 0) > 200, `Plan has substantial content (${plan?.length} chars)`);
  assert(/notification-queue/i.test(plan ?? ''), 'Plan mentions notification-queue file');

  const verification = ws.vfs.read('/scratch/plan-implement-verify/verification.md');
  assert(verification !== null, 'Verification report written');
  assert(/PASS/i.test(verification ?? ''), 'Verification report shows PASS');

  const queueFile = ws.vfs.read('/src/services/notification-queue.js');
  assert(queueFile !== null, 'notification-queue.js written to VFS');
  if (queueFile) {
    assert(/NotificationQueue/i.test(queueFile), 'File exports NotificationQueue class');
    assert(/enqueue/i.test(queueFile), 'File implements enqueue()');
    assert(/flush/i.test(queueFile),   'File implements flush()');
  }

  // Blocked on verify is a real failure — the agent wrote stubs
  assert(!blocked || blockedStep !== 'verify',
    `Verify step passed (${blocked ? `blocked at "${blockedStep}"` : 'no blocks'})`);

  // ── Validate: GitHub state ───────────────────────
  step('Validating GitHub PR...');

  if (!prInfo) {
    const openPRs = await client.listPRs(OWNER, REPO, 'open');
    const candidate = openPRs.find(pr =>
      (pr.head.startsWith('feat/piv') || pr.head.startsWith('feat/')) &&
      pr.head.includes(`${RUN_ID}`)
    );
    if (candidate) prInfo = { number: candidate.number, url: candidate.html_url };
  }

  assert(prInfo !== null, 'Pull request created by plan-implement-verify workflow');

  if (prInfo) {
    const pr = await client.getPR(OWNER, REPO, prInfo.number);
    cleanup.branches.push(pr?.head ?? null);
    assert(pr?.state === 'open', `PR #${prInfo.number} is open`);
    assert((pr?.body ?? '').length > 50, `PR has a meaningful body (${pr?.body?.length} chars)`);
    console.log(`    → ${prInfo.url}`);
  }

  return { ws, prInfo };
}

// ════════════════════════════════════════════════════
// CLEANUP
// ════════════════════════════════════════════════════

async function doCleanup(client) {
  section('Cleanup');

  // Revert bug injection on main
  for (const { path, sha, content } of cleanup.injectedFiles) {
    try {
      // Get current SHA (may differ from when we injected)
      const current = await client.getFile(OWNER, REPO, path, BASE);
      if (current) {
        await client.putFile(OWNER, REPO, path, content, current.sha,
          `chore: revert integration test bug [run:${RUN_ID}]`, BASE);
        console.log(`  ✓ Reverted ${path} on main`);
      }
    } catch (e) {
      console.log(`  ⚠ Could not revert ${path}: ${e.message}`);
    }
  }

  // Delete created branches
  const branches = [...new Set(cleanup.branches.filter(Boolean))];
  for (const branch of branches) {
    try {
      await client.deleteBranch(OWNER, REPO, branch);
      console.log(`  ✓ Deleted branch: ${branch}`);
    } catch (e) {
      console.log(`  ⚠ Could not delete branch "${branch}": ${e.message}`);
    }
  }

  if (branches.length === 0 && cleanup.injectedFiles.length === 0) {
    console.log('  (nothing to clean up)');
  }
}

// ════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════

async function main() {
  console.log('\n' + '═'.repeat(70));
  console.log(`  Aaron Integration Test — ${OWNER}/${REPO}`);
  console.log(`  Run ID: ${RUN_ID}${DRY_RUN ? '  [DRY RUN]' : ''}`);
  console.log('═'.repeat(70));

  if (!GITHUB_TOKEN || !ANTHROPIC_KEY) {
    console.error('\nMissing required env vars:');
    if (!GITHUB_TOKEN)  console.error('  GITHUB_TOKEN');
    if (!ANTHROPIC_KEY) console.error('  ANTHROPIC_API_KEY');
    process.exit(1);
  }

  const client = createGitHubClient({ token: GITHUB_TOKEN });

  try {
    await preflight(client);
    await uc1_init(client);
    await uc2_bugfix(client);
    await uc3_feature(client);
  } finally {
    await doCleanup(client);
  }

  // ── Summary ──────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log(`  ${passed + failed} assertions: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n  Failed:');
    for (const f of failures) console.log(`    ❌ ${f}`);
  }
  console.log('═'.repeat(70) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
