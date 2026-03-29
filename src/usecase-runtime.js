/**
 * usecase-runtime.js
 *
 * Shared runtime helpers for declarative usecase runners.
 * Keep this logic reusable across CLI/REPL/web-driven execution flows.
 */

import { createCommitFn } from './commit.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Create a GitHub helper bound to a repo/ref. */
export function createGitHubHelper(client, { owner, repo, ref, base = 'main' }) {
  return {
    owner,
    repo,
    ref,
    async getLatestSha(branch = ref) {
      const data = await client.getBranch(owner, repo, branch);
      if (!data) throw new Error(`Branch not found: ${branch}`);
      return data.sha;
    },
    async createBranch(name, fromRef = ref) {
      const sha = await this.getLatestSha(fromRef);
      await client.createBranch(owner, repo, name, sha);
    },
    async createPR({ title, body, head, base: prBase = base }) {
      return client.createPR(owner, repo, { title, body, head, base: prBase });
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
}

/** Standard test UI adapter for runTurn. */
export function createTestUiAdapter(emit) {
  return {
    setStatus() {},
    showCode() {},
    emitEvent: emit,
    onRetry(attempt, max) {
      process.stdout.write(`    ↺ retry ${attempt}/${max}\n`);
    },
    onTurnComplete() {},
  };
}

/** Create a normalized emitter that records and prints key events. */
export function createRecordingEmitter(events, { print = true } = {}) {
  return (ev) => {
    events.push(ev);
    if (!print) return;
    if (ev.type === 'progress') process.stdout.write(`    ◆ ${ev.message}\n`);
    else if (ev.type === 'done') process.stdout.write(`    ✓ ${ev.message}\n`);
    else if (ev.type === 'blocked') process.stdout.write(`    ⊘ ${ev.reason}\n`);
    else if (ev.type === 'error') process.stdout.write(`    ✕ ${ev.message}\n`);
  };
}

/** Extract the most recent PR info from workflow result events. */
export function extractPRFromEvents(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== 'result') continue;
    if (ev.value?.pr_number) {
      return { prNumber: ev.value.pr_number, prUrl: ev.value.pr_url ?? null };
    }
    if (ev.value?.pr_url) {
      const match = String(ev.value.pr_url).match(/\/pull\/(\d+)/);
      if (match) {
        return { prNumber: parseInt(match[1], 10), prUrl: ev.value.pr_url };
      }
    }
  }
  return { prNumber: null, prUrl: null };
}

/**
 * Build a standard commit() closure used by usecase contexts.
 * This reuses shared commit pipeline behavior from src/commit.js.
 */
export function createUsecaseCommit({ vfs, client, owner, repo, ref, emit }) {
  return createCommitFn({
    vfs,
    getGitHub: () => ({
      client,
      config: { owner, repo, ref },
    }),
    commitToGitHub: async (vfsRef, ghClient, opts, emitFn) => {
      // Lazy import to avoid circular coupling at module init time.
      const mod = await import('./github.js');
      return mod.commitToGitHub(vfsRef, ghClient, opts, emitFn);
    },
    emit,
    ghPrefixes: ['/src/'],
  });
}

/**
 * Recursively load a local directory from disk into the VFS.
 * Uses dynamic import for node:fs so this module stays isomorphic.
 */
export async function loadDirIntoVfs(vfs, baseDir, vfsPrefix) {
  const { existsSync, readFileSync, readdirSync } = await import('node:fs');
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
        } catch { /* skip unreadable files */ }
      }
    }
  })(baseDir, vfsPrefix);
}

// Auto-detect project root from this file's location (src/ → parent dir)
const _ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Build a fully-loaded workspace context for running Aaron workflows.
 * Loads local skills and workflows from rootPath (defaults to project root),
 * then hydrates VFS from GitHub.
 *
 * @param {object} client - GitHub client (from createGitHubClient)
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} [opts.ref='main']
 * @param {string} [opts.base='main']
 * @param {string|null} [opts.rootPath] - path to project root; null to skip local loading
 * @returns {{ vfs, context, state, deps, events, hydrated }}
 */
export async function buildWorkspaceContext(client, { owner, repo, ref = 'main', base = 'main', rootPath = _ROOT } = {}) {
  const { createVFS, execute, extractCode } = await import('./agent-core.js');
  const { runTurn, buildSkillIndex } = await import('./agent-loop.js');
  const { initFromGitHub } = await import('./github.js');

  const vfs = createVFS();
  const events = [];

  if (rootPath) {
    await loadDirIntoVfs(vfs, join(rootPath, 'skills'), '/skills/');
    await loadDirIntoVfs(vfs, join(rootPath, 'workflows'), '/workflows/');
  }

  const hydrated = await initFromGitHub(
    { owner, repo, ref },
    vfs,
    client,
    (ev) => events.push(ev),
  );

  const emit = createRecordingEmitter(events);
  const ghHelper = createGitHubHelper(client, { owner, repo, ref, base });
  const skillIndex = buildSkillIndex(vfs);

  const context = {
    vfs,
    fetch: (...args) => fetch(...args),
    emit,
    env: {},
    skillIndex,
    github: ghHelper,
    commit: createUsecaseCommit({ vfs, client, owner, repo, ref, emit }),
    workspaceId: `${owner}/${repo}@${ref}`,
  };

  const state = { history: [], turn: 0, context };
  const deps = { execute, extractCode, ui: createTestUiAdapter(emit), runTurn };

  return { vfs, context, state, deps, events, hydrated };
}
