/**
 * test-github.mjs — Tests for github.js
 *
 * Tests the GitHub client, VFS hydration, and commit logic
 * using mock HTTP responses (no real API calls).
 */

import { createVFS } from '../src/core/agent-core.js';
import { createGitHubClient, initFromGitHub, commitToGitHub } from '../src/runtime/github.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL: ${msg}`);
  }
}

// ════════════════════════════════════════════════════
// MOCK FETCH
// ════════════════════════════════════════════════════

function createMockFetch(handlers) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    for (const h of handlers) {
      if (h.method === method && url.includes(h.pattern)) {
        const body = h.body;
        const status = h.status || 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          statusText: status === 200 ? 'OK' : 'Error',
          headers: new Map([['x-ratelimit-remaining', '50']]),
          json: async () => (typeof body === 'function' ? body(url, opts) : body),
        };
      }
    }
    return { ok: false, status: 404, statusText: 'Not Found', headers: new Map(), json: async () => ({}) };
  };
}

// ════════════════════════════════════════════════════
// TEST: createGitHubClient
// ════════════════════════════════════════════════════

console.log('\ncreateGitHubClient:');

{
  // Test getTree
  const mockFetch = createMockFetch([{
    method: 'GET',
    pattern: '/git/trees/main',
    body: {
      sha: 'abc123',
      tree: [
        { path: 'src/index.js', sha: 'sha1', size: 100, type: 'blob' },
        { path: 'src', sha: 'sha2', size: 0, type: 'tree' },
        { path: 'README.md', sha: 'sha3', size: 50, type: 'blob' },
      ],
    },
  }]);

  const client = createGitHubClient({ token: 'test-token', fetch: mockFetch });
  const tree = await client.getTree('owner', 'repo', 'main');

  assert(tree.length === 2, 'getTree filters to blobs only');
  assert(tree[0].path === 'src/index.js', 'getTree returns file paths');
  assert(tree[0].sha === 'sha1', 'getTree returns SHAs');
  assert(tree[1].path === 'README.md', 'getTree returns second file');
}

{
  // Test getFile
  const content = Buffer.from('console.log("hello");', 'utf8').toString('base64');
  const mockFetch = createMockFetch([{
    method: 'GET',
    pattern: '/contents/',
    body: { content: content + '\n', sha: 'file-sha' },
  }]);

  const client = createGitHubClient({ token: 'test-token', fetch: mockFetch });
  const result = await client.getFile('owner', 'repo', 'src/index.js', 'main');

  assert(result !== null, 'getFile returns result');
  assert(result.content === 'console.log("hello");', 'getFile decodes base64 content');
  assert(result.sha === 'file-sha', 'getFile returns SHA');
}

{
  // Test getFile 404
  const mockFetch = createMockFetch([{
    method: 'GET',
    pattern: '/contents/',
    status: 404,
    body: { message: 'Not Found' },
  }]);

  const client = createGitHubClient({ token: 'test-token', fetch: mockFetch });
  const result = await client.getFile('owner', 'repo', 'nonexistent.js');

  assert(result === null, 'getFile returns null for 404');
}

{
  // Test putFile
  const mockFetch = createMockFetch([{
    method: 'PUT',
    pattern: '/contents/',
    body: { content: { sha: 'new-sha' } },
  }]);

  const client = createGitHubClient({ token: 'test-token', fetch: mockFetch });
  const result = await client.putFile('owner', 'repo', 'src/index.js', 'new content', 'old-sha', 'update file');

  assert(result.sha === 'new-sha', 'putFile returns new SHA');
}

{
  // Test putFile 409 conflict
  const mockFetch = createMockFetch([{
    method: 'PUT',
    pattern: '/contents/',
    status: 409,
    body: { message: 'conflict' },
  }]);

  const client = createGitHubClient({ token: 'test-token', fetch: mockFetch });
  let caught = false;
  try {
    await client.putFile('owner', 'repo', 'src/index.js', 'content', 'stale-sha', 'update');
  } catch (e) {
    caught = true;
    assert(e.status === 409, 'putFile throws 409 with status');
  }
  assert(caught, 'putFile throws on 409 conflict');
}

{
  // Test getBranch
  const mockFetch = createMockFetch([{
    method: 'GET',
    pattern: '/git/ref/heads/main',
    body: { object: { sha: 'branch-sha' } },
  }]);

  const client = createGitHubClient({ token: 'test-token', fetch: mockFetch });
  const result = await client.getBranch('owner', 'repo', 'main');

  assert(result !== null, 'getBranch returns result');
  assert(result.sha === 'branch-sha', 'getBranch returns SHA');
}

{
  // Test getBranch 404
  const mockFetch = createMockFetch([{
    method: 'GET',
    pattern: '/git/ref/heads/nonexistent',
    status: 404,
    body: {},
  }]);

  const client = createGitHubClient({ token: 'test-token', fetch: mockFetch });
  const result = await client.getBranch('owner', 'repo', 'nonexistent');

  assert(result === null, 'getBranch returns null for 404');
}

// ════════════════════════════════════════════════════
// TEST: initFromGitHub
// ════════════════════════════════════════════════════

console.log('\ninitFromGitHub:');

