---
name: verify
description: Verify that a previous step's claimed outputs actually exist and are correct — emits PASS, FAIL, or BLOCKED
---

# verify

**Core principle:** The VFS state is ground truth. What the agent said it did is a claim. Verify the claim.

Emit `blocked` (not `done`) if verification fails. This halts dependent workflow steps.

## Protocol

### 1. Find the plan

```js
// Check common plan locations
const planPaths = context.vfs.list().filter(p =>
  p.endsWith('plan.md') || p.endsWith('plan.json')
);
if (planPaths.length === 0) {
  context.emit({ type: 'blocked', reason: 'No plan found — cannot verify without a plan' });
  return;
}
const planPath = planPaths[planPaths.length - 1]; // most recent
const plan = context.vfs.read(planPath);
context.emit({ type: 'file_read', path: planPath });
```

### 2. Snapshot current VFS state

```js
const srcFiles = context.vfs.list().filter(p => p.startsWith('/src/'));
context.emit({ type: 'progress', message: `VFS has ${srcFiles.length} files in /src/` });
```

### 3. Extract claimed outputs from the plan

Parse "files to create" and "files to modify" sections from the plan markdown:

```js
const claimedCreates = [];
const claimedModifies = [];

// Extract from markdown table rows or bullet lists
const createSection = plan.match(/## Files to create([\s\S]*?)(?=##|$)/i)?.[1] ?? '';
const modifySection = plan.match(/## Files to modify([\s\S]*?)(?=##|$)/i)?.[1] ?? '';

// Collect /src/ paths from both sections
for (const line of createSection.split('\n')) {
  const match = line.match(/(`\/src\/[^`]+`|\/src\/\S+)/);
  if (match) claimedCreates.push(match[1].replace(/`/g, ''));
}
for (const line of modifySection.split('\n')) {
  const match = line.match(/(`\/src\/[^`]+`|\/src\/\S+)/);
  if (match) claimedModifies.push(match[1].replace(/`/g, ''));
}
```

### 4. Check each claimed file

```js
const failures = [];
const passes = [];

for (const path of claimedCreates) {
  const content = context.vfs.read(path);
  if (!content) {
    failures.push(`MISSING: ${path} (claimed created, not in VFS)`);
  } else if (content.trim().length < 20) {
    failures.push(`EMPTY: ${path} (only ${content.trim().length} chars — likely truncated)`);
  } else {
    passes.push(`EXISTS: ${path} (${content.length} chars)`);
  }
}

for (const path of claimedModifies) {
  const content = context.vfs.read(path);
  if (!content) {
    failures.push(`MISSING: ${path} (claimed modified, not in VFS)`);
  } else {
    passes.push(`EXISTS: ${path}`);
  }
}
```

### 5. Spot-check content quality

```js
for (const path of [...claimedCreates, ...claimedModifies]) {
  const content = context.vfs.read(path);
  if (!content) continue;

  // Check for placeholder content
  if (content.includes('TODO') && content.includes('implement')) {
    failures.push(`STUB: ${path} contains unimplemented TODOs`);
  }
  // Check for truncation markers
  if (content.includes('// ...') && content.split('\n').length < 10) {
    failures.push(`TRUNCATED: ${path} appears to be a skeleton`);
  }
}
```

### 6. Emit PASS or FAIL

```js
const report = {
  plan: planPath,
  checked: claimedCreates.length + claimedModifies.length,
  passed: passes.length,
  failed: failures.length,
  failures,
  passes,
};

// Write report to VFS for downstream steps
const reportPath = planPath.replace('plan.md', 'verification.md');
const lines = [
  '# Verification Report',
  '',
  `**Plan:** ${planPath}`,
  `**Result:** ${failures.length === 0 ? 'PASS' : 'FAIL'}`,
  `**Checked:** ${report.checked} files`,
  '',
];
if (passes.length > 0) {
  lines.push('## Passed', ...passes.map(p => `- ✓ ${p}`), '');
}
if (failures.length > 0) {
  lines.push('## Failed', ...failures.map(f => `- ✗ ${f}`), '');
}
context.vfs.write(reportPath, lines.join('\n'));
context.emit({ type: 'file_write', path: reportPath });

if (failures.length > 0) {
  context.emit({ type: 'result', value: report });
  context.emit({ type: 'blocked', reason: `Verification FAIL: ${failures.length} issue(s) — ${failures[0]}` });
} else {
  context.emit({ type: 'result', value: report });
  context.emit({ type: 'done', message: `Verification PASS: ${passes.length} files checked` });
}
```

## When to emit BLOCKED vs FAIL

- **BLOCKED** — emit this when: plan not found, VFS empty (nothing ran), prerequisites missing
- **FAIL via blocked** — emit `blocked` with the failure reason: this halts dependent workflow steps
- **PASS via done** — emit `done` only when every claimed file exists and has real content

## Important

- When in doubt: BLOCKED. Optimistic verification is worthless.
- A file with 10 lines that should have 100 is a FAIL.
- Never emit `done` if any claimed file is missing.
