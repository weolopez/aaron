/**
 * agent-core.js — Invariant core
 *
 * NEVER modified by RSI. These primitives are the foundation
 * that everything else builds on. See ADR.md Decision 11.
 *
 * Exports: createVFS, execute, extractCode
 */

// ════════════════════════════════════════════════════
// VFS
// ════════════════════════════════════════════════════

export function createVFS() {
  const files = new Map();
  const encoder = new TextEncoder();
  return {
    read(path) {
      return files.get(path)?.content ?? null;
    },
    write(path, content) {
      const existing = files.get(path);
      files.set(path, {
        content,
        sha: existing?.sha ?? null,
        dirty: true,
        updatedAt: Date.now(),
      });
    },
    list() {
      return [...files.keys()].sort();
    },
    isDirty(path) {
      return !!files.get(path)?.dirty;
    },
    size(path) {
      const f = files.get(path);
      return f ? encoder.encode(f.content).byteLength : 0;
    },
    dump() {
      return Object.fromEntries(
        [...files.entries()].map(([k, v]) => [k, v.content])
      );
    },
    markClean(path) {
      const f = files.get(path);
      if (f) f.dirty = false;
    },
    setSHA(path, sha) {
      const f = files.get(path);
      if (f) f.sha = sha;
    },
    delete(path) {
      return files.delete(path);
    },
    snapshot(prefix) {
      const snap = {};
      for (const [k, v] of files) {
        if (!prefix || k.startsWith(prefix)) {
          snap[k] = { content: v.content, sha: v.sha, dirty: v.dirty };
        }
      }
      return snap;
    },
    restore(snap) {
      for (const k of files.keys()) {
        if (k in snap) continue;
        // delete files that weren't in the snapshot
        if (Object.keys(snap).length > 0) {
          const prefix = Object.keys(snap)[0].split('/').slice(0, 2).join('/') + '/';
          if (k.startsWith(prefix)) files.delete(k);
        }
      }
      for (const [k, v] of Object.entries(snap)) {
        files.set(k, { ...v, updatedAt: Date.now() });
      }
    },
  };
}

// ════════════════════════════════════════════════════
// EXECUTOR
// ════════════════════════════════════════════════════

/**
 * Risky code patterns — checked before AsyncFunction execution.
 * Browser: triggers HITL approval via context.approve().
 * CLI: benign (user already has shell access).
 */
export const RISKY_PATTERNS = [
  // Network & Data Exfiltration
  /\bWebSocket\b/,
  /navigator\.sendBeacon/,

  // State Mutation & Storage
  /document\.cookie/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,

  // High-Privilege APIs & Navigation
  /navigator\.geolocation/,
  /navigator\.mediaDevices/,
  /navigator\.clipboard/,
  /window\.location/,

  // Destructive DOM Manipulation
  /document\.write\s*\(/,
  /\.innerHTML\s*=/,
];

/**
 * Isomorphic code executor with safety checks, console capture,
 * and structured execution metadata.
 *
 * @param {string} code - JS code to execute as AsyncFunction body
 * @param {object} context - agent context (vfs, emit, fetch, etc.)
 * @param {number} [timeoutMs=15000] - execution timeout
 * @returns {{ result: any, stdout: string[], stderr: string[], duration: number, isError: boolean, error?: string, riskyPattern?: RegExp }}
 */
export async function execute(code, context, timeoutMs = 15_000) {
  const start = Date.now();
  const stdout = [];
  const stderr = [];

  // ── HITL: static pattern check ──────────────────────
  const matchedPattern = RISKY_PATTERNS.find(p => p.test(code));
  if (matchedPattern) {
    // context.approve is injected by the host harness:
    //   Browser → window.confirm wrapper
    //   CLI     → auto-approve (or readline prompt)
    const approve = context.approve ?? (() => true);
    const approved = await approve(
      `Agent code matches risky pattern: ${matchedPattern}\n\n${code.slice(0, 250)}${code.length > 250 ? '...' : ''}`
    );
    if (!approved) {
      return {
        result: undefined,
        stdout, stderr,
        duration: Date.now() - start,
        isError: true,
        error: 'Execution denied by user (risky pattern detected).',
        riskyPattern: matchedPattern,
      };
    }
  }

  // ── Console capture ─────────────────────────────────
  const _log = console.log;
  const _err = console.error;
  const _warn = console.warn;
  console.log  = (...a) => { stdout.push(a.map(String).join(' ')); _log(...a); };
  console.error = (...a) => { stderr.push(a.map(String).join(' ')); _err(...a); };
  console.warn  = (...a) => { stderr.push('[warn] ' + a.map(String).join(' ')); _warn(...a); };

  try {
    const Fn = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new Fn('context', code);
    const result = await Promise.race([
      fn(context),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Execution timeout after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);

    const duration = Date.now() - start;
    return {
      result,
      stdout, stderr,
      duration,
      isError: false,
    };
  } catch (err) {
    const duration = Date.now() - start;
    // Re-throw so the existing error-recovery loop in agent-loop.js still works,
    // but attach metadata to the error for callers that want it.
    err.execMeta = {
      stdout, stderr,
      duration,
      isError: true,
      error: err.message,
    };
    throw err;
  } finally {
    console.log = _log;
    console.error = _err;
    console.warn = _warn;
  }
}

// ════════════════════════════════════════════════════
// CODE EXTRACTION
// ════════════════════════════════════════════════════

export function extractCode(data) {
  const text = data.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  // Use greedy match to find the outermost code fence — handles nested ``` inside template literals
  let match = text.match(/```(?:js|javascript)?\n([\s\S]*)```/);
  // Fallback: if response was truncated (no closing fence), extract everything after the opening fence
  if (!match) match = text.match(/```(?:js|javascript)?\n([\s\S]+)/);
  if (!match) {
    throw new Error(
      'No ```js code block in response. Response was:\n\n' +
        text.slice(0, 400),
    );
  }
  return { code: match[1].trim(), fullText: text };
}
