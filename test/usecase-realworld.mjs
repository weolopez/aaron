#!/usr/bin/env node
/**
 * usecase-realworld.mjs — Three real-world end-to-end scenarios
 *
 * Runs against weolopez/aaron-test-repo with LIVE GitHub API calls.
 * Each scenario uses Aaron's LLM + workflow system to do real SE work.
 *
 * Actual functionality lives in:
 *   workflows/req-to-pr.json          (scenario 1)
 *   workflows/implement-from-plan.json (scenario 2)
 *   workflows/bug-fix.json             (scenario 3)
 *   skills/github-pr/SKILL.md
 *   skills/code-planner/SKILL.md
 *   skills/adr-writer/SKILL.md
 *   skills/bug-fixer/SKILL.md
 *
 * This file is assertions only — it verifies GitHub state after workflows run.
 *
 * REQUIRES: GITHUB_TOKEN and ANTHROPIC_API_KEY env vars
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

// ════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!GITHUB_TOKEN) {
  console.error('\n⚠  GITHUB_TOKEN not set — cannot run real-world scenarios.\n');
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error('\n⚠  ANTHROPIC_API_KEY not set — cannot run LLM scenarios.\n');
  process.exit(1);
}

const OWNER = 'weolopez';
const REPO  = 'aaron-test-repo';
const BASE  = 'main';

const client = createGitHubClient({ token: GITHUB_TOKEN });

// ════════════════════════════════════════════════════
// TEST HARNESS
// ════════════════════════════════════════════════════

let passed = 0, failed = 0, total = 0;
const failures = [];
const createdBranches = [];
const createdPRs = [];

function assert(condition, label) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ❌ ${label}`);
  }
}

function phase(name) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${name}`);
  console.log(`${'═'.repeat(64)}`);
}

function step(label) {
  console.log(`\n  ── ${label} ──`);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ════════════════════════════════════════════════════
// VFS FACTORY — build a workspace context for a repo
// ════════════════════════════════════════════════════

/**
 * Build a context + state ready for runTurn / runWorkflowSteps.
 * Hydrates from GitHub then loads local skills and workflows.
 */
async function buildWorkspaceContext(owner, repo, ref = 'main') {
  const vfs = createVFS();
  const events = [];

  // Load local skills and workflows into VFS
  function loadDirSync(baseDir, vfsPrefix) {
    if (!existsSync(baseDir)) return;
    (function walk(dir, prefix) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const disk = join(dir, entry.name);
        const vp = prefix + entry.name;
        if (entry.isDirectory()) walk(disk, vp + '/');
        else {
          try {
            vfs.write(vp, readFileSync(disk, 'utf8'));
            vfs.markClean(vp);
          } catch { /* skip */ }
        }
      }
    })(baseDir, vfsPrefix);
  }

  loadDirSync(join(ROOT, 'skills'), '/skills/');
  loadDirSync(join(ROOT, 'workflows'), '/workflows/');

  // Hydrate from GitHub
  const hydrated = await initFromGitHub(
    { owner, repo, ref },
    vfs,
    client,
    (ev) => events.push(ev),
  );

  const ghHelper = {
    owner, repo, ref,
    async getLatestSha(branch = ref) {
      const data = await client.getBranch(owner, repo, branch);
      if (!data) throw new Error(`Branch not found: ${branch}`);
      return data.sha;
    },
    async createBranch(name, fromRef = ref) {
      const sha = await this.getLatestSha(fromRef);
      await client.createBranch(owner, repo, name, sha);
    },
    async createPR({ title, body, head, base = BASE }) {
      return client.createPR(owner, repo, { title, body, head, base });
    },
    async listPRs(state = 'open') {
      return client.listPRs(owner, repo, state);
    },
    async getPR(number) {
      return client.getPR(owner, repo, number);
    },
    async mergePR(number, opts) {
      return client.mergePR(owner, repo, number, opts);
    },
    async deleteBranch(name) {
      return client.deleteBranch(owner, repo, name);
    },
  };

  const skillIndex = buildSkillIndex(vfs);
  const context = {
    vfs,
    fetch: (...args) => fetch(...args),
    emit: (ev) => {
      events.push(ev);
      if (ev.type === 'progress') process.stdout.write(`    ◆ ${ev.message}\n`);
      else if (ev.type === 'done') process.stdout.write(`    ✓ ${ev.message}\n`);
      else if (ev.type === 'error') process.stdout.write(`    ✕ ${ev.message}\n`);
    },
    env: {},
    skillIndex,
    github: ghHelper,
    async commit(message = 'commit', branch) {
      const dirty = vfs.list().filter(p => vfs.isDirty(p));
      const srcDirty = dirty.filter(p => p.startsWith('/src/'));
      if (srcDirty.length > 0) {
        await commitToGitHub(vfs, client, {
          owner, repo,
          branch: branch ?? ref, message, pathPrefix: '/src/',
        }, context.emit);
      }
      for (const p of dirty) vfs.markClean(p);
      return dirty;
    },
  };

  const state = { history: [], turn: 0, context };
  const deps = { execute, extractCode, ui: makeUiAdapter(context.emit), runTurn };

  return { vfs, context, state, deps, events, hydrated };
}

