#!/usr/bin/env node
/**
 * usecase-multi-repo.mjs — Complex multi-repo workspace use case
 *
 * SCENARIO: "Cross-Repo Feature Development with Context Isolation"
 * ─────────────────────────────────────────────────────────────────
 *
 * Simulates a developer (Aaron) working across two repos simultaneously:
 *   1. Aaron's own repo (self) — where core skills and harness live
 *   2. weolopez/aaron-test-repo — an external project with its own .aaron/ config
 *
 * USE CASE FLOW:
 * ──────────────
 *   Phase A: Bootstrap Aaron's own workspace ("self")
 *     - Create VFS, load core skills/harness
 *     - Write some scratch notes and memory entries
 *     - Verify agent layer is populated
 *
 *   Phase B: Switch to external repo (weolopez/aaron-test-repo@main)
 *     - Snapshot self workspace
 *     - Hydrate external repo from GitHub (with .aaron/ discovery)
 *     - Verify: project skills mounted at /project-skills/
 *     - Verify: project workflows mounted at /project-workflows/
 *     - Verify: project memory merged into /memory/
 *     - Build merged skill index (project overrides core on collision)
 *
 *   Phase C: Work on external repo
 *     - Read and analyze source files from /src/
 *     - Create a new feature file in /src/
 *     - Write analysis results to /scratch/
 *     - Write project-specific memory
 *     - Snapshot external workspace for persistence
 *
 *   Phase D: Switch back to self workspace
 *     - Restore self workspace from snapshot
 *     - Verify: core skills are untouched
 *     - Verify: self scratch/memory are restored (not polluted by external work)
 *     - Verify: agent layer (/harness/, /skills/) persisted across switch
 *
 *   Phase E: Switch back to external repo (restore from snapshot)
 *     - Restore external workspace
 *     - Verify: the new feature file we created is still there
 *     - Verify: external scratch/memory are restored
 *     - Verify: project skills still override core skills
 *
 *   Phase F: Session persistence round-trip
 *     - Save workspace-scoped session to disk
 *     - Clear VFS completely
 *     - Load session from disk
 *     - Verify full state reconstruction
 *
 * EXPECTED OUTPUT:
 * ────────────────
 *   - 30+ assertions covering state isolation, .aaron/ discovery,
 *     skill merging, snapshot/restore fidelity, and session persistence
 *   - Zero failures if the workspace architecture is correctly implemented
 *   - Console output shows each phase with pass/fail per assertion
 *
 * REQUIRES:
 *   GITHUB_TOKEN env var for live GitHub API access
 */

import { createVFS } from '../src/agent-core.js';
import { buildSkillIndex, parseSkillFrontmatter } from '../src/agent-loop.js';
import { createGitHubClient, initFromGitHub, commitToGitHub } from '../src/github.js';
import {
  createWorkspace, snapshotWorkspace, restoreWorkspace,
  getWorkspaceId, getSelfWorkspaceId,
  isWorkspacePath, isAgentPath,
  WORKSPACE_PREFIXES, AGENT_PREFIXES,
  getWorkspaceSummary, isEmptyWorkspace,
} from '../src/workspace.js';
import { saveSession, loadSession, clearSession } from '../src/session.js';

// ════════════════════════════════════════════════════
// TEST HARNESS
// ════════════════════════════════════════════════════

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error('\n⚠  GITHUB_TOKEN not set — cannot run use case.\n');
  process.exit(1);
}

