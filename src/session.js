/**
 * session.js — Session persistence for agent state and VFS
 *
 * Saves/restores conversation history and VFS contents.
 * Works in both Node.js (CLI) and browser environments.
 */

// ════════════════════════════════════════════════════
// Environment Detection
// ════════════════════════════════════════════════════

const isNode = typeof process !== 'undefined' && process.versions?.node;
const isBrowser = typeof window !== 'undefined';

// ════════════════════════════════════════════════════
// Storage Paths
// ════════════════════════════════════════════════════

const BROWSER_KEY = 'aaron-session';
const NODE_SESSION_PATH = isNode
  ? (await import('node:path')).join(
      (await import('node:os')).homedir(),
      '.aaron_session.json'
    )
  : null;

// ════════════════════════════════════════════════════
// Save Session
// ════════════════════════════════════════════════════

/**
 * Save agent state and VFS contents to persistent storage.
 * @param {Object} state - Agent state (history, turn count, etc.)
 * @param {Object} vfs - VFS instance with dump() method
 * @returns {Promise<boolean>} - Success status
 */
export async function saveSession(state, vfs) {
  const payload = {
    version: 1,
    timestamp: new Date().toISOString(),
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
      
      // Ensure directory exists
      const dir = dirname(NODE_SESSION_PATH);
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // Directory may already exist
      }
      
      writeFileSync(NODE_SESSION_PATH, JSON.stringify(payload, null, 2), 'utf-8');
    } else if (isBrowser && typeof localStorage !== 'undefined') {
      localStorage.setItem(BROWSER_KEY, JSON.stringify(payload));
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
// Load Session
// ════════════════════════════════════════════════════

/**
 * Load saved session from persistent storage.
 * @returns {Promise<{state: Object, vfs: Object} | null>} - Session data or null
 */
export async function loadSession() {
  try {
    let payload;
    
    if (isNode) {
      const { readFileSync } = await import('node:fs');
      const data = readFileSync(NODE_SESSION_PATH, 'utf-8');
      payload = JSON.parse(data);
    } else if (isBrowser && typeof localStorage !== 'undefined') {
      const data = localStorage.getItem(BROWSER_KEY);
      if (!data) return null;
      payload = JSON.parse(data);
    } else {
      return null;
    }

    // Validate version
    if (payload.version !== 1) {
      console.warn('[Session] Incompatible version:', payload.version);
      return null;
    }

    return {
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
// Clear Session
// ════════════════════════════════════════════════════

/**
 * Clear the saved session from persistent storage.
 * @returns {Promise<boolean>} - Success status
 */
export async function clearSession() {
  try {
    if (isNode) {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(NODE_SESSION_PATH);
    } else if (isBrowser && typeof localStorage !== 'undefined') {
      localStorage.removeItem(BROWSER_KEY);
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
// Check Session Exists
// ════════════════════════════════════════════════════

/**
 * Check if a saved session exists.
 * @returns {Promise<boolean>}
 */
export async function hasSession() {
  try {
    if (isNode) {
      const { existsSync } = await import('node:fs');
      return existsSync(NODE_SESSION_PATH);
    } else if (isBrowser && typeof localStorage !== 'undefined') {
      return localStorage.getItem(BROWSER_KEY) !== null;
    }
    return false;
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════
// Get Session Age
// ════════════════════════════════════════════════════

/**
 * Get the age of the saved session in milliseconds.
 * @returns {Promise<number | null>} - Age in ms, or null if no session
 */
export async function getSessionAge() {
  const session = await loadSession();
  if (!session?.timestamp) return null;
  
  const savedTime = new Date(session.timestamp).getTime();
  return Date.now() - savedTime;
}