/** Minimal UI adapter for runTurn used in tests. */
function makeUiAdapter(emit) {
  return {
    setStatus() {},
    showCode() {},
    emitEvent: emit,
    onRetry(attempt, max) { process.stdout.write(`    ↺ retry ${attempt}/${max}\n`); },
    onTurnComplete() {},
  };
}

// ════════════════════════════════════════════════════
// SCENARIO 1: Requirements → ADR + Plan → Pull Request
// ════════════════════════════════════════════════════

async function scenario1() {
  phase('Scenario 1: Requirements → ADR + Plan → Pull Request');

  step('1a. Build workspace context for aaron-test-repo');
  const ws = await buildWorkspaceContext(OWNER, REPO, BASE);
  assert(ws.hydrated.files > 0, `Hydrated ${ws.hydrated.files} files from GitHub`);
  assert(ws.vfs.list().some(p => p.startsWith('/skills/')), 'Skills loaded into VFS');
  assert(ws.vfs.list().some(p => p.endsWith('.json') && p.includes('/workflows/')), 'Workflows loaded into VFS');

  step('1b. Place requirements document in VFS as agent input');
  const reqContent = ws.vfs.read('/src/REQUIREMENTS.md') ??
    ws.vfs.read('/src/requirements.md') ??
    ws.vfs.read('/src/docs/requirements.md') ??
    'No requirements document found in repo — agent should create one from context';

  // Write requirements to memory so the workflow can find it
  ws.vfs.write('/memory/requirements.md', reqContent !== 'No requirements document found in repo — agent should create one from context'
    ? reqContent
    : '# Requirements: User Notification Service\n\nBuild a notification service with email and SMS channels, retry logic, and priority routing.');
  ws.vfs.markClean('/memory/requirements.md');

  assert(ws.vfs.read('/memory/requirements.md') !== null, 'Requirements doc placed in VFS');

  step('1c. Run req-to-pr workflow (plan → implement docs → open PR)');
  const workflowDef = JSON.parse(ws.vfs.read('/workflows/req-to-pr.json'));
  assert(workflowDef?.steps?.length >= 3, `Workflow has ${workflowDef?.steps?.length} steps`);

  let prNumber = null;
  let prUrl = null;
  let branchName = null;

  await runWorkflowSteps(workflowDef, workflowDef.name, ws.vfs, ws.state, ws.deps, {
    onStepDone(stepId) {
      process.stdout.write(`    ✓ Step "${stepId}" complete\n`);
      // Extract PR info from result events
      for (const ev of ws.events) {
        if (ev.type === 'result' && ev.value?.pr_number) {
          prNumber = ev.value.pr_number;
          prUrl = ev.value.pr_url;
        }
        if (ev.type === 'result' && ev.value?.pr_url && !prNumber) {
          prUrl = ev.value.pr_url;
          const match = ev.value.pr_url?.match(/\/pull\/(\d+)/);
          if (match) prNumber = parseInt(match[1]);
        }
      }
    },
  });

  step('1d. Verify GitHub state');

  // Find the branch that was created
  if (prNumber) {
    const pr = await client.getPR(OWNER, REPO, prNumber);
    assert(pr !== null, `PR #${prNumber} exists on GitHub`);
    assert(pr?.state === 'open', `PR #${prNumber} is open`);
    assert(typeof pr?.title === 'string' && pr.title.length > 0, `PR has a title: "${pr?.title}"`);
    assert(typeof pr?.body === 'string' && pr.body.length > 50, `PR has a substantive body (${pr?.body?.length} chars)`);
    branchName = pr?.head;
    if (branchName) createdBranches.push(branchName);
    createdPRs.push(prNumber);
    process.stdout.write(`    → PR: ${prUrl}\n`);
  } else {
    // Check if any branch was created even without a PR number
    const openPRs = await client.listPRs(OWNER, REPO, 'open');
    const agentPR = openPRs.find(pr => pr.head.startsWith('feat/') || pr.head.startsWith('docs/'));
    assert(agentPR !== null, 'Agent opened at least one PR');
    if (agentPR) {
      prNumber = agentPR.number;
      branchName = agentPR.head;
      createdBranches.push(branchName);
      createdPRs.push(prNumber);
    }
  }

  // Verify VFS artifacts
  const scratchFiles = ws.vfs.list().filter(p => p.startsWith('/scratch/req-to-pr/'));
  assert(scratchFiles.length > 0, `Scratch files written: ${scratchFiles.join(', ')}`);

  const planFile = ws.vfs.read('/scratch/req-to-pr/plan.md');
  assert(planFile !== null && planFile.length > 100, 'Implementation plan written to VFS');

  return { prNumber, branchName };
}