let passed = 0, failed = 0, total = 0;
const failures = [];

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
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  PHASE ${name}`);
  console.log(`${'═'.repeat(60)}`);
}

// ════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════

const TEST_OWNER = 'weolopez';
const TEST_REPO  = 'aaron-test-repo';
const TEST_REF   = 'main';

const client = createGitHubClient({ token: GITHUB_TOKEN });

// ════════════════════════════════════════════════════
// PHASE A: Bootstrap self workspace
// ════════════════════════════════════════════════════

phase('A — Bootstrap Self Workspace');

const vfs = createVFS();

// Simulate core skills (what hydrateHarness does)
vfs.write('/skills/testing/SKILL.md', [
  '---',
  'name: testing',
  'description: Write and run tests for code changes',
  '---',
  '# Testing Skill',
  'Write unit tests before implementation.',
].join('\n'));
vfs.markClean('/skills/testing/SKILL.md');

vfs.write('/skills/refactoring/SKILL.md', [
  '---',
  'name: refactoring',
  'description: Improve code structure without changing behavior',
  '---',
  '# Refactoring Skill',
  'Extract methods, rename variables, simplify logic.',
].join('\n'));
vfs.markClean('/skills/refactoring/SKILL.md');

// Simulate harness
vfs.write('/harness/agent-loop.js', '// agent loop code');
vfs.markClean('/harness/agent-loop.js');

// Self workspace scratch and memory
vfs.write('/scratch/self-notes.md', '# Self Notes\nWorking on RSI improvements.');
vfs.write('/memory/self-facts.md', '# Facts\nAaron v0.4 uses two-layer VFS.');

const selfSkillIndex = buildSkillIndex(vfs);

assert(selfSkillIndex.includes('testing'), 'Core skill "testing" in index');
assert(selfSkillIndex.includes('refactoring'), 'Core skill "refactoring" in index');
assert(!selfSkillIndex.includes('[project]'), 'No project skills in self workspace');
assert(vfs.read('/scratch/self-notes.md') !== null, 'Self scratch notes exist');
assert(vfs.read('/memory/self-facts.md') !== null, 'Self memory facts exist');
assert(isAgentPath('/harness/agent-loop.js'), '/harness/ classified as agent path');
assert(isWorkspacePath('/src/index.js'), '/src/ classified as workspace path');
assert(!isWorkspacePath('/harness/agent-loop.js'), '/harness/ NOT workspace path');

const selfState = {
  history: [
    { role: 'user', content: 'Improve the testing skill' },
    { role: 'assistant', content: 'I will read and improve the testing skill.' },
  ],
  turn: 1,
};

console.log(`  Agent layer: ${vfs.list().filter(p => isAgentPath(p)).length} files`);
console.log(`  Workspace layer: ${vfs.list().filter(p => isWorkspacePath(p)).length} files`);

// ════════════════════════════════════════════════════
// PHASE B: Switch to external repo
// ════════════════════════════════════════════════════

phase('B — Switch to External Repo (weolopez/aaron-test-repo)');

// Step 1: Snapshot self workspace
const selfBundle = snapshotWorkspace(vfs, selfState);
assert(selfBundle.timestamp !== undefined, 'Self snapshot has timestamp');
assert(selfBundle.history?.length === 2, 'Self snapshot captured 2 history messages');
assert(selfBundle.turn === 1, 'Self snapshot captured turn count');

// Verify self bundle contains workspace files but not agent files
const selfBundleKeys = Object.keys(selfBundle.scratch || {});
assert(selfBundleKeys.length > 0 || Object.keys(selfBundle.memory || {}).length > 0,
  'Self bundle contains workspace layer files');

// Step 2: Clear workspace layer and hydrate from GitHub
restoreWorkspace(vfs, createWorkspace('empty'));

// Verify agent layer survived
assert(vfs.read('/harness/agent-loop.js') !== null, 'Agent layer /harness/ survived workspace clear');
assert(vfs.read('/skills/testing/SKILL.md') !== null, 'Agent layer /skills/ survived workspace clear');

// Verify workspace layer is cleared
assert(vfs.read('/scratch/self-notes.md') === null, 'Self scratch cleared after workspace switch');
assert(vfs.read('/memory/self-facts.md') === null, 'Self memory cleared after workspace switch');

// Step 3: Hydrate from GitHub
console.log('\n  Hydrating from GitHub...');
const hydrationResult = await initFromGitHub(
  { owner: TEST_OWNER, repo: TEST_REPO, ref: TEST_REF },
  vfs, client,
  (ev) => console.log(`    ${ev.type}: ${ev.message}`)
);

assert(hydrationResult.files > 0, `Hydrated ${hydrationResult.files} files from GitHub`);
assert(hydrationResult.aaronFiles > 0, `.aaron/ files discovered (${hydrationResult.aaronFiles} total)`);

// Step 4: Verify .aaron/ discovery
const srcFiles = vfs.list().filter(p => p.startsWith('/src/'));
const projSkills = vfs.list().filter(p => p.startsWith('/project-skills/'));
const projWorkflows = vfs.list().filter(p => p.startsWith('/project-workflows/'));
const projMemory = vfs.list().filter(p => p.startsWith('/memory/'));

console.log(`\n  /src/ files: ${srcFiles.length}`);
console.log(`  /project-skills/ files: ${projSkills.length}`);
console.log(`  /project-workflows/ files: ${projWorkflows.length}`);
console.log(`  /memory/ files: ${projMemory.length}`);

assert(srcFiles.length >= 2, 'Source files hydrated to /src/');
assert(projSkills.some(p => p.includes('test-skill')), 'Project skill "test-skill" mounted');
assert(projWorkflows.some(p => p.includes('test-workflow')), 'Project workflow mounted');
assert(projMemory.some(p => p.includes('project-memory')), 'Project memory merged');

// Verify project skill content
const projSkillContent = vfs.read('/project-skills/test-skill/SKILL.md');
assert(projSkillContent?.includes('name: test-skill'), 'Project skill has valid frontmatter');

const projSkillMeta = parseSkillFrontmatter(projSkillContent);
assert(projSkillMeta?.name === 'test-skill', 'Project skill frontmatter parsed correctly');

// Step 5: Build merged skill index
const mergedIndex = buildSkillIndex(vfs);
console.log(`\n  Merged skill index:\n${mergedIndex}`);

assert(mergedIndex.includes('testing'), 'Core skill "testing" in merged index');
assert(mergedIndex.includes('refactoring'), 'Core skill "refactoring" in merged index');
assert(mergedIndex.includes('test-skill'), 'Project skill "test-skill" in merged index');
assert(mergedIndex.includes('[project]'), 'Project skills tagged with [project]');

// ════════════════════════════════════════════════════
// PHASE C: Work on external repo
// ════════════════════════════════════════════════════

phase('C — Work on External Repo');

// Read and analyze source
const readmeContent = vfs.read('/src/README.md');
assert(readmeContent?.includes('aaron-test-repo'), 'README.md read from /src/');

const indexContent = vfs.read('/src/src/index.js');
assert(indexContent !== null, 'src/index.js read from /src/src/index.js');

// Create a new feature file (simulating agent work)
vfs.write('/src/lib/utils.js', [
  '/**',
  ' * Utility functions generated by Aaron workspace use case.',
  ' * This file was created during a multi-repo context switch test.',
  ' */',
  '',
  'export function greet(name) {',
  '  return `Hello, ${name}! This was generated by Aaron.`;',
  '}',
  '',
  'export function sum(a, b) {',
  '  return a + b;',
  '}',
].join('\n'));

// Write analysis to scratch
vfs.write('/scratch/analysis.md', [
  '# Code Analysis: aaron-test-repo',
  '',
  `- Files: ${srcFiles.length}`,
  `- Project skills: ${projSkills.length}`,
  `- Has .aaron/ config: yes`,
  '',
  '## Findings',
  '- Simple Node.js project',
  '- Has project-specific test-skill',
  '- Has project-specific test-workflow',
].join('\n'));

// Write project-specific memory
vfs.write('/memory/external-analysis.md', [
  '# External Repo Analysis',
  '',
  '## weolopez/aaron-test-repo',
  `- Analyzed on: ${new Date().toISOString()}`,
  '- Created utils.js with greet() and sum() functions',
  '- Project uses .aaron/ convention for skill/workflow customization',
].join('\n'));

const externalState = {
  history: [
    { role: 'user', content: 'Analyze this repo and add utility functions' },
    { role: 'assistant', content: 'I analyzed the repo and created lib/utils.js.' },
  ],
  turn: 1,
};

assert(vfs.read('/src/lib/utils.js') !== null, 'New feature file created');
assert(vfs.isDirty('/src/lib/utils.js'), 'New file is marked dirty');
assert(vfs.read('/scratch/analysis.md') !== null, 'Analysis scratch written');
assert(vfs.read('/memory/external-analysis.md') !== null, 'External analysis memory written');

// Get workspace summary
const summary = getWorkspaceSummary(vfs);
console.log('\n  Workspace summary:');
for (const [key, val] of Object.entries(summary)) {
  if (val.fileCount > 0) {
    console.log(`    ${key}: ${val.fileCount} files (${val.dirtyCount} dirty)`);
  }
}

// Snapshot external workspace
const externalBundle = snapshotWorkspace(vfs, externalState);
assert(!isEmptyWorkspace(externalBundle), 'External workspace bundle is not empty');

// ════════════════════════════════════════════════════
// PHASE D: Switch back to self workspace
// ════════════════════════════════════════════════════

phase('D — Switch Back to Self Workspace');

// Restore self workspace
const restoredSelfState = restoreWorkspace(vfs, selfBundle);

assert(restoredSelfState !== null, 'Self state restored from bundle');
assert(restoredSelfState.history?.length === 2, 'Self conversation history restored');
assert(restoredSelfState.turn === 1, 'Self turn count restored');

// Verify agent layer is intact
assert(vfs.read('/harness/agent-loop.js') !== null, 'Agent /harness/ intact after round-trip');
assert(vfs.read('/skills/testing/SKILL.md') !== null, 'Core skill "testing" intact');
assert(vfs.read('/skills/refactoring/SKILL.md') !== null, 'Core skill "refactoring" intact');

// Verify self workspace layer restored
assert(vfs.read('/scratch/self-notes.md')?.includes('RSI improvements'),
  'Self scratch notes restored with correct content');
assert(vfs.read('/memory/self-facts.md')?.includes('two-layer VFS'),
  'Self memory facts restored with correct content');

// Verify external repo files are GONE (not polluting self workspace)
assert(vfs.read('/src/lib/utils.js') === null, 'External feature file NOT in self workspace');
assert(vfs.read('/src/README.md') === null, 'External README NOT in self workspace');
assert(vfs.read('/scratch/analysis.md') === null, 'External scratch NOT in self workspace');
assert(vfs.read('/memory/external-analysis.md') === null, 'External memory NOT in self workspace');
assert(vfs.read('/project-skills/test-skill/SKILL.md') === null,
  'Project skills NOT in self workspace');

// Verify skill index is back to core-only
const selfIndexAfter = buildSkillIndex(vfs);
assert(selfIndexAfter.includes('testing'), 'Core "testing" back in self index');
assert(!selfIndexAfter.includes('test-skill'), 'Project "test-skill" NOT in self index');
assert(!selfIndexAfter.includes('[project]'), 'No [project] tags in self index');

// ════════════════════════════════════════════════════
// PHASE E: Switch back to external repo
// ════════════════════════════════════════════════════

phase('E — Switch Back to External Repo (restore from snapshot)');

// Snapshot self again before switching
const selfBundle2 = snapshotWorkspace(vfs, {
  history: restoredSelfState.history,
  turn: restoredSelfState.turn,
});

// Restore external workspace
const restoredExtState = restoreWorkspace(vfs, externalBundle);

assert(restoredExtState !== null, 'External state restored');
assert(restoredExtState.history?.length === 2, 'External conversation history restored');

// Verify the feature file we created is still there
assert(vfs.read('/src/lib/utils.js')?.includes('greet'),
  'Feature file /src/lib/utils.js persisted through snapshot');
assert(vfs.read('/scratch/analysis.md')?.includes('Code Analysis'),
  'Analysis scratch persisted through snapshot');
assert(vfs.read('/memory/external-analysis.md')?.includes('weolopez'),
  'External memory persisted through snapshot');

// Verify project skills restored
assert(vfs.read('/project-skills/test-skill/SKILL.md') !== null,
  'Project skills restored from snapshot');

// Verify merged skill index works again
const mergedIndex2 = buildSkillIndex(vfs);
assert(mergedIndex2.includes('test-skill'), 'Project skill back in merged index');
assert(mergedIndex2.includes('[project]'), 'Project tag restored in merged index');
assert(mergedIndex2.includes('testing'), 'Core skills still present in merged index');

// Agent layer still intact
assert(vfs.read('/harness/agent-loop.js') !== null,
  'Agent /harness/ survived double round-trip');

// ════════════════════════════════════════════════════
// PHASE F: Session persistence round-trip
// ════════════════════════════════════════════════════

phase('F — Session Persistence Round-Trip');

const wsId = getWorkspaceId(TEST_OWNER, TEST_REPO, TEST_REF);
assert(wsId === 'weolopez/aaron-test-repo@main', 'Workspace ID generated correctly');

// Save session to disk
const sessionState = {
  history: restoredExtState.history,
  turn: restoredExtState.turn,
  context: { vfs, workspaceId: wsId },
};

await saveSession(wsId, sessionState, vfs);
console.log('  Session saved to disk');

// Simulate total VFS destruction (app restart)
const freshVfs = createVFS();
assert(freshVfs.list().length === 0, 'Fresh VFS is empty (simulating restart)');

// Load session from disk
const loaded = await loadSession(wsId);
assert(loaded !== null, 'Session loaded from disk');
assert(loaded.state?.history?.length === 2, 'Session history restored from disk');
assert(loaded.state?.turn === 1, 'Session turn count restored from disk');

// Verify VFS contents can be reconstructed
if (loaded?.vfs) {
  let reconstructedCount = 0;
  for (const [path, content] of Object.entries(loaded.vfs)) {
    freshVfs.write(path, content);
    reconstructedCount++;
  }
  console.log(`  Reconstructed ${reconstructedCount} files from saved session`);
  assert(reconstructedCount > 0, 'Session VFS data non-empty');

  // Check key files survived the round-trip
  const hasUtils = freshVfs.read('/src/lib/utils.js');
  if (hasUtils) {
    assert(hasUtils.includes('greet'), 'Feature file content survived session persistence');
  }
}

// Clean up test session
await clearSession(wsId);
console.log('  Test session cleaned up');

// ════════════════════════════════════════════════════
// RESULTS
// ════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(60)}`);
console.log(`  RESULTS: ${total} tests — ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}`);

if (failures.length > 0) {
  console.log('\n  FAILURES:');
  for (const f of failures) {
    console.log(`    ❌ ${f}`);
  }
}

console.log();
process.exit(failed > 0 ? 1 : 0);
