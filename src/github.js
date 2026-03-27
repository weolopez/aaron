/**
 * github.js — Isomorphic GitHub Contents API client
 *
 * Pure fetch, zero dependencies. Works in both browser and Node 18+.
 * Token is injected at creation time and never exposed to agent code.
 *
 * Exports: createGitHubClient, initFromGitHub, commitToGitHub, parseGitHubRepo
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
    const res = await fetchFn(`${API}${path}`, opts);  // uses injected or default API base

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
      if (data === null) return null; // 404 — repo or ref not found
      if (!data.tree) return [];
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
      const encodedPath = path.split('/').map(encodeURIComponent).join('/');
      const data = await request('GET', `/repos/${owner}/${repo}/contents/${encodedPath}${query}`);
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
      const encodedPath = path.split('/').map(encodeURIComponent).join('/');
      const data = await request('PUT', `/repos/${owner}/${repo}/contents/${encodedPath}`, body);
      return { sha: data?.content?.sha ?? null };
    },

    /**
     * Delete a file.
     * @param {string} sha — required SHA of the file to delete
     */
    async deleteFile(owner, repo, path, sha, message, branch) {
      const body = { message, sha };
      if (branch) body.branch = branch;
      const encodedPath = path.split('/').map(encodeURIComponent).join('/');
      await request('DELETE', `/repos/${owner}/${repo}/contents/${encodedPath}`, body);
    },

    /**
     * Get a branch ref. Returns { sha } or null.
     */
    async getBranch(owner, repo, branch) {
      const encodedBranch = branch.split('/').map(encodeURIComponent).join('/');
      const data = await request('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodedBranch}`);
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

    /**
     * Create a pull request.
     * @returns {{ number, html_url, title }} or throws
     */
    async createPR(owner, repo, { title, body, head, base = 'main' }) {
      const data = await request('POST', `/repos/${owner}/${repo}/pulls`, {
        title, body, head, base,
      });
      if (!data) {
        throw new Error(`Failed to create PR (404): head=${head}, base=${base} — branch may not exist or token lacks permissions`);
      }
      return { number: data.number, html_url: data.html_url, title: data.title };
    },

    /**
     * List open pull requests.
     * @returns {Array<{ number, title, head, base, html_url }>}
     */
    async listPRs(owner, repo, state = 'open') {
      const data = await request('GET', `/repos/${owner}/${repo}/pulls?state=${state}&per_page=30`);
      if (!data) return [];
      return data.map(pr => ({
        number: pr.number,
        title: pr.title,
        head: pr.head.ref,
        base: pr.base.ref,
        html_url: pr.html_url,
        state: pr.state,
        mergeable: pr.mergeable,
      }));
    },

    /**
     * Merge a pull request.
     * @returns {{ sha, merged }} or throws
     */
    async mergePR(owner, repo, prNumber, { merge_method = 'merge', commit_title } = {}) {
      const body = { merge_method };
      if (commit_title) body.commit_title = commit_title;
      const data = await request('PUT', `/repos/${owner}/${repo}/pulls/${prNumber}/merge`, body);
      return { sha: data.sha, merged: data.merged };
    },

    /**
     * Get a single pull request by number.
     * @returns {{ number, title, state, mergeable, head, base, html_url }}
     */
    async getPR(owner, repo, prNumber) {
      const data = await request('GET', `/repos/${owner}/${repo}/pulls/${prNumber}`);
      if (!data) return null;
      return {
        number: data.number,
        title: data.title,
        state: data.state,
        mergeable: data.mergeable,
        head: data.head.ref,
        base: data.base.ref,
        html_url: data.html_url,
        body: data.body,
      };
    },

    /**
     * Delete a branch.
     */
    async deleteBranch(owner, repo, branchName) {
      const encodedBranch = branchName.split('/').map(encodeURIComponent).join('/');
      await request('DELETE', `/repos/${owner}/${repo}/git/refs/heads/${encodedBranch}`);
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
  if (tree === null) {
    emit?.({ type: 'progress', message: `Repository not found or not accessible: ${owner}/${repo}@${ref}` });
    return { files: 0, skipped: 0 };
  }
  if (!tree.length) {
    emit?.({ type: 'progress', message: 'Repository is empty (no files).' });
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

  // ════════════════════════════════════════════════════
  // .aaron/ Discovery (ADR.md Decision 15)
  // ════════════════════════════════════════════════════

  const aaronFiles = tree.filter(f => f.path.startsWith('.aaron/'));
  if (aaronFiles.length > 0) {
    emit?.({ type: 'progress', message: `Found ${aaronFiles.length} .aaron/ file(s), mounting...` });

    let aaronMounted = 0;
    for (const f of aaronFiles) {
      try {
        const result = await client.getFile(owner, repo, f.path, ref);
        if (!result) continue;

        const relPath = f.path.slice('.aaron/'.length); // Remove .aaron/ prefix

        if (relPath.startsWith('skills/')) {
          // Mount project skills to /project-skills/
          const destPath = '/project-skills/' + relPath.slice('skills/'.length);
          vfs.write(destPath, result.content);
          vfs.setSHA(destPath, result.sha);
          vfs.markClean(destPath);
          aaronMounted++;
        } else if (relPath.startsWith('workflows/')) {
          // Mount project workflows to /project-workflows/
          const destPath = '/project-workflows/' + relPath.slice('workflows/'.length);
          vfs.write(destPath, result.content);
          vfs.setSHA(destPath, result.sha);
          vfs.markClean(destPath);
          aaronMounted++;
        } else if (relPath.startsWith('memory/')) {
          // Merge project memory into /memory/
          const destPath = '/memory/' + relPath.slice('memory/'.length);
          vfs.write(destPath, result.content);
          vfs.setSHA(destPath, result.sha);
          vfs.markClean(destPath);
          aaronMounted++;
        }
        // config.json and other files stay in /src/.aaron/ for direct access
      } catch (e) {
        emit?.({ type: 'progress', message: `Warning: failed to mount .aaron/${f.path}: ${e.message}` });
      }
    }

    emit?.({ type: 'progress', message: `Mounted ${aaronMounted} .aaron/ file(s)` });
  }

  return { files: count, skipped, aaronFiles: aaronFiles.length };
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

// ════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════

/**
 * Parse a GitHub repo string like "owner/repo" or "owner/repo@ref".
 * @param {string} repoStr
 * @returns {{owner: string, repo: string, ref: string} | null}
 */
export function parseGitHubRepo(repoStr) {
  if (!repoStr) return null;
  const [ownerRepo, ref] = repoStr.split('@');
  const [owner, repo] = ownerRepo.split('/');
  if (!owner || !repo) return null;
  return { owner, repo, ref: ref || 'main' };
}
