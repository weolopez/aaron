---
name: refactor
description: Restructure code without changing external behavior — extract, rename, split, move
---

# refactor

**Core discipline:** Change structure. Never change behavior. Prove the contract is unchanged after every transform.

## Safe transforms (choose one per refactoring turn)

| Transform | What changes | What must NOT change |
|-----------|-------------|----------------------|
| Extract function | A block of code becomes a named function | Return value, side effects |
| Inline variable | A single-use variable replaced by its value | Readability, behavior |
| Rename symbol | Name of a function/variable/file | All call sites updated consistently |
| Split file | One file becomes two or more modules | All exports still reachable from original path |
| Move to module | Code relocated to a different file | Import paths updated everywhere |
| Extract constant | Magic literal becomes a named constant | Same value used everywhere |

## Steps

### 1. Read the file and identify the target

```js
const filePath = '/src/path/to/file.js';
const source = context.vfs.read(filePath);
if (!source) {
  context.emit({ type: 'blocked', reason: `${filePath} not found` });
  return;
}
context.emit({ type: 'file_read', path: filePath });

// Capture current public surface before touching anything
const exportsBefore = (source.match(/^export\s+/gm) ?? []).length;
context.emit({ type: 'progress', message: `${exportsBefore} exports before refactor` });
```

### 2. Apply exactly ONE transform

Do not combine transforms in one turn. One change, fully applied, fully verified.

```js
// Example: extract a function
const refactored = source
  // Remove the inline block
  .replace(/\/\/ <target block start>[\s\S]*?\/\/ <target block end>/,
    'return extractedFn(args);')
  // This is illustrative — always do the real substitution carefully
  ;

// Prepend the new function above the call site
const withExtracted = 'function extractedFn(args) {\n  // extracted body\n}\n\n' + refactored;
```

### 3. Verify the contract is unchanged

```js
const exportsAfter = (withExtracted.match(/^export\s+/gm) ?? []).length;

if (exportsAfter !== exportsBefore) {
  context.emit({ type: 'blocked',
    reason: `Export count changed: ${exportsBefore} → ${exportsAfter}. Aborting.` });
  return;
}

// Check all existing export names are still present
const exportNamesBefore = [...source.matchAll(/^export\s+(?:function|const|class|async function)\s+(\w+)/gm)]
  .map(m => m[1]);
for (const name of exportNamesBefore) {
  if (!withExtracted.includes(name)) {
    context.emit({ type: 'blocked', reason: `Export "${name}" missing after refactor. Aborting.` });
    return;
  }
}
```

### 4. Write and report

```js
context.vfs.write(filePath, withExtracted);
context.emit({ type: 'file_write', path: filePath });

context.emit({ type: 'result', value: {
  transform: 'extract-function',
  file: filePath,
  exports_before: exportsBefore,
  exports_after: exportsAfter,
  contract_preserved: true,
}});
context.emit({ type: 'done', message: `Refactor complete: extracted function in ${filePath}` });
```

## What NOT to do

- Do not rename a public API or exported function name (that's a breaking change)
- Do not add new logic while restructuring — pure structural move only
- Do not split a file without updating every import in the codebase
- Do not do more than one transform type per turn
- Do not emit `done` if the export contract changed

## Checking call sites when renaming or moving

```js
// Find all files that import the symbol being changed
const allFiles = context.vfs.list().filter(p => p.startsWith('/src/') && p.endsWith('.js'));
const affected = allFiles.filter(p => {
  const content = context.vfs.read(p);
  return content && content.includes('oldName');
});
context.emit({ type: 'progress', message: `${affected.length} files import 'oldName'` });

// Update each one
for (const p of affected) {
  const updated = context.vfs.read(p).replaceAll('oldName', 'newName');
  context.vfs.write(p, updated);
  context.emit({ type: 'file_write', path: p });
}
```
