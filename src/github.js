/**
 * github.js — Isomorphic GitHub Contents API client
 *
 * Pure fetch, zero dependencies. Works in both browser and Node 18+.
 * Token is injected at creation time and never exposed to agent code.
 *
 * Exports: createGitHubClient, initFromGitHub, commitToGitHub
 */

// ════════════════════════════════════════════════════
// CLIENT
// ════════════════════════════════════════════════════

const API = 'https://api.github.com';

/**
 * Create a GitHub API client.
 * @param {{ token: string, fetch?: typeof globalThis.fetch }} opts
 */
export function createGitHubClient({ token, fetch: fetchFn = fetch }) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  async function request(method, path, body) {
    const opts = { method, headers: { ...headers } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetchFn(`${API}${path}`, opts);

    // Rate limit warning
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining !== null && parseInt(remaining) < 10) {
      const reset = res.headers.get('x-ratelimit-reset');
      const resetAt = reset ? new Date(parseInt(reset) * 1000).toISOString() : 'unknown';
      console.warn(`GitHub rate limit low: ${remaining} remaining, resets ${resetAt}`);
    }

    if (res.status === 404) return null;
    if (res.status === 409) {
      const err = new Error('SHA conflict — file was modified externally');
      err.status = 409;
      throw err;
    }
    if (res.status === 422) {
      const data = await res.json().catch(() => ({}));
      const err = new Error(data.message || 'Validation failed');
      err.status = 422;
      throw err;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(`GitHub API ${res.status}: ${data.message || res.statusText}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  return {
    /**
     * Get the recursive tree for a ref.
     * Returns [{ path, sha, size, type }] — only blobs (files).
     */
    async getTree(owner, repo, ref = 'main') {
      const data = await request('GET', `/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`);
      if (!data || !data.tree) return [];
      return data.tree
        .filter(n => n.type === 'blob')
        .map(n => ({ path: n.path, sha: n.sha, size: n.size }));
    },

    /**
     * Get a single file's content and SHA.
     * Returns { content, sha } or null if not found.
     */
    async getFile(owner, repo, path, ref) {
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const data = await request('GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`);
      if (!data) return null;
      // Content is base64 encoded
      const content = typeof atob === 'function'
        ? atob(data.content.replace(/\n/g, ''))
        : Buffer.from(data.content, 'base64').toString('utf8');
      return { content, sha: data.sha };
    },

    /**
     * Create or update a file.
     * @param {string|null} sha — null for new files, existing SHA for updates
     * Returns { sha } of the new version.
     */
    async putFile(owner, repo, path, content, sha, message, branch) {
      const body = {
        message,
        content: typeof btoa === 'function'
          ? btoa(unescape(encodeURIComponent(content)))
          : Buffer.from(content, 'utf8').toString('base64'),
      };
      if (sha) body.sha = sha;
      if (branch) body.branch = branch;
      const data = await request('PUT', `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, body);
      return { sha: data.content.sha };
    },

    /**
     * Delete a file.
     * @param {string} sha — required SHA of the file to delete
     */
    async deleteFile(owner, repo, path, sha, message, branch) {
      const body = { message, sha };
      if (branch) body.branch = branch;
      await request('DELETE', `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, body);
    },

    /**
     * Get a branch ref. Returns { sha } or null.
     */
    async getBranch(owner, repo, branch) {
      const data = await request('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      if (!data) return null;
      return { sha: data.object.sha };
    },

    /**
     * Create a branch from a ref SHA.
     */
    async createBranch(owner, repo, branchName, fromSha) {
      await request('POST', `/repos/${owner}/${repo}/git/refs`, {
        ref: `refs/heads/${branchName}`,
        sha: fromSha,
      });
    },
  };
}

// ════════════════════════════════════════════════════
// VFS HYDRATION FROM GITHUB
// ════════════════════════════════════════════════════

/**
 * Hydrate VFS from a GitHub repo.
 *
 * @param {{ owner, repo, ref, include?, exclude? }} config
 * @param {object} vfs — VFS instance (from createVFS)
 * @param {object} client — GitHub client (from createGitHubClient)
 * @param {function} [emit] — optional emit function for progress
 * @returns {{ files: number, skipped: number }}
 */
