/**
 * workspace.js — Workspace lifecycle management for multi-repo architecture
 *
 * Implements the two-layer VFS model from ADR.md Decision 14:
 *   - Agent layer (global, persistent): /harness/, /skills/, /workflows/
 *   - Workspace layer (per-repo, swappable): /src/, /memory/, /scratch/, /artifacts/,
 *     /project-skills/, /project-workflows/
 *
 * A workspace is a serializable bundle of the workspace layer, keyed by a stable ID.
 * Switching workspaces = snapshot current → persist → restore target.
 *
 * Exports: createWorkspace, snapshotWorkspace, restoreWorkspace, getWorkspaceId,
 *          isWorkspacePath, isAgentPath, WORKSPACE_PREFIXES, AGENT_PREFIXES
 */

// ════════════════════════════════════════════════════
// PATH CONSTANTS
// ════════════════════════════════════════════════════

/** VFS path prefixes that belong to the workspace layer (per-repo, swappable) */
export const WORKSPACE_PREFIXES = [
  '/src/',
  '/memory/',
  '/scratch/',
  '/artifacts/',
  '/project-skills/',
  '/project-workflows/',
];

/** VFS path prefixes that belong to the agent layer (global, never swapped) */
export const AGENT_PREFIXES = [
  '/harness/',
  '/skills/',
  '/workflows/',
];

// ════════════════════════════════════════════════════
// PATH CLASSIFICATION
// ════════════════════════════════════════════════════

/**
 * Check if a VFS path belongs to the workspace layer.
 * @param {string} path - VFS path like '/src/index.js'
 * @returns {boolean}
 */