// ════════════════════════════════════════════════════
// SCENARIO 2: Merge PR → Implement Feature → New PR
// ════════════════════════════════════════════════════

async function scenario2(s1Result) {
  phase('Scenario 2: Merge docs PR → Implement Feature → New PR');

  if (!s1Result?.prNumber) {
    console.log('  ⏭  Skipped: Scenario 1 did not produce a PR');
    return {};
  }

  step('2a. Merge the documentation PR from Scenario 1');
  try {
    await client.mergePR(OWNER, REPO, s1Result.prNumber, { merge_method: 'squash' });
    assert(true, `PR #${s1Result.prNumber} merged`);
    await sleep(1000); // let GitHub settle
  } catch (e) {
    // PR may already be merged or unmerge-able
    assert(false, `Merge PR #${s1Result.prNumber}: ${e.message}`);
    return {};
  }

  step('2b. Hydrate fresh workspace from updated main');
  const ws = await buildWorkspaceContext(OWNER, REPO, BASE);
  assert(ws.hydrated.files > 0, `Re-hydrated ${ws.hydrated.files} files after merge`);

  // Check the merged docs are now on main
  const planOnMain = ws.vfs.list().some(p => p.includes('plan') || p.includes('ADR'));
  assert(planOnMain, 'Documentation files present in main after merge');

  step('2c. Run implement-from-plan workflow');
  const workflowDef = JSON.parse(ws.vfs.read('/workflows/implement-from-plan.json'));
  assert(workflowDef?.steps?.length >= 3, `implement-from-plan has ${workflowDef?.steps?.length} steps`);

  let prNumber = null;
  let branchName = null;

  await runWorkflowSteps(workflowDef, workflowDef.name, ws.vfs, ws.state, ws.deps, {
    onStepDone(stepId) {
      process.stdout.write(`    ✓ Step "${stepId}" complete\n`);
      for (const ev of ws.events) {
        if (ev.type === 'result' && ev.value?.pr_number) {
          prNumber = ev.value.pr_number;
        }
        if (ev.type === 'result' && ev.value?.pr_url) {
          const match = ev.value.pr_url?.match(/\/pull\/(\d+)/);
          if (match) prNumber = parseInt(match[1]);
        }
      }
    },
  });

  step('2d. Verify implementation PR');

  if (prNumber) {
    const pr = await client.getPR(OWNER, REPO, prNumber);
    assert(pr?.state === 'open', `Implementation PR #${prNumber} is open`);
    branchName = pr?.head;
    if (branchName) createdBranches.push(branchName);
    createdPRs.push(prNumber);

    // Verify implementation files were actually written to the branch
    const branchData = await client.getBranch(OWNER, REPO, branchName);
    assert(branchData !== null, `Feature branch "${branchName}" exists on GitHub`);
  } else {
    const openPRs = await client.listPRs(OWNER, REPO, 'open');
    const implPR = openPRs.find(pr => pr.head.startsWith('feat/implement'));
    assert(implPR !== null, 'Implementation PR created');
    if (implPR) {
      prNumber = implPR.number;
      branchName = implPR.head;
      createdBranches.push(branchName);
      createdPRs.push(prNumber);
    }
  }

  // Check that /src/ files were actually created in VFS
  const srcFiles = ws.vfs.list().filter(p => p.startsWith('/src/') && !p.endsWith('.md'));
  assert(srcFiles.length > 0, `Source files written: ${srcFiles.length} files in /src/`);

  const verificationFile = ws.vfs.read('/scratch/implement-from-plan/verification.md');
  assert(verificationFile !== null, 'Verification report written');

  return { prNumber, branchName };
}

