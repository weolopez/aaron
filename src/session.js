/**
 * session.js — Workspace-aware session persistence for agent state and VFS
 *
 * Saves/restores conversation history and VFS contents per workspace.
 * Supports multiple concurrent workspace sessions.
 * Works in both Node.js (CLI) and browser environments.
 *
 * See ADR.md Decision 14 for workspace architecture.
 */

import { getSelfWorkspaceId } from './workspace.js';

// ════════════════════════════════════════════════════
// Environment Detection
// ════════════════════════════════════════════════════

const isNode = typeof process !== 'undefined' && process.versions?.node;
const isBrowser = typeof window !== 'undefined';

// ════════════════════════════════════════════════════
// Storage Paths (Workspace-aware)
// ════════════════════════════════════════════════════

const SESSION_VERSION = 2;

/**
 * Get browser storage key for a workspace.
 * @param {string} workspaceId - Workspace ID
 * @returns {string} Storage key
 */
function getBrowserKey(workspaceId) {
  return `aaron-workspace-${workspaceId}`;
}

/**
 * Get Node.js session file path for a workspace.
 * Note: This is synchronous for use in non-async contexts.
 * @param {string} workspaceId - Workspace ID
 * @returns {string|null} File path or null if not Node.js
 */
function getNodeSessionPathSync(workspaceId) {
  if (!isNode) return null;
  // Synchronous path construction - no async imports needed
  const homedir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const sanitizedId = workspaceId.replace(/[\/\\:@]/g, '_');
  return `${homedir}/.aaron/workspaces/${sanitizedId}/session.json`;
}

/**
 * Async version of getNodeSessionPath for consistency.
 * @param {string} workspaceId - Workspace ID
 * @returns {Promise<string|null>} File path or null if not Node.js
 */
async function getNodeSessionPath(workspaceId) {
  if (!isNode) return null;
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  return join(
    homedir(),
    '.aaron',
    'workspaces',
    workspaceId.replace(/[\/\\:@]/g, '_'),
    'session.json'
  );
}

// Legacy paths for migration
const LEGACY_BROWSER_KEY = 'aaron-session';
const LEGACY_NODE_PATH = isNode
  ? (await import('node:path')).join(
      (await import('node:os')).homedir(),
      '.aaron_session.json'
    )
  : null;

// ════════════════════════════════════════════════════
// Save Session (Workspace-aware)
// ════════════════════════════════════════════════════

/**
 * Save agent state and VFS contents to persistent storage for a workspace.
 * @param {string} workspaceId - Workspace ID (e.g., 'weolopez/aaron@main' or 'self')
 * @param {Object} state - Agent state (history, turn count, etc.)
 * @param {Object} vfs - VFS instance with dump() method
 * @returns {Promise<boolean>} - Success status
 */
export async function saveSession(workspaceId, state, vfs) {
  const payload = {
    version: SESSION_VERSION,
    timestamp: new Date().toISOString(),
    workspaceId,
    state: {
      history: state.history,
      turn: state.turn || 0,
    },
    vfs: vfs?.dump ? vfs.dump() : {},
  };

  try {
    if (isNode) {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');

      const sessionPath = await getNodeSessionPath(workspaceId);

      // Ensure directory exists
      const dir = dirname(sessionPath);
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // Directory may already exist
      }

      writeFileSync(sessionPath, JSON.stringify(payload, null, 2), 'utf-8');
    } else if (isBrowser && typeof localStorage !== 'undefined') {
      localStorage.setItem(getBrowserKey(workspaceId), JSON.stringify(payload));
    } else {
      console.warn('[Session] No persistent storage available');
      return false;
    }
    return true;
  } catch (error) {
    console.error('[Session] Failed to save:', error.message);
    return false;
  }
}

// ════════════════════════════════════════════════════
// Load Session (Workspace-aware)
// ════════════════════════════════════════════════════

/**
 * Load saved session from persistent storage for a workspace.
 * @param {string} workspaceId - Workspace ID to load
 * @returns {Promise<{state: Object, vfs: Object, workspaceId: string} | null>} - Session data or null
 */
export async function loadSession(workspaceId) {
  try {
    let payload;

    if (isNode) {
      const { readFileSync } = await import('node:fs');
      const sessionPath = await getNodeSessionPath(workspaceId);
      const data = readFileSync(sessionPath, 'utf-8');
      payload = JSON.parse(data);
    } else if (isBrowser && typeof localStorage !== 'undefined') {
      const data = localStorage.getItem(getBrowserKey(workspaceId));
      if (!data) return null;
      payload = JSON.parse(data);
    } else {
      return null;
    }

    // Validate version
    if (payload.version !== SESSION_VERSION) {
      console.warn('[Session] Incompatible version:', payload.version);
      return null;
    }

    // Validate workspace ID matches
    if (payload.workspaceId !== workspaceId) {
      console.warn('[Session] Workspace ID mismatch:', payload.workspaceId, 'vs', workspaceId);
      return null;
    }

    return {
      workspaceId: payload.workspaceId,
      state: payload.state,
      vfs: payload.vfs || {},
      timestamp: payload.timestamp,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      // No saved session exists - this is normal
      return null;
    }
    console.error('[Session] Failed to load:', error.message);
    return null;
  }
}

// ════════════════════════════════════════════════════
// Clear Session (Workspace-aware)
// ════════════════════════════════════════════════════

/**
 * Clear the saved session for a workspace.
 * @param {string} workspaceId - Workspace ID to clear
 * @returns {Promise<boolean>} - Success status
 */