export function isWorkspacePath(path) {
  for (const prefix of WORKSPACE_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Check if a VFS path belongs to the agent layer.
 * @param {string} path - VFS path like '/skills/testing/SKILL.md'
 * @returns {boolean}
 */
export function isAgentPath(path) {
  for (const prefix of AGENT_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

// ════════════════════════════════════════════════════
// WORKSPACE ID
// ════════════════════════════════════════════════════

/**
 * Generate a stable workspace ID from repo coordinates.
 * @param {string} owner - GitHub owner (e.g., 'weolopez')
 * @param {string} repo - Repository name (e.g., 'aaron')
 * @param {string} ref - Git ref (e.g., 'main', 'develop', 'feature-x')
 * @returns {string} Workspace ID in format "owner/repo@ref"
 */
export function getWorkspaceId(owner, repo, ref = 'main') {
  return `${owner}/${repo}@${ref}`;
}

/**
 * Parse a workspace ID into its components.
 * @param {string} id - Workspace ID like "weolopez/aaron@main"
 * @returns {{owner: string, repo: string, ref: string} | null}
 */
export function parseWorkspaceId(id) {
  const match = id.match(/^([^/]+)\/([^@]+)@(.+)$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], ref: match[3] };
}

/**
 * Get the special "self" workspace ID for Aaron's own repo.
 * This is used when Aaron is working on its own codebase.
 * @returns {string} "self"
 */
export function getSelfWorkspaceId() {
  return 'self';
}

// ════════════════════════════════════════════════════
// WORKSPACE BUNDLE
// ════════════════════════════════════════════════════

/**
 * Create a fresh workspace bundle.
 * @param {string} id - Workspace ID (from getWorkspaceId or getSelfWorkspaceId)
 * @param {Object} options - Optional initial values
 * @param {{owner: string, repo: string, ref: string}} options.github - GitHub coordinates
 * @returns {Object} Workspace bundle
 */
export function createWorkspace(id, options = {}) {
  return {
    id,
    github: options.github || null,
    src: {},                    // VFS snapshot of /src/
    memory: {},                 // VFS snapshot of /memory/
    scratch: {},                // VFS snapshot of /scratch/
    artifacts: {},              // VFS snapshot of /artifacts/
    projectSkills: {},          // VFS snapshot of /project-skills/
    projectWorkflows: {},       // VFS snapshot of /project-workflows/
    history: [],                // Conversation history for this workspace
    turn: 0,                    // Turn counter
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ════════════════════════════════════════════════════
// SNAPSHOT / RESTORE
// ════════════════════════════════════════════════════

/**
 * Extract the workspace layer from VFS into a serializable bundle.
 * Uses VFS snapshot() under the hood.
 *
 * @param {Object} vfs - VFS instance from createVFS()
 * @param {Object} state - Optional agent state to include (history, turn)
 * @returns {Object} Workspace bundle with vfs snapshots and state
 */
export function snapshotWorkspace(vfs, state = null) {
  const bundle = {
    src: {},
    memory: {},
    scratch: {},
    artifacts: {},
    projectSkills: {},
    projectWorkflows: {},
    timestamp: new Date().toISOString(),
  };

  // Extract each workspace prefix
  for (const prefix of WORKSPACE_PREFIXES) {
    const snap = vfs.snapshot(prefix);
    const key = prefixToKey(prefix);
    bundle[key] = snap;
  }

  // Include conversation state if provided
  if (state) {
    bundle.history = state.history ? [...state.history] : [];
    bundle.turn = state.turn || 0;
  }

  return bundle;
}

/**
 * Restore the workspace layer into VFS from a bundle.
 * Clears existing workspace-layer paths first, then loads bundle contents.
 * Agent layer is never touched.
 *
 * @param {Object} vfs - VFS instance from createVFS()
 * @param {Object} bundle - Workspace bundle from snapshotWorkspace()
 * @returns {Object} Restored state { history, turn } if present in bundle
 */
export function restoreWorkspace(vfs, bundle) {
  // Step 1: Clear all workspace-layer paths
  const allPaths = vfs.list();
  for (const path of allPaths) {
    if (isWorkspacePath(path)) {
      vfs.delete(path);
    }
  }

  // Step 2: Load bundle contents into VFS
  for (const prefix of WORKSPACE_PREFIXES) {
    const key = prefixToKey(prefix);
    const snap = bundle[key] || {};

    for (const [path, entry] of Object.entries(snap)) {
      vfs.write(path, entry.content);
      if (entry.sha) vfs.setSHA(path, entry.sha);
      if (!entry.dirty) vfs.markClean(path);
    }
  }

  // Step 3: Return conversation state if present
  if (bundle.history !== undefined) {
    return {
      history: bundle.history,
      turn: bundle.turn || 0,
    };
  }

  return null;
}

// ════════════════════════════════════════════════════
// CONTEXT SWITCHING
// ════════════════════════════════════════════════════

/**
 * Switch from current workspace to a target workspace.
 * This is the high-level operation: snapshot → restore → rebuild.
 *
 * @param {Object} vfs - VFS instance
 * @param {Object} state - Agent state (will be updated)
 * @param {Object} targetBundle - Workspace bundle to switch to
 * @param {Object} options - Switch options
 * @param {Function} options.onSnapshot - Callback(currentBundle) before restore
 * @param {Function} options.onRestore - Callback(restoredState) after restore
 * @returns {Object} The previous workspace bundle (for undo/rollback)
 */
export function switchWorkspace(vfs, state, targetBundle, options = {}) {
  // Snapshot current workspace
  const currentBundle = snapshotWorkspace(vfs, state);

  // Optional callback with current state
  if (options.onSnapshot) {
    options.onSnapshot(currentBundle);
  }

  // Restore target workspace
  const restoredState = restoreWorkspace(vfs, targetBundle);

  // Update state if conversation history was restored
  if (restoredState && state) {
    state.history = restoredState.history;
    state.turn = restoredState.turn;
  }

  // Optional callback after restore
  if (options.onRestore) {
    options.onRestore(restoredState);
  }

  return currentBundle;
}

// ════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════

/**
 * Convert a VFS prefix to a bundle key.
 * @param {string} prefix - VFS prefix like '/src/'
 * @returns {string} Bundle key like 'src'
 */
function prefixToKey(prefix) {
  // Remove leading and trailing slashes, then camelCase hyphenated segments
  // e.g. '/project-skills/' → 'projectSkills'
  return prefix.replace(/^\//, '').replace(/\/$/, '')
    .replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

/**
 * Get a summary of the workspace layer in VFS.
 * Useful for debugging and UI display.
 * @param {Object} vfs - VFS instance
 * @returns {Object} Summary with file counts per prefix
 */
export function getWorkspaceSummary(vfs) {
  const summary = {};
  const allPaths = vfs.list();

  for (const prefix of WORKSPACE_PREFIXES) {
    const paths = allPaths.filter(p => p.startsWith(prefix));
    const key = prefixToKey(prefix);
    summary[key] = {
      fileCount: paths.length,
      dirtyCount: paths.filter(p => vfs.isDirty(p)).length,
      totalSize: paths.reduce((sum, p) => sum + vfs.size(p), 0),
    };
  }

  return summary;
}

/**
 * Check if a workspace bundle is empty (has no files).
 * @param {Object} bundle - Workspace bundle
 * @returns {boolean}
 */
export function isEmptyWorkspace(bundle) {
  for (const prefix of WORKSPACE_PREFIXES) {
    const key = prefixToKey(prefix);
    const snap = bundle[key] || {};
    if (Object.keys(snap).length > 0) return false;
  }
  return true;
}