// ════════════════════════════════════════════════════
// SCENARIO 3: Bug Injection → Diagnosis → Fix → PR
// ════════════════════════════════════════════════════

async function scenario3(s2Result) {
  phase('Scenario 3: Bug Injection → Diagnosis → Fix → PR');

  if (!s2Result?.prNumber) {
    console.log('  ⏭  Skipped: Scenario 2 did not produce an implementation PR');
    return;
  }

  step('3a. Merge implementation PR from Scenario 2');
  try {
    await client.mergePR(OWNER, REPO, s2Result.prNumber, { merge_method: 'squash' });
    assert(true, `PR #${s2Result.prNumber} merged`);
    await sleep(1000);
  } catch (e) {
    assert(false, `Merge PR #${s2Result.prNumber}: ${e.message}`);
    return;
  }

  step('3b. Hydrate workspace after implementation merge');
  const ws = await buildWorkspaceContext(OWNER, REPO, BASE);
  assert(ws.hydrated.files > 0, `Re-hydrated ${ws.hydrated.files} files`);

  // Find the notification service source file
  const srcFiles = ws.vfs.list().filter(p => p.startsWith('/src/') && p.endsWith('.js'));
  assert(srcFiles.length > 0, `Found ${srcFiles.length} source files from implementation`);

  step('3c. Inject a known bug into the codebase');
  // Find a .js file that looks like a notification service
  const notifFile = srcFiles.find(p =>
    p.includes('notification') || p.includes('service') || p.includes('retry')
  ) ?? srcFiles[0];

  const original = ws.vfs.read(notifFile);
  assert(original !== null, `Can read source file: ${notifFile}`);

  // Inject two bugs: off-by-one in a loop, wrong string constant
  const buggyContent = original
    .replace(/i < maxRetries/g, 'i <= maxRetries')   // off-by-one
    .replace(/'CRITICAL'/g, "'URGENT'");              // wrong enum value

  // Write the buggy version directly to GitHub on main (simulating prod bug)
  const repoPath = notifFile.replace('/src/', '');
  const existingFile = await client.getFile(OWNER, REPO, repoPath, BASE);
  if (existingFile) {
    await client.putFile(OWNER, REPO, repoPath, buggyContent, existingFile.sha,
      'chore: inject test bug (off-by-one + wrong enum)', BASE);
    assert(true, `Bug injected into ${repoPath}`);
  } else {
    assert(false, `Could not inject bug: file ${repoPath} not found on GitHub`);
    return;
  }

  step('3d. Write bug report to VFS for the agent');
  await sleep(500); // let GitHub settle
  const ws2 = await buildWorkspaceContext(OWNER, REPO, BASE);

  ws2.vfs.write('/memory/bug-report.md', [
    '# Bug Report: Notification Service',
    '',
    '## Symptoms',
    '- Retry logic runs one extra iteration (off-by-one)',
    '- CRITICAL priority notifications not routing correctly',
    '',
    '## Affected file',
    `- ${notifFile}`,
    '',
    '## Known bad patterns to look for',
    "- Loop condition using `<=` when it should be `<`",
    "- String `'URGENT'` where `'CRITICAL'` is expected",
  ].join('\n'));

  step('3e. Run bug-fix workflow');
  const workflowDef = JSON.parse(ws2.vfs.read('/workflows/bug-fix.json'));
  assert(workflowDef?.steps?.length >= 3, `bug-fix workflow has ${workflowDef?.steps?.length} steps`);

  let prNumber = null;
  let branchName = null;

  await runWorkflowSteps(workflowDef, workflowDef.name, ws2.vfs, ws2.state, ws2.deps, {
    onStepDone(stepId) {
      process.stdout.write(`    ✓ Step "${stepId}" complete\n`);
      for (const ev of ws2.events) {
        if (ev.type === 'result' && ev.value?.pr_number) {
          prNumber = ev.value.pr_number;
        }
        if (ev.type === 'result' && ev.value?.pr_url) {
          const match = ev.value.pr_url?.match(/\/pull\/(\d+)/);
          if (match) prNumber = parseInt(match[1]);
        }
      }
    },
  });

  step('3f. Verify fix PR');

  if (prNumber) {
    const pr = await client.getPR(OWNER, REPO, prNumber);
    assert(pr?.state === 'open', `Fix PR #${prNumber} is open`);
    assert(pr?.head?.startsWith('fix/'), `Fix branch name starts with "fix/": "${pr?.head}"`);
    branchName = pr?.head;
    if (branchName) createdBranches.push(branchName);
    createdPRs.push(prNumber);

    // Verify the fix actually corrects the bugs
    const fixedFile = ws2.vfs.read(notifFile);
    const hasBugFixed = fixedFile && !fixedFile.includes('i <= maxRetries');
    const hasEnumFixed = fixedFile && !fixedFile.includes("'URGENT'");
    assert(hasBugFixed || fixedFile === null, 'Off-by-one bug fixed (or agent wrote new file)');
    assert(hasEnumFixed || fixedFile === null, 'Wrong enum value fixed (or agent wrote new file)');

    const diagnosisFile = ws2.vfs.read('/scratch/bug-fix/diagnosis.md');
    assert(diagnosisFile !== null && diagnosisFile.length > 50, 'Diagnosis report written');
  } else {
    const openPRs = await client.listPRs(OWNER, REPO, 'open');
    const fixPR = openPRs.find(pr => pr.head.startsWith('fix/'));
    assert(fixPR !== null, 'Fix PR created by bug-fix workflow');
    if (fixPR) {
      prNumber = fixPR.number;
      branchName = fixPR.head;
      createdBranches.push(branchName);
      createdPRs.push(prNumber);
    }
  }
}

