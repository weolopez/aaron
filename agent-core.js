/**
 * agent-core.js — Invariant core
 *
 * NEVER modified by RSI. These primitives are the foundation
 * that everything else builds on. See ADR.md Decision 11.
 *
 * Exports: createVFS, execute, createLLMClient, extractCode
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

export async function execute(code, context, timeoutMs = 15_000) {
  const Fn = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new Fn('context', code);
  return await Promise.race([
    fn(context),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Execution timeout after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
}

// ════════════════════════════════════════════════════
// LLM CLIENT
// ════════════════════════════════════════════════════

export function createLLMClient({
  model,
  apiUrl = 'https://api.anthropic.com/v1/messages',
  headers = {},
}) {
  return {
    model,
    async call(messages, system) {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ model, max_tokens: 16384, system, messages }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message ?? `LLM API error ${res.status}`);
      }
      return res.json();
    },
  };
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