export async function initFromGitHub(config, vfs, client, emit) {
  const { owner, repo, ref = 'main', include, exclude } = config;
  emit?.({ type: 'progress', message: `Fetching tree from ${owner}/${repo}@${ref}...` });

  const tree = await client.getTree(owner, repo, ref);
  if (!tree.length) {
    emit?.({ type: 'progress', message: 'Repository is empty or not found.' });
    return { files: 0, skipped: 0 };
  }

  // Filter files by include/exclude patterns
  const filtered = tree.filter(f => {
    if (exclude) {
      for (const pat of exclude) {
        if (f.path.startsWith(pat) || f.path === pat) return false;
      }
    }
    if (include) {
      for (const pat of include) {
        if (f.path.startsWith(pat) || f.path === pat) return true;
      }
      return false; // include specified but no match
    }
    return true;
  });

  // Skip large or binary files
  const MAX_FILE_SIZE = 1_000_000; // 1MB
  const fetchable = filtered.filter(f => f.size <= MAX_FILE_SIZE);
  const skipped = filtered.length - fetchable.length;

  emit?.({ type: 'progress', message: `Fetching ${fetchable.length} files (${skipped} skipped)...` });

  let count = 0;
  for (const f of fetchable) {
    try {
      const result = await client.getFile(owner, repo, f.path, ref);
      if (result) {
        const vfsPath = '/src/' + f.path;
        vfs.write(vfsPath, result.content);
        vfs.setSHA(vfsPath, result.sha);
        vfs.markClean(vfsPath);
        count++;
      }
    } catch (e) {
      emit?.({ type: 'progress', message: `Warning: failed to fetch ${f.path}: ${e.message}` });
    }

    // Progress every 20 files
    if (count > 0 && count % 20 === 0) {
      emit?.({ type: 'progress', message: `Fetched ${count}/${fetchable.length} files...` });
    }
  }

  emit?.({ type: 'progress', message: `Hydrated ${count} files from ${owner}/${repo}@${ref}` });
  return { files: count, skipped };
}

// ════════════════════════════════════════════════════
// COMMIT TO GITHUB
// ════════════════════════════════════════════════════

/**
 * Commit dirty VFS files to GitHub.
 *
 * @param {object} vfs
 * @param {object} client
 * @param {{ owner, repo, branch, message, pathPrefix? }} config
 * @param {function} [emit]
 * @returns {{ pushed: string[], conflicts: string[] }}
 */
export async function commitToGitHub(vfs, client, config, emit) {
  const { owner, repo, branch = 'main', message = 'Update from Aaron', pathPrefix = '/src/' } = config;

  const dirty = vfs.list().filter(p => vfs.isDirty(p) && p.startsWith(pathPrefix));
  if (dirty.length === 0) {
    emit?.({ type: 'progress', message: 'No dirty files to push.' });
    return { pushed: [], conflicts: [] };
  }

  emit?.({ type: 'progress', message: `Pushing ${dirty.length} file(s) to ${owner}/${repo}@${branch}...` });

  const pushed = [];
  const conflicts = [];

  for (const vfsPath of dirty) {
    const content = vfs.read(vfsPath);
    if (content === null) continue;

    // Map VFS path to repo path (strip the prefix)
    const repoPath = vfsPath.slice(pathPrefix.length);
    const entry = vfs.snapshot(vfsPath)[vfsPath];
    const sha = entry?.sha ?? null;

    try {
      const result = await client.putFile(owner, repo, repoPath, content, sha, message, branch);
      vfs.setSHA(vfsPath, result.sha);
      vfs.markClean(vfsPath);
      pushed.push(vfsPath);
      emit?.({ type: 'file_write', path: vfsPath });
    } catch (e) {
      if (e.status === 409) {
        conflicts.push(vfsPath);
        emit?.({ type: 'progress', message: `Conflict: ${vfsPath} was modified externally` });
      } else {
        emit?.({ type: 'progress', message: `Failed to push ${vfsPath}: ${e.message}` });
      }
    }
  }

  emit?.({ type: 'progress', message: `Pushed ${pushed.length} file(s)${conflicts.length ? `, ${conflicts.length} conflict(s)` : ''}` });
  return { pushed, conflicts };
}
