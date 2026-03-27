---
name: init
description: Explore a newly-loaded workspace, map its structure, and write project notes to memory
---

# init

Use when a new repository has just been hydrated into the VFS. Explores the codebase, writes a structured summary to `/memory/project-notes.md`, and recommends which Aaron skills apply.

## Steps

### 1. Map the file tree

```js
context.emit({ type: 'progress', message: 'Mapping workspace...' });

const allFiles = context.vfs.list();
const srcFiles = allFiles.filter(p => p.startsWith('/src/'));
const testFiles = allFiles.filter(p =>
  p.includes('/test') || p.includes('/spec') || p.includes('.test.') || p.includes('.spec.')
);
const docFiles = allFiles.filter(p =>
  p.endsWith('.md') || p.endsWith('.txt') || p.includes('/docs/')
);

context.emit({ type: 'progress', message:
  `Found: ${srcFiles.length} src, ${testFiles.length} test, ${docFiles.length} doc files` });
```

### 2. Read key entry points

```js
// Priority order for understanding a codebase
const entryPointCandidates = [
  '/src/README.md', '/src/CLAUDE.md',
  '/src/package.json', '/src/index.js', '/src/main.js',
  '/src/app.js', '/src/server.js', '/src/cli.js',
];

const found = {};
for (const p of entryPointCandidates) {
  const content = context.vfs.read(p);
  if (content) {
    found[p] = content.slice(0, 500); // first 500 chars
    context.emit({ type: 'file_read', path: p });
  }
}
```

### 3. Detect project type and patterns

```js
const pkg = (() => {
  try { return JSON.parse(context.vfs.read('/src/package.json') ?? '{}'); } catch { return {}; }
})();

const isNode    = !!pkg.main || !!pkg.bin || srcFiles.some(p => p.includes('server'));
const isBrowser = srcFiles.some(p => p.endsWith('.html') || p.includes('public/'));
const hasTests  = testFiles.length > 0;
const hasDocs   = docFiles.some(p => p.endsWith('.md'));
const hasADR    = allFiles.some(p => p.includes('/adr/') || p.includes('ADR'));

const projectType = isNode && isBrowser ? 'fullstack' :
                    isNode ? 'node' :
                    isBrowser ? 'browser' : 'unknown';
```

### 4. Identify key modules

```js
// Find the most-imported files (likely core utilities or interfaces)
const importCounts = {};
for (const p of srcFiles) {
  const content = context.vfs.read(p);
  if (!content) continue;
  const imports = content.matchAll(/from ['"]([^'"]+)['"]/g);
  for (const [, dep] of imports) {
    if (dep.startsWith('.')) {
      importCounts[dep] = (importCounts[dep] ?? 0) + 1;
    }
  }
}
const coreModules = Object.entries(importCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([path, count]) => `${path} (imported ${count}x)`);
```

### 5. Write project notes

```js
const lines = [
  '# Project Notes',
  `Generated: ${new Date().toISOString().split('T')[0]}`,
  '',
  '## Overview',
  `- **Type:** ${projectType}`,
  `- **Name:** ${pkg.name ?? 'unknown'}`,
  `- **Version:** ${pkg.version ?? 'unknown'}`,
  `- **Description:** ${pkg.description ?? 'none'}`,
  '',
  '## File counts',
  `- Source files: ${srcFiles.length}`,
  `- Test files: ${testFiles.length}`,
  `- Documentation: ${docFiles.length}`,
  '',
  '## Key entry points',
  ...Object.keys(found).map(p => `- ${p}`),
  '',
  '## Most-imported modules',
  ...coreModules.map(m => `- ${m}`),
  '',
  '## Gaps identified',
  ...(!hasTests   ? ['- ⚠ No test files found'] : []),
  ...(!hasDocs    ? ['- ⚠ No documentation files'] : []),
  ...(!hasADR     ? ['- ⚠ No ADRs — architectural decisions undocumented'] : []),
  '',
  '## Suggested Aaron skills',
  ...(!hasTests   ? ['- `testing` — write test suite for existing code'] : []),
  ...(!hasDocs    ? ['- `documentation` — generate README and API docs'] : []),
  ...(!hasADR     ? ['- `adr-writer` — document key architectural decisions'] : []),
  '- `code-review` — review existing code for issues',
  '- `code-planner` — plan next feature',
];

context.vfs.write('/memory/project-notes.md', lines.join('\n'));
context.emit({ type: 'file_write', path: '/memory/project-notes.md' });
```

### 6. Emit summary

```js
context.emit({ type: 'result', value: {
  project_type: projectType,
  src_files: srcFiles.length,
  test_files: testFiles.length,
  gaps: { tests: !hasTests, docs: !hasDocs, adr: !hasADR },
}});
context.emit({ type: 'done', message:
  `Workspace mapped: ${srcFiles.length} src files, ${testFiles.length} tests. ` +
  `Notes written to /memory/project-notes.md` });
```

## Notes

- Run this once per new workspace, not on every turn
- If `/memory/project-notes.md` already exists and is recent, skip and emit done immediately
- The notes are used by other skills (`code-planner` reads gaps, `adr-writer` reads existing ADRs)