export async function clearSession(workspaceId) {
  try {
    if (isNode) {
      const { unlinkSync } = await import('node:fs');
      const sessionPath = await getNodeSessionPath(workspaceId);
      unlinkSync(sessionPath);
    } else if (isBrowser && typeof localStorage !== 'undefined') {
      localStorage.removeItem(getBrowserKey(workspaceId));
    } else {
      return false;
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // File doesn't exist - that's fine
      return true;
    }
    console.error('[Session] Failed to clear:', error.message);
    return false;
  }
}

// ════════════════════════════════════════════════════
// Check Session Exists (Workspace-aware)
// ════════════════════════════════════════════════════

/**
 * Check if a saved session exists for a workspace.
 * @param {string} workspaceId - Workspace ID to check
 * @returns {Promise<boolean>}
 */
export async function hasSession(workspaceId) {
  try {
    if (isNode) {
      const { existsSync } = await import('node:fs');
      const sessionPath = await getNodeSessionPath(workspaceId);
      return existsSync(sessionPath);
    } else if (isBrowser && typeof localStorage !== 'undefined') {
      return localStorage.getItem(getBrowserKey(workspaceId)) !== null;
    }
    return false;
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════
// List Sessions
// ════════════════════════════════════════════════════

/**
 * List all saved workspace sessions.
 * @returns {Promise<Array<{workspaceId: string, timestamp: string}>>} - Array of session info
 */
export async function listSessions() {
  const sessions = [];

  try {
    if (isNode) {
      const { readdirSync, statSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { homedir } = await import('node:os');

      const workspacesDir = join(homedir(), '.aaron', 'workspaces');

      try {
        const entries = readdirSync(workspacesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          const sessionPath = join(workspacesDir, entry.name, 'session.json');
          try {
            const stats = statSync(sessionPath);
            const data = readFileSync(sessionPath, 'utf-8');
            const payload = JSON.parse(data);

            if (payload.version === SESSION_VERSION && payload.workspaceId) {
              sessions.push({
                workspaceId: payload.workspaceId,
                timestamp: payload.timestamp,
              });
            }
          } catch {
            // Skip invalid entries
          }
        }
      } catch {
        // Directory doesn't exist yet
      }
    } else if (isBrowser && typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith('aaron-workspace-')) {
          try {
            const data = localStorage.getItem(key);
            const payload = JSON.parse(data);

            if (payload.version === SESSION_VERSION && payload.workspaceId) {
              sessions.push({
                workspaceId: payload.workspaceId,
                timestamp: payload.timestamp,
              });
            }
          } catch {
            // Skip invalid entries
          }
        }
      }
    }
  } catch (error) {
    console.error('[Session] Failed to list sessions:', error.message);
  }

  // Sort by timestamp descending (most recent first)
  return sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

// ════════════════════════════════════════════════════
// Migration: Legacy Session to Workspace
// ════════════════════════════════════════════════════

/**
 * Check for and migrate a legacy (pre-workspace) session to the 'self' workspace.
 * This should be called once on startup to preserve user's existing session.
 * @returns {Promise<boolean>} - True if migration occurred
 */
export async function migrateLegacySession() {
  try {
    let legacyPayload = null;
    let source = null;

    // Check for legacy session
    if (isNode) {
      const { readFileSync, existsSync } = await import('node:fs');
      if (existsSync(LEGACY_NODE_PATH)) {
        const data = readFileSync(LEGACY_NODE_PATH, 'utf-8');
        legacyPayload = JSON.parse(data);
        source = LEGACY_NODE_PATH;
      }
    } else if (isBrowser && typeof localStorage !== 'undefined') {
      const data = localStorage.getItem(LEGACY_BROWSER_KEY);
      if (data) {
        legacyPayload = JSON.parse(data);
        source = LEGACY_BROWSER_KEY;
      }
    }

    if (!legacyPayload || legacyPayload.version !== 1) {
      return false; // No legacy session or wrong version
    }

    // Check if 'self' workspace already exists
    const selfExists = await hasSession(getSelfWorkspaceId());
    if (selfExists) {
      console.log('[Session] Legacy session found but self workspace exists; skipping migration');
      return false;
    }

    // Migrate to 'self' workspace
    const selfId = getSelfWorkspaceId();
    const migratedPayload = {
      version: SESSION_VERSION,
      timestamp: new Date().toISOString(),
      workspaceId: selfId,
      state: legacyPayload.state,
      vfs: legacyPayload.vfs || {},
    };

    // Save to new location
    if (isNode) {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      const newPath = await getNodeSessionPath(selfId);

      mkdirSync(dirname(newPath), { recursive: true });
      writeFileSync(newPath, JSON.stringify(migratedPayload, null, 2), 'utf-8');

      // Remove legacy file
      const { unlinkSync } = await import('node:fs');
      unlinkSync(LEGACY_NODE_PATH);
    } else if (isBrowser && typeof localStorage !== 'undefined') {
      localStorage.setItem(getBrowserKey(selfId), JSON.stringify(migratedPayload));
      localStorage.removeItem(LEGACY_BROWSER_KEY);
    }

    console.log('[Session] Migrated legacy session to self workspace');
    return true;
  } catch (error) {
    console.error('[Session] Migration failed:', error.message);
    return false;
  }
}

/**
 * Get the age of the saved session for a workspace.
 * @param {string} workspaceId - Workspace ID
 * @returns {Promise<number | null>} - Age in ms, or null if no session
 */
export async function getSessionAge(workspaceId) {
  const session = await loadSession(workspaceId);
  if (!session?.timestamp) return null;

  const savedTime = new Date(session.timestamp).getTime();
  return Date.now() - savedTime;
}
