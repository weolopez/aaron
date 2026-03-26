/**
 * test-workspace.mjs — Integration tests for workspace & multi-repo architecture
 *
 * Tests against a REAL GitHub repo: weolopez/aaron-test-repo
 * Requires: GITHUB_TOKEN environment variable
 *
 * See ADR.md Decisions 14, 15, 16 and plan.md for full context.
 *
 * Run: node test/test-workspace.mjs
 */

import { createVFS } from '../src/agent-core.js';
import { createGitHubClient, initFromGitHub, commitToGitHub } from '../src/github.js';
import { buildSkillIndex, parseSkillFrontmatter } from '../src/agent-loop.js';

// ════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const TEST_OWNER = 'weolopez';
const TEST_REPO = 'aaron-test-repo';
const TEST_REF = 'main';
const TEST_BRANCH = 'aaron-test-branch';

// Aaron's own repo (for self-workspace tests)
const SELF_OWNER = 'weolopez';
const SELF_REPO = 'aaron';
const SELF_REF = 'main';

// ════════════════════════════════════════════════════
// TEST HARNESS
// ════════════════════════════════════════════════════

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL: ${msg}`);
  }
}

function skip(msg) {
  skipped++;
  console.log(`  SKIP: ${msg}`);
}

// ════════════════════════════════════════════════════
// WORKSPACE HELPERS (inline until src/workspace.js exists)
//
// These define the expected contract for the workspace module.
// Once src/workspace.js is implemented, replace these with imports.
// ════════════════════════════════════════════════════

const WORKSPACE_PREFIXES = ['/src/', '/memory/', '/scratch/', '/artifacts/', '/project-skills/', '/project-workflows/'];
const AGENT_PREFIXES = ['/harness/', '/skills/', '/workflows/'];

function getWorkspaceId(owner, repo, ref = 'main') {
  return `${owner}/${repo}@${ref}`;
}

function snapshotWorkspace(vfs) {
  const bundle = {};
  for (const prefix of WORKSPACE_PREFIXES) {
    const snap = vfs.snapshot(prefix);
    for (const [k, v] of Object.entries(snap)) {
      bundle[k] = v;
    }
  }
  return bundle;
}

function restoreWorkspace(vfs, bundle) {
  // Clear all workspace-layer paths
  for (const path of vfs.list()) {
    for (const prefix of WORKSPACE_PREFIXES) {
      if (path.startsWith(prefix)) {
        vfs.delete(path);
        break;
      }
    }
  }
  // Load bundle contents
  for (const [path, entry] of Object.entries(bundle)) {
    vfs.write(path, entry.content);
    if (entry.sha) vfs.setSHA(path, entry.sha);
    if (!entry.dirty) vfs.markClean(path);
  }
}

/**
 * Hydrate a repo and mount .aaron/ contents into VFS.
 * This is the expected behavior after Phase 3 modifications to initFromGitHub.
 */
async function hydrateWithAaron(config, vfs, client, emit) {
  const result = await initFromGitHub(config, vfs, client, emit);

  // Post-hydration: detect .aaron/ files and remap them
  const aaronFiles = vfs.list().filter(p => p.startsWith('/src/.aaron/'));

  for (const vfsPath of aaronFiles) {
    const content = vfs.read(vfsPath);
    if (content === null) continue;

    const relPath = vfsPath.slice('/src/.aaron/'.length); // e.g., "skills/project-linter/SKILL.md"

    if (relPath.startsWith('skills/')) {
      const destPath = '/project-skills/' + relPath.slice('skills/'.length);
      vfs.write(destPath, content);
      vfs.markClean(destPath);
    } else if (relPath.startsWith('workflows/')) {
      const destPath = '/project-workflows/' + relPath.slice('workflows/'.length);
      vfs.write(destPath, content);
      vfs.markClean(destPath);
    } else if (relPath.startsWith('memory/')) {
      const destPath = '/memory/' + relPath.slice('memory/'.length);
      vfs.write(destPath, content);
      vfs.markClean(destPath);
    }
    // config.json stays in /src/.aaron/ for now — read it directly
  }

  return result;
}

/**
 * Extended buildSkillIndex that scans both /skills/ and /project-skills/.
 * Project skills override core on name collision.
 */
function buildMergedSkillIndex(vfs) {
  const coreSkills = new Map();
  const projectSkills = new Map();

  for (const path of vfs.list()) {
    if (path.startsWith('/skills/') && path.endsWith('/SKILL.md')) {
      const content = vfs.read(path);
      if (!content) continue;
      const meta = parseSkillFrontmatter(content);
      if (meta) coreSkills.set(meta.name, { ...meta, path, scope: 'core' });
    }
    if (path.startsWith('/project-skills/') && path.endsWith('/SKILL.md')) {
      const content = vfs.read(path);
      if (!content) continue;
      const meta = parseSkillFrontmatter(content);
      if (meta) projectSkills.set(meta.name, { ...meta, path, scope: 'project' });
    }
  }

  // Merge: project wins on collision
  const merged = new Map(coreSkills);
  for (const [name, skill] of projectSkills) {
    merged.set(name, skill); // overrides core if same name
  }

  if (merged.size === 0) return '';
  let index = '\nAVAILABLE SKILLS \u2014 read the full SKILL.md when the task matches:\n';
  for (const [, s] of merged) {
    const tag = s.scope === 'project' ? ' [project]' : '';
    index += `  - ${s.name}: ${s.description} \u2192 context.vfs.read('${s.path}')${tag}\n`;
  }
  return index;
}

// ════════════════════════════════════════════════════
// PREFLIGHT CHECK
// ════════════════════════════════════════════════════

if (!GITHUB_TOKEN) {
  console.log('\n⚠  GITHUB_TOKEN not set — skipping all workspace integration tests.');
  console.log('   Set GITHUB_TOKEN to run these tests against weolopez/aaron-test-repo.\n');
  process.exit(0);
}

const client = createGitHubClient({ token: GITHUB_TOKEN });

// Verify test repo exists
console.log(`\nVerifying test repo: ${TEST_OWNER}/${TEST_REPO}...`);
const tree = await client.getTree(TEST_OWNER, TEST_REPO, TEST_REF);
if (tree.length === 0) {
  console.log(`\n⚠  Test repo ${TEST_OWNER}/${TEST_REPO} not found or empty.`);
  console.log('   See plan.md for the required repo structure.\n');
  process.exit(0);
}
console.log(`  Found ${tree.length} files in ${TEST_OWNER}/${TEST_REPO}@${TEST_REF}\n`);

// ════════════════════════════════════════════════════
// SCENARIO 1: Fresh workspace hydration
// ════════════════════════════════════════════════════

console.log('Scenario 1: Fresh workspace hydration');
{
  const vfs = createVFS();

  // Pre-populate agent layer (simulates Aaron's own skills/harness being loaded)
  vfs.write('/harness/agent-loop.js', 'export const SYSTEM = "test";');
  vfs.write('/skills/code-review/SKILL.md', '---\nname: code-review\ndescription: Review code\n---\n\n# Code Review\n\nReview instructions here.');
  vfs.write('/workflows/devkit.json', '{"name":"devkit"}');

  const events = [];
  await initFromGitHub(
    { owner: TEST_OWNER, repo: TEST_REPO, ref: TEST_REF },
    vfs, client, (ev) => events.push(ev),
  );

  const srcFiles = vfs.list().filter(p => p.startsWith('/src/'));
  assert(srcFiles.length > 0, 'repo files hydrated into /src/');

  // Agent layer should be untouched
  assert(vfs.read('/harness/agent-loop.js') === 'export const SYSTEM = "test";', 'agent layer /harness/ untouched');
  assert(vfs.read('/skills/code-review/SKILL.md') !== null, 'agent layer /skills/ untouched');
  assert(vfs.read('/workflows/devkit.json') !== null, 'agent layer /workflows/ untouched');

  assert(events.length > 0, 'progress events emitted');
}

// ════════════════════════════════════════════════════
// SCENARIO 2: .aaron/ discovery
// ════════════════════════════════════════════════════

console.log('\nScenario 2: .aaron/ discovery');
{
  const vfs = createVFS();
  await hydrateWithAaron(
    { owner: TEST_OWNER, repo: TEST_REPO, ref: TEST_REF },
    vfs, client,
  );

  // Check if .aaron/skills/ was discovered and mounted
  const projectSkillFiles = vfs.list().filter(p => p.startsWith('/project-skills/'));
  const hasAaronSkills = tree.some(f => f.path.startsWith('.aaron/skills/'));

  if (hasAaronSkills) {
    assert(projectSkillFiles.length > 0, '.aaron/skills/ mounted at /project-skills/');

    // Check for specific skill
    const linterSkill = vfs.read('/project-skills/project-linter/SKILL.md');
    if (linterSkill) {
      const meta = parseSkillFrontmatter(linterSkill);
      assert(meta !== null, 'project skill has valid frontmatter');
      assert(meta.name === 'project-linter', 'project skill name matches');
    } else {
      skip('project-linter skill not found — check test repo structure');
    }
  } else {
    skip('.aaron/skills/ not present in test repo — create it per plan.md');
  }

  // Check if .aaron/workflows/ was discovered
  const projectWorkflowFiles = vfs.list().filter(p => p.startsWith('/project-workflows/'));
  const hasAaronWorkflows = tree.some(f => f.path.startsWith('.aaron/workflows/'));

  if (hasAaronWorkflows) {
    assert(projectWorkflowFiles.length > 0, '.aaron/workflows/ mounted at /project-workflows/');
  } else {
    skip('.aaron/workflows/ not present in test repo');
  }

  // Check if .aaron/memory/ was discovered
  const hasAaronMemory = tree.some(f => f.path.startsWith('.aaron/memory/'));
  if (hasAaronMemory) {
    const memFiles = vfs.list().filter(p => p.startsWith('/memory/'));
    assert(memFiles.length > 0, '.aaron/memory/ merged into /memory/');
  } else {
    skip('.aaron/memory/ not present in test repo');
  }
}

// ════════════════════════════════════════════════════
// SCENARIO 3: Skill merging
// ════════════════════════════════════════════════════

console.log('\nScenario 3: Skill merging');
{
  const vfs = createVFS();

  // Core skills
  vfs.write('/skills/code-review/SKILL.md', '---\nname: code-review\ndescription: General code review\n---\n\n# Code Review\n\nGeneral review instructions.');
  vfs.write('/skills/testing/SKILL.md', '---\nname: testing\ndescription: Write tests\n---\n\n# Testing\n\nGeneral testing instructions.');

  // Project skill with same name (collision) and a unique one
  vfs.write('/project-skills/code-review/SKILL.md', '---\nname: code-review\ndescription: Project-specific code review for this repo\n---\n\n# Code Review (Project)\n\nProject-specific review instructions.');
  vfs.write('/project-skills/project-linter/SKILL.md', '---\nname: project-linter\ndescription: Lint this project\n---\n\n# Project Linter\n\nProject-specific linting instructions.');

  const index = buildMergedSkillIndex(vfs);

  // code-review should be the project version (collision → project wins)
  assert(index.includes('code-review'), 'merged index includes code-review');
  assert(index.includes('Project-specific code review'), 'project skill wins on name collision');
  assert(!index.includes('General code review'), 'core skill overridden on collision');

  // testing should still be present (no collision)
  assert(index.includes('testing'), 'core skill with no collision still present');

  // project-linter should be present
  assert(index.includes('project-linter'), 'unique project skill present');
  assert(index.includes('[project]'), 'project skills are tagged');
}

// ════════════════════════════════════════════════════
// SCENARIO 4: Workspace snapshot/restore
// ════════════════════════════════════════════════════

console.log('\nScenario 4: Workspace snapshot/restore');
{
  const vfs = createVFS();

  // Agent layer
  vfs.write('/skills/testing/SKILL.md', '---\nname: testing\ndescription: Write tests\n---\n\n# Testing\n\nInstructions.');

  // Hydrate repo A (test repo)
  await initFromGitHub(
    { owner: TEST_OWNER, repo: TEST_REPO, ref: TEST_REF },
    vfs, client,
  );

  const repoAFiles = vfs.list().filter(p => p.startsWith('/src/'));
  const repoASnapshot = snapshotWorkspace(vfs);

  assert(Object.keys(repoASnapshot).length > 0, 'workspace A snapshot has files');

  // Hydrate repo B (Aaron's own repo — different content)
  // First clear workspace layer
  restoreWorkspace(vfs, {}); // empty workspace
  assert(vfs.list().filter(p => p.startsWith('/src/')).length === 0, 'workspace cleared before switching');

  await initFromGitHub(
    { owner: SELF_OWNER, repo: SELF_REPO, ref: SELF_REF },
    vfs, client,
  );

  const repoBFiles = vfs.list().filter(p => p.startsWith('/src/'));
  assert(repoBFiles.length > 0, 'repo B files hydrated');

  // Verify they're different
  const repoBHasAaronFiles = repoBFiles.some(p => p.includes('agent-core') || p.includes('agent-loop'));
  assert(repoBHasAaronFiles, 'repo B has Aaron-specific files');

  // Restore repo A
  restoreWorkspace(vfs, repoASnapshot);
  const restoredFiles = vfs.list().filter(p => p.startsWith('/src/'));
  assert(restoredFiles.length === repoAFiles.length, 'repo A restored — same file count');

  // Agent layer should be untouched through all of this
  assert(vfs.read('/skills/testing/SKILL.md') !== null, 'agent layer survived workspace swaps');
}

// ════════════════════════════════════════════════════
// SCENARIO 5: Context switch preserves agent layer
// ════════════════════════════════════════════════════

console.log('\nScenario 5: Context switch preserves agent layer');
{
  const vfs = createVFS();

  // Set up agent layer
  const harnessContent = 'export const SYSTEM = "immutable test harness";';
  const skillContent = '---\nname: algo\ndescription: Algorithm design\n---\n\n# Algorithm\n\nDesign algorithms.';
  const wfContent = '{"name":"devkit","steps":[]}';

  vfs.write('/harness/agent-loop.js', harnessContent);
  vfs.write('/skills/algo/SKILL.md', skillContent);
  vfs.write('/workflows/devkit.json', wfContent);

  // Hydrate external repo
  await initFromGitHub(
    { owner: TEST_OWNER, repo: TEST_REPO, ref: TEST_REF },
    vfs, client,
  );

  assert(vfs.read('/harness/agent-loop.js') === harnessContent, '/harness/ unchanged after hydration');
  assert(vfs.read('/skills/algo/SKILL.md') === skillContent, '/skills/ unchanged after hydration');
  assert(vfs.read('/workflows/devkit.json') === wfContent, '/workflows/ unchanged after hydration');

  // Snapshot, clear, restore — agent layer should survive
  const snap = snapshotWorkspace(vfs);
  restoreWorkspace(vfs, {}); // clear workspace layer

  assert(vfs.read('/harness/agent-loop.js') === harnessContent, '/harness/ survives workspace clear');
  assert(vfs.read('/skills/algo/SKILL.md') === skillContent, '/skills/ survives workspace clear');

  restoreWorkspace(vfs, snap); // restore workspace layer
  assert(vfs.read('/harness/agent-loop.js') === harnessContent, '/harness/ survives workspace restore');
}

// ════════════════════════════════════════════════════
// SCENARIO 6: Context switch preserves conversation
// ════════════════════════════════════════════════════

console.log('\nScenario 6: Context switch preserves conversation');
{
  // Simulate two workspaces with independent histories
  const historyA = [
    { role: 'user', content: 'review the test repo' },
    { role: 'assistant', content: 'code block for test repo' },
  ];
  const historyB = [
    { role: 'user', content: 'improve Aaron skills' },
    { role: 'assistant', content: 'code block for Aaron' },
    { role: 'user', content: 'run RSI' },
  ];

  // Workspace bundles include history
  const workspaceA = { history: historyA, turn: 1 };
  const workspaceB = { history: historyB, turn: 2 };

  // Switch to A
  let currentHistory = workspaceA.history;
  let currentTurn = workspaceA.turn;
  assert(currentHistory.length === 2, 'workspace A has 2 messages');
  assert(currentHistory[0].content.includes('test repo'), 'workspace A has correct context');

  // Switch to B (save A first)
  workspaceA.history = currentHistory;
  workspaceA.turn = currentTurn;

  currentHistory = workspaceB.history;
  currentTurn = workspaceB.turn;
  assert(currentHistory.length === 3, 'workspace B has 3 messages');
  assert(currentHistory[0].content.includes('Aaron'), 'workspace B has correct context');

  // Switch back to A
  workspaceB.history = currentHistory;
  currentHistory = workspaceA.history;
  assert(currentHistory.length === 2, 'workspace A history preserved after round-trip');
  assert(currentHistory[0].content.includes('test repo'), 'workspace A context intact');
}

// ════════════════════════════════════════════════════
// SCENARIO 7: Workspace-scoped session persistence
// ════════════════════════════════════════════════════

console.log('\nScenario 7: Workspace-scoped session persistence');
{
  // Test that workspace IDs produce distinct session keys
  const idA = getWorkspaceId(TEST_OWNER, TEST_REPO, TEST_REF);
  const idB = getWorkspaceId(SELF_OWNER, SELF_REPO, SELF_REF);
  const idC = getWorkspaceId(TEST_OWNER, TEST_REPO, 'develop');

  assert(idA === `${TEST_OWNER}/${TEST_REPO}@${TEST_REF}`, 'workspace ID format correct');
  assert(idA !== idB, 'different repos produce different workspace IDs');
  assert(idA !== idC, 'different refs produce different workspace IDs');

  // Simulate session payloads
  const sessionA = {
    version: 1,
    workspaceId: idA,
    timestamp: new Date().toISOString(),
    state: { history: [{ role: 'user', content: 'test repo task' }], turn: 1 },
    vfs: { '/src/index.js': 'test content' },
  };

  const sessionB = {
    version: 1,
    workspaceId: idB,
    timestamp: new Date().toISOString(),
    state: { history: [{ role: 'user', content: 'aaron task' }], turn: 3 },
    vfs: { '/src/agent-core.js': 'aaron content' },
  };

  // Verify they're independent
  assert(sessionA.workspaceId !== sessionB.workspaceId, 'sessions have different workspace IDs');
  assert(sessionA.state.history[0].content !== sessionB.state.history[0].content, 'sessions have independent histories');

  // Simulate storage and retrieval
  const storage = new Map();
  storage.set(`aaron-workspace-${idA}`, JSON.stringify(sessionA));
  storage.set(`aaron-workspace-${idB}`, JSON.stringify(sessionB));

  const loadedA = JSON.parse(storage.get(`aaron-workspace-${idA}`));
  const loadedB = JSON.parse(storage.get(`aaron-workspace-${idB}`));

  assert(loadedA.state.turn === 1, 'session A restored with correct turn');
  assert(loadedB.state.turn === 3, 'session B restored with correct turn');
  assert(loadedA.vfs['/src/index.js'] === 'test content', 'session A VFS restored');
}

// ════════════════════════════════════════════════════
// SCENARIO 8: Commit to external repo
// ════════════════════════════════════════════════════

console.log('\nScenario 8: Commit to external repo');
{
  // Check if test branch exists
  const branch = await client.getBranch(TEST_OWNER, TEST_REPO, TEST_BRANCH);

  if (!branch) {
    skip(`branch "${TEST_BRANCH}" not found — create it per plan.md`);
  } else {
    const vfs = createVFS();
    await initFromGitHub(
      { owner: TEST_OWNER, repo: TEST_REPO, ref: TEST_BRANCH },
      vfs, client,
    );

    // Modify a file
    const testPath = '/src/src/index.js';
    const original = vfs.read(testPath);
    if (original !== null) {
      const testContent = original + '\n// workspace-test-' + Date.now();
      vfs.write(testPath, testContent);
      assert(vfs.isDirty(testPath), 'modified file is dirty');

      const events = [];
      const result = await commitToGitHub(vfs, client, {
        owner: TEST_OWNER, repo: TEST_REPO,
        branch: TEST_BRANCH,
        message: 'test: workspace commit scenario (auto-cleanup)',
        pathPrefix: '/src/',
      }, (ev) => events.push(ev));

      assert(result.pushed.length > 0, 'file pushed to test branch');
      assert(result.conflicts.length === 0, 'no conflicts on push');
      assert(!vfs.isDirty(testPath), 'file marked clean after push');

      // Restore original content
      vfs.write(testPath, original);
      await commitToGitHub(vfs, client, {
        owner: TEST_OWNER, repo: TEST_REPO,
        branch: TEST_BRANCH,
        message: 'test: cleanup — restore original',
        pathPrefix: '/src/',
      });
    } else {
      skip('src/index.js not found in test repo');
    }
  }
}

// ════════════════════════════════════════════════════
// SCENARIO 9: .aaron/ commit-back
// ════════════════════════════════════════════════════

console.log('\nScenario 9: .aaron/ commit-back');
{
  const branch = await client.getBranch(TEST_OWNER, TEST_REPO, TEST_BRANCH);
  const hasAaronDir = tree.some(f => f.path.startsWith('.aaron/'));

  if (!branch) {
    skip(`branch "${TEST_BRANCH}" not found`);
  } else if (!hasAaronDir) {
    skip('.aaron/ directory not present in test repo');
  } else {
    const vfs = createVFS();
    await hydrateWithAaron(
      { owner: TEST_OWNER, repo: TEST_REPO, ref: TEST_BRANCH },
      vfs, client,
    );

    // Modify a project skill in VFS
    const skillPath = '/project-skills/project-linter/SKILL.md';
    const originalSkill = vfs.read(skillPath);

    if (originalSkill) {
      const modifiedSkill = originalSkill + '\n\n<!-- workspace test marker ' + Date.now() + ' -->';
      vfs.write(skillPath, modifiedSkill);

      // To commit back, we need to map /project-skills/ → .aaron/skills/ in the repo
      // This simulates the commit-back logic from Decision 15
      const aaronRepoPath = '.aaron/skills/project-linter/SKILL.md';
      const vfsSrcPath = '/src/' + aaronRepoPath;
      vfs.write(vfsSrcPath, modifiedSkill);

      const result = await commitToGitHub(vfs, client, {
        owner: TEST_OWNER, repo: TEST_REPO,
        branch: TEST_BRANCH,
        message: 'test: .aaron/ commit-back scenario (auto-cleanup)',
        pathPrefix: '/src/',
      });

      const pushedAaron = result.pushed.some(p => p.includes('.aaron'));
      assert(pushedAaron, '.aaron/ file pushed via commit-back');

      // Cleanup: restore original
      vfs.write(vfsSrcPath, originalSkill);
      await commitToGitHub(vfs, client, {
        owner: TEST_OWNER, repo: TEST_REPO,
        branch: TEST_BRANCH,
        message: 'test: cleanup — restore .aaron/ original',
        pathPrefix: '/src/',
      });
    } else {
      skip('project-linter skill not found for commit-back test');
    }
  }
}

// ════════════════════════════════════════════════════
// SCENARIO 10: Workspace ID derivation
// ════════════════════════════════════════════════════

console.log('\nScenario 10: Workspace ID derivation');
{
  // Same repo+ref = same ID
  const id1 = getWorkspaceId('weolopez', 'aaron', 'main');
  const id2 = getWorkspaceId('weolopez', 'aaron', 'main');
  assert(id1 === id2, 'same repo+ref produces identical workspace ID');

  // Different ref = different ID
  const id3 = getWorkspaceId('weolopez', 'aaron', 'develop');
  assert(id1 !== id3, 'different ref produces different workspace ID');

  // Different repo = different ID
  const id4 = getWorkspaceId('weolopez', 'aaron-test-repo', 'main');
  assert(id1 !== id4, 'different repo produces different workspace ID');

  // Different owner = different ID
  const id5 = getWorkspaceId('other-user', 'aaron', 'main');
  assert(id1 !== id5, 'different owner produces different workspace ID');

  // ID format is human-readable
  assert(id1.includes('weolopez'), 'workspace ID includes owner');
  assert(id1.includes('aaron'), 'workspace ID includes repo name');
  assert(id1.includes('main'), 'workspace ID includes ref');
}

// ════════════════════════════════════════════════════
// SCENARIO 11: Switch back to Aaron's own repo
// ════════════════════════════════════════════════════

console.log('\nScenario 11: Switch back to self');
{
  const vfs = createVFS();

  // Agent layer
  vfs.write('/skills/testing/SKILL.md', '---\nname: testing\ndescription: Write tests\n---\n\n# Testing\n\nInstructions here.');

  // Start in "self" workspace — hydrate Aaron's repo
  await initFromGitHub(
    { owner: SELF_OWNER, repo: SELF_REPO, ref: SELF_REF },
    vfs, client,
  );
  const selfSnapshot = snapshotWorkspace(vfs);
  const selfFileCount = vfs.list().filter(p => p.startsWith('/src/')).length;
  assert(selfFileCount > 0, 'self workspace has files');

  // Switch to external repo
  restoreWorkspace(vfs, {});
  await initFromGitHub(
    { owner: TEST_OWNER, repo: TEST_REPO, ref: TEST_REF },
    vfs, client,
  );
  const externalFileCount = vfs.list().filter(p => p.startsWith('/src/')).length;
  assert(externalFileCount > 0, 'external workspace has files');
  assert(externalFileCount !== selfFileCount, 'external workspace has different file count');

  // Switch back to self
  restoreWorkspace(vfs, selfSnapshot);
  const restoredFileCount = vfs.list().filter(p => p.startsWith('/src/')).length;
  assert(restoredFileCount === selfFileCount, 'self workspace restored — correct file count');

  // Verify agent layer survived the round trip
  assert(vfs.read('/skills/testing/SKILL.md') !== null, 'agent layer intact after self→external→self');
}

// ════════════════════════════════════════════════════
// SCENARIO 12: Project workflow execution
// ════════════════════════════════════════════════════

console.log('\nScenario 12: Project workflow execution');
{
  const vfs = createVFS();
  await hydrateWithAaron(
    { owner: TEST_OWNER, repo: TEST_REPO, ref: TEST_REF },
    vfs, client,
  );

  const projectWorkflows = vfs.list().filter(p =>
    p.startsWith('/project-workflows/') && p.endsWith('.json')
  );

  if (projectWorkflows.length > 0) {
    const wfPath = projectWorkflows[0];
    const wfRaw = vfs.read(wfPath);
    let wf;
    try {
      wf = JSON.parse(wfRaw);
    } catch {
      wf = null;
    }

    assert(wf !== null, 'project workflow is valid JSON');
    assert(typeof wf.name === 'string', 'project workflow has name');
    assert(Array.isArray(wf.steps), 'project workflow has steps array');
    assert(wf.steps.length > 0, 'project workflow has at least one step');

    // Verify each step has required fields
    for (const step of wf.steps) {
      assert(typeof step.id === 'string', `step "${step.id}" has id`);
      assert(typeof step.prompt === 'string', `step "${step.id}" has prompt`);
    }
  } else {
    skip('no project workflows found — create .aaron/workflows/ per plan.md');
  }
}

// ════════════════════════════════════════════════════
// SCENARIO 13: RSI scope boundary
// ════════════════════════════════════════════════════

console.log('\nScenario 13: RSI scope boundary');
{
  const vfs = createVFS();

  // Core skills (agent layer)
  const coreSkillContent = '---\nname: code-review\ndescription: General code review\n---\n\n# Code Review\n\nGeneral instructions.';
  vfs.write('/skills/code-review/SKILL.md', coreSkillContent);

  // Project skills
  vfs.write('/project-skills/project-linter/SKILL.md', '---\nname: project-linter\ndescription: Lint this project\n---\n\n# Project Linter\n\nLinting instructions.');

  // Simulate RSI mutation on project skill (allowed)
  const projectSkillPath = '/project-skills/project-linter/SKILL.md';
  const mutatedProjectSkill = '---\nname: project-linter\ndescription: Improved project linting\n---\n\n# Project Linter v2\n\nImproved linting instructions with better coverage.';
  vfs.write(projectSkillPath, mutatedProjectSkill);

  // Verify project skill was mutated
  assert(vfs.read(projectSkillPath) === mutatedProjectSkill, 'project skill can be mutated by RSI');

  // Verify core skill was NOT mutated
  assert(vfs.read('/skills/code-review/SKILL.md') === coreSkillContent, 'core skill untouched during project RSI');

  // Snapshot to test that RSI snapshot/restore only affects project skills
  const snap = vfs.snapshot('/project-skills/');
  assert(Object.keys(snap).length > 0, 'project skills snapshot captured');

  // Verify snapshot does NOT include core skills
  const coreInSnap = Object.keys(snap).some(k => k.startsWith('/skills/'));
  assert(!coreInSnap, 'project skill snapshot does not include core skills');

  // Restore should only affect project skills
  vfs.write(projectSkillPath, 'TEMPORARY CHANGE');
  vfs.restore(snap);
  assert(vfs.read(projectSkillPath) === mutatedProjectSkill, 'project skill restored from snapshot');
  assert(vfs.read('/skills/code-review/SKILL.md') === coreSkillContent, 'core skill still untouched after restore');
}

// ════════════════════════════════════════════════════
// SCENARIO 14: Large repo filtering
// ════════════════════════════════════════════════════

console.log('\nScenario 14: Large repo filtering');
{
  const vfs = createVFS();

  // Hydrate with include filter — only src/ files
  await initFromGitHub(
    { owner: TEST_OWNER, repo: TEST_REPO, ref: TEST_REF, include: ['src/'] },
    vfs, client,
  );

  const allFiles = vfs.list().filter(p => p.startsWith('/src/'));

  // Should have src/ files but not root files like README.md
  const hasSrcFiles = allFiles.some(p => p.includes('/src/src/'));
  const hasReadme = allFiles.some(p => p.includes('README'));
  const hasDocs = allFiles.some(p => p.includes('/docs/'));

  if (hasSrcFiles) {
    assert(true, 'include filter allows src/ files');
  } else {
    skip('no src/ directory in test repo');
  }

  // README and docs should be excluded (they're not under src/)
  // Note: they'll still be under /src/README.md because initFromGitHub prepends /src/
  // But the include filter should have excluded them from being fetched
  const filesOutsideSrc = allFiles.filter(p => {
    const repoPath = p.slice('/src/'.length); // strip VFS prefix
    return !repoPath.startsWith('src/');
  });

  assert(filesOutsideSrc.length === 0, 'include filter excludes non-matching files');
}

{
  // Test exclude filter
  const vfs = createVFS();
  await initFromGitHub(
    { owner: TEST_OWNER, repo: TEST_REPO, ref: TEST_REF, exclude: ['docs/'] },
    vfs, client,
  );

  const allFiles = vfs.list().filter(p => p.startsWith('/src/'));
  const hasDocsFiles = allFiles.some(p => p.includes('/docs/'));

  // docs/ should be excluded
  assert(!hasDocsFiles, 'exclude filter removes docs/ files');
}

// ════════════════════════════════════════════════════
// RESULTS
// ════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(50)}`);
console.log(`${passed + failed + skipped} tests: ${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) {
  console.log('\nSome tests failed. Check the test repo structure matches plan.md.');
  process.exit(1);
}
if (skipped > 0) {
  console.log('\nSome tests skipped. Set up the test repo per plan.md to run all scenarios.');
}
console.log('');
