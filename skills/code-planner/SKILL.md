---
name: code-planner
description: Analyze requirements and produce a detailed implementation plan before writing code
---

# code-planner

Analyze requirements, explore the existing codebase, and write a concrete implementation plan before touching any production code.

## When to use

Use this skill when:
- Task involves multiple files or systems
- Requirements are ambiguous or underspecified
- Risk of getting architecture wrong is high
- You need to communicate a plan before executing

## Steps

### 1. Understand requirements

Read `/src/` files and any requirements docs in VFS:

```js
const reqFiles = context.vfs.list().filter(p =>
  p.includes('requirement') || p.includes('spec') || p.includes('README')
);
for (const f of reqFiles.slice(0, 5)) {
  const content = context.vfs.read(f);
  context.emit({ type: 'file_read', path: f });
  // analyze...
}
```

### 2. Map the existing structure

```js
const srcFiles = context.vfs.list().filter(p => p.startsWith('/src/'));
context.emit({ type: 'progress', message: `Analyzing ${srcFiles.length} source files...` });

// Identify:
// - Entry points
// - Key interfaces / contracts
// - Existing patterns to follow
// - Files that will need modification
```

### 3. Write the plan

Save to `/scratch/<task-slug>/plan.md`:

```js
const plan = [
  '# Implementation Plan: <task name>',
  '',
  '## Goal',
  '<one sentence>',
  '',
  '## Approach',
  '<2-3 sentences on strategy>',
  '',
  '## Files to create',
  '| File | Purpose |',
  '|------|---------|',
  '| /src/services/foo.js | Does X |',
  '',
  '## Files to modify',
  '| File | Change |',
  '|------|--------|',
  '| /src/index.js | Export new service |',
  '',
  '## Implementation order',
  '1. Create interfaces/types first',
  '2. Implement core logic',
  '3. Wire into existing system',
  '4. Write tests',
  '',
  '## Risk / unknowns',
  '- <thing that might be wrong>',
  '',
  '## Success criteria',
  '- [ ] <testable outcome>',
].join('\n');

context.vfs.write('/scratch/<task-slug>/plan.md', plan);
context.emit({ type: 'file_write', path: '/scratch/<task-slug>/plan.md' });
```

### 4. Emit the plan as a result

```js
context.emit({ type: 'result', value: plan });
context.emit({ type: 'done', message: 'Plan written to /scratch/<task-slug>/plan.md — ready to implement' });
```

## Do NOT

- Do not start writing `/src/` files in the same turn as planning
- Do not write a plan that just restates the requirements — add analysis, ordering, and risk
- Do not skip the "files to modify" section — that's often the most important part

## Plan quality checklist

- [ ] Implementation order respects dependencies (bottom-up)
- [ ] Every file listed has a clear, specific purpose
- [ ] Risk/unknowns section is honest about gaps
- [ ] Success criteria are measurable