{
  const fileContents = {
    'src/main.js': 'const x = 1;',
    'src/utils.js': 'function util() {}',
    'README.md': '# Hello',
  };

  const mockFetch = createMockFetch([
    {
      method: 'GET',
      pattern: '/git/trees/main',
      body: {
        tree: Object.entries(fileContents).map(([path, content]) => ({
          path, sha: 'sha-' + path, size: content.length, type: 'blob',
        })),
      },
    },
    {
      method: 'GET',
      pattern: '/contents/',
      body: (url) => {
        // Extract path from URL — match per-segment encoded or full-encoded paths
        for (const [path, content] of Object.entries(fileContents)) {
          const perSegment = path.split('/').map(encodeURIComponent).join('/');
          if (url.includes(perSegment) || url.includes(encodeURIComponent(path))) {
            return {
              content: Buffer.from(content).toString('base64'),
              sha: 'sha-' + path,
            };
          }
        }
        return { content: Buffer.from('').toString('base64'), sha: 'unknown' };
      },
    },
  ]);

  const client = createGitHubClient({ token: 'test', fetch: mockFetch });
  const vfs = createVFS();
  const events = [];
  const result = await initFromGitHub(
    { owner: 'test', repo: 'repo', ref: 'main' },
    vfs, client, (ev) => events.push(ev),
  );

  assert(result.files === 3, 'initFromGitHub hydrates all files');
  assert(vfs.read('/src/src/main.js') === 'const x = 1;', 'initFromGitHub maps to /src/ prefix');
  assert(!vfs.isDirty('/src/src/main.js'), 'initFromGitHub marks files clean');
  assert(events.length > 0, 'initFromGitHub emits progress events');
}

{
  // Test include/exclude filters
  const mockFetch = createMockFetch([
    {
      method: 'GET',
      pattern: '/git/trees/main',
      body: {
        tree: [
          { path: 'src/app.js', sha: 's1', size: 10, type: 'blob' },
          { path: 'node_modules/pkg/index.js', sha: 's2', size: 10, type: 'blob' },
          { path: 'docs/README.md', sha: 's3', size: 10, type: 'blob' },
        ],
      },
    },
    {
      method: 'GET',
      pattern: '/contents/',
      body: { content: Buffer.from('content').toString('base64'), sha: 'sha' },
    },
  ]);

  const client = createGitHubClient({ token: 'test', fetch: mockFetch });
  const vfs = createVFS();
  await initFromGitHub(
    { owner: 'test', repo: 'repo', ref: 'main', include: ['src/'], exclude: ['node_modules/'] },
    vfs, client,
  );

  const files = vfs.list().filter(p => p.startsWith('/src/'));
  assert(files.length === 1, 'initFromGitHub respects include filter');
  assert(files[0] === '/src/src/app.js', 'initFromGitHub includes matching files');
}

// ════════════════════════════════════════════════════
// TEST: commitToGitHub
// ════════════════════════════════════════════════════

console.log('\ncommitToGitHub:');

{
  const putCalls = [];
  const mockFetch = createMockFetch([{
    method: 'PUT',
    pattern: '/contents/',
    body: (url, opts) => {
      putCalls.push({ url, body: JSON.parse(opts.body) });
      return { content: { sha: 'new-sha-' + putCalls.length } };
    },
  }]);

  const client = createGitHubClient({ token: 'test', fetch: mockFetch });
  const vfs = createVFS();

  // Write some files
  vfs.write('/src/main.js', 'updated content');
  vfs.setSHA('/src/main.js', 'old-sha');
  vfs.write('/src/utils.js', 'new util');
  // Don't set SHA for utils.js — it's a new file
  vfs.write('/artifacts/output.md', 'should not push'); // not under /src/

  const events = [];
  const result = await commitToGitHub(vfs, client, {
    owner: 'test', repo: 'repo', branch: 'main',
    message: 'test commit', pathPrefix: '/src/',
  }, (ev) => events.push(ev));

  assert(result.pushed.length === 2, 'commitToGitHub pushes dirty /src/ files');
  assert(result.conflicts.length === 0, 'commitToGitHub has no conflicts');
  assert(putCalls.length === 2, 'commitToGitHub makes 2 PUT calls');
  assert(putCalls[0].body.sha === 'old-sha', 'commitToGitHub sends existing SHA for updates');
  assert(!putCalls[1].body.sha, 'commitToGitHub omits SHA for new files');
  assert(!vfs.isDirty('/src/main.js'), 'commitToGitHub marks files clean');
}

// ════════════════════════════════════════════════════
// TEST: VFS setSHA
// ════════════════════════════════════════════════════

console.log('\nVFS.setSHA:');

{
  const vfs = createVFS();
  vfs.write('/test.js', 'content');
  assert(vfs.isDirty('/test.js'), 'write marks dirty');

  vfs.setSHA('/test.js', 'abc123');
  // setSHA should NOT change dirty status
  assert(vfs.isDirty('/test.js'), 'setSHA does not clear dirty');

  const snap = vfs.snapshot('/test.js');
  assert(snap['/test.js'].sha === 'abc123', 'setSHA updates SHA in snapshot');
}

// ════════════════════════════════════════════════════
// TEST: Auth header
// ════════════════════════════════════════════════════

console.log('\nAuth header:');

{
  let capturedHeaders = null;
  const mockFetch = async (url, opts) => {
    capturedHeaders = opts.headers;
    return {
      ok: true, status: 200,
      headers: new Map([['x-ratelimit-remaining', '100']]),
      json: async () => ({ tree: [] }),
    };
  };

  const client = createGitHubClient({ token: 'my-secret-token', fetch: mockFetch });
  await client.getTree('owner', 'repo', 'main');

  assert(capturedHeaders['Authorization'] === 'Bearer my-secret-token', 'Authorization header is set correctly');
  assert(capturedHeaders['X-GitHub-Api-Version'] === '2022-11-28', 'API version header is set');
}

// ════════════════════════════════════════════════════
// RESULTS
// ════════════════════════════════════════════════════

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('All tests passed\n');