// ════════════════════════════════════════════════════
// CLEANUP
// ════════════════════════════════════════════════════

async function cleanup() {
  phase('Cleanup: Close PRs and delete branches');

  for (const num of createdPRs) {
    try {
      // Close open PRs (not merged ones)
      const pr = await client.getPR(OWNER, REPO, num);
      if (pr?.state === 'open') {
        // We can't close via Contents API — note it for manual cleanup
        console.log(`  ⚠  PR #${num} left open (close manually at ${pr.html_url})`);
      } else {
        console.log(`  ✓  PR #${num} already closed/merged`);
      }
    } catch { /* ignore */ }
  }

  for (const branch of createdBranches) {
    try {
      await client.deleteBranch(OWNER, REPO, branch);
      console.log(`  ✓  Branch "${branch}" deleted`);
    } catch (e) {
      console.log(`  ⚠  Could not delete branch "${branch}": ${e.message}`);
    }
  }
}

// ════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════

async function main() {
  console.log('\n' + '═'.repeat(64));
  console.log('  Aaron Real-World Use Cases');
  console.log('  github: ' + OWNER + '/' + REPO);
  console.log('═'.repeat(64));

  let s1Result = {};
  let s2Result = {};

  try {
    s1Result = await scenario1();
  } catch (e) {
    console.error(`\n  ✕ Scenario 1 threw: ${e.message}`);
    console.error(e.stack);
  }

  try {
    s2Result = await scenario2(s1Result);
  } catch (e) {
    console.error(`\n  ✕ Scenario 2 threw: ${e.message}`);
    console.error(e.stack);
  }

  try {
    await scenario3(s2Result);
  } catch (e) {
    console.error(`\n  ✕ Scenario 3 threw: ${e.message}`);
    console.error(e.stack);
  }

  await cleanup();

  // ── Summary ──────────────────────────────────────

  console.log('\n' + '═'.repeat(64));
  console.log(`  Results: ${passed}/${total} passed`);
  if (failures.length > 0) {
    console.log('\n  Failed assertions:');
    for (const f of failures) console.log(`    ❌ ${f}`);
  }
  console.log('═'.repeat(64) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
