---
name: bug-fixer
description: Diagnose a bug, identify root cause, implement a targeted fix, and verify it
---

# bug-fixer

Systematically diagnose and fix a reported bug without introducing regressions.

## Steps

### 1. Reproduce the bug (in your head / via analysis)

```js
context.emit({ type: 'progress', message: 'Step 1: Understanding the bug...' });

// Read the relevant source files
const buggyFile = context.vfs.read('/src/path/to/file.js');
if (!buggyFile) {
  context.emit({ type: 'done', message: 'Error: file not found in VFS' });
  return;
}
context.emit({ type: 'file_read', path: '/src/path/to/file.js' });
```

### 2. Trace the root cause

Do NOT fix symptoms. Find the root cause:

```js
// Common root cause categories:
// - Off-by-one: index, boundary, fence post
// - Null/undefined not handled: add null checks
// - Async race: await missing, promise not returned
// - State mutation: object shared when it should be copied
// - Type mismatch: string vs number, array vs object
// - Wrong algorithm: logic error in core computation

context.emit({ type: 'progress', message: 'Root cause: <describe what you found>' });
```

### 3. Write the minimal fix

Fix ONLY what is broken. Do not refactor surrounding code:

```js
// Read current content
const original = context.vfs.read('/src/path/to/file.js');

// Apply targeted fix
const fixed = original.replace(
  /buggy pattern/,
  'correct replacement'
);

// Or for structural changes, reconstruct the relevant section
context.vfs.write('/src/path/to/file.js', fixed);
context.emit({ type: 'file_write', path: '/src/path/to/file.js' });
```

### 4. Verify the fix

Check the fix is logically correct:

```js
context.emit({ type: 'progress', message: 'Verifying fix...' });

// Re-read the fixed file and confirm:
// 1. The bug condition is gone
// 2. The surrounding logic is unchanged
// 3. Edge cases are handled (null, empty, boundary)

const verified = context.vfs.read('/src/path/to/file.js');
// Spot-check that fix is present and correct
if (!verified.includes('expected fixed pattern')) {
  context.emit({ type: 'progress', message: 'Warning: fix may not have applied correctly' });
}
```

### 5. Document what changed

```js
context.emit({ type: 'result', value: {
  file: '/src/path/to/file.js',
  root_cause: '<description>',
  fix: '<description of change>',
  verification: 'logic check passed',
}});
context.emit({ type: 'done', message: 'Bug fixed: <one-liner>' });
```

## Anti-patterns to avoid

- **Symptom masking**: don't add `try/catch` to suppress an error without fixing it
- **Over-fixing**: don't refactor code that isn't broken
- **Assumption-driven fixes**: always READ the file before fixing it
- **Missing edge cases**: null inputs, empty arrays, 0 values, concurrent calls

## Common fix patterns

```js
// Null guard
const value = obj?.field ?? defaultValue;

// Array boundary
const idx = Math.min(index, array.length - 1);

// Async fix — ensure await
const result = await asyncFn();

// Defensive copy
const copy = { ...shared };
copy.field = newValue;
```
