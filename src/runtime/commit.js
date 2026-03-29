/**
 * src/commit.js — Isomorphic commit pipeline
 *
 * Shared logic for persisting dirty VFS files: flush to disk (CLI),
 * push to GitHub, mark clean. Used by both harnesses to build the
 * `context.commit()` function.
 */

/**
 * Create a `commit(message, branch?)` function for use in agent context.
 *
 * @param {object}   opts
 * @param {object}   opts.vfs           - VFS instance
 * @param {Function} opts.getGitHub     - () => { client, config } | null
 * @param {Function} opts.commitToGitHub
 * @param {Function} opts.emit          - (event) => void
 * @param {Function} [opts.onFlush]     - (vfs, dirtyPaths) => void — platform hook (CLI: disk write + manifest)
 * @param {string[]} [opts.ghPrefixes]  - VFS prefixes to push (default: ['/src/'])
 * @returns {Function} async (message?, branch?) => string[]
 */
export function createCommitFn({ vfs, getGitHub, commitToGitHub, emit, onFlush, ghPrefixes = ['/src/'] }) {
  return async function commit(message = 'commit', branch) {
    const dirty = vfs.list().filter(p => vfs.isDirty(p));

    // Platform-specific persistence (CLI writes to disk)
    if (onFlush) onFlush(vfs, dirty);

    // Push to GitHub if connected; track which files were successfully pushed
    const gh = getGitHub();
    const cleanable = new Set();

    if (gh) {
      for (const prefix of ghPrefixes) {
        const prefixDirty = dirty.filter(p => p.startsWith(prefix));
        if (prefixDirty.length === 0) continue;
        try {
          await commitToGitHub(vfs, gh.client, {
            owner: gh.config.owner,
            repo: gh.config.repo,
            branch: branch ?? gh.config.ref,
            message,
            pathPrefix: prefix,
          }, emit);
          // Only mark clean if push succeeded
          for (const p of prefixDirty) cleanable.add(p);
        } catch (e) {
          emit({ type: 'progress', message: `GitHub push failed: ${e.message}` });
        }
      }
    }

    // Files not covered by any ghPrefix are local-only — always mark clean
    const coveredByGh = (p) => ghPrefixes.some(pfx => p.startsWith(pfx));
    for (const p of dirty) {
      if (!gh || !coveredByGh(p)) cleanable.add(p);
    }

    for (const p of cleanable) vfs.markClean(p);
    return dirty;
  };
}
