---
name: adr-writer
description: Write an Architecture Decision Record (ADR) for a technical decision
---

# adr-writer

Write a well-structured Architecture Decision Record (ADR) and save it to `/src/docs/adr/` or wherever the project keeps ADRs.

## ADR Format

Use the MADR (Markdown Architectural Decision Records) format:

```
# ADR-NNN: <title>

**Date:** YYYY-MM-DD
**Status:** Proposed | Accepted | Deprecated | Superseded by [ADR-NNN]
**Deciders:** <team or individuals>

## Context and Problem Statement

<Describe the context, forces, and the decision that needs to be made.>

## Decision Drivers

- <driver 1>
- <driver 2>

## Considered Options

- Option A: <name>
- Option B: <name>
- Option C: <name>

## Decision Outcome

**Chosen option:** <Option X>, because <justification>.

### Positive Consequences

- <consequence 1>

### Negative Consequences / Trade-offs

- <consequence 1>

## Pros and Cons of the Options

### Option A: <name>

- Good: <reason>
- Bad: <reason>

### Option B: <name>

- Good: <reason>
- Bad: <reason>
```

## Steps

### 1. Find existing ADRs

```js
const existing = context.vfs.list().filter(p => p.match(/\/docs\/adr\/.*\.md$/i) || p.match(/\/adr\/.*\.md$/i));
context.emit({ type: 'progress', message: `Found ${existing.length} existing ADRs` });

// Determine next ADR number
const nums = existing.map(p => parseInt(p.match(/(\d+)/)?.[1] ?? '0')).filter(n => n > 0);
const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
const adrId = String(nextNum).padStart(3, '0');
```

### 2. Read relevant source files for context

```js
// Read existing code to understand the current architecture
const sourceFiles = context.vfs.list().filter(p => p.startsWith('/src/'));
// Read the most relevant files for this decision
```

### 3. Write the ADR

```js
const adrPath = `/src/docs/adr/ADR-${adrId}-<slug>.md`;
const lines = [
  `# ADR-${adrId}: <Title>`,
  '',
  '**Date:** ' + new Date().toISOString().split('T')[0],
  '**Status:** Proposed',
  // ...
];
context.vfs.write(adrPath, lines.join('\n'));
context.emit({ type: 'file_write', path: adrPath });
```

### 4. Update ADR index if one exists

```js
const indexPath = '/src/docs/adr/README.md';
const index = context.vfs.read(indexPath);
if (index) {
  const updated = index + `\n- [ADR-${adrId}](ADR-${adrId}-<slug>.md) — <title>`;
  context.vfs.write(indexPath, updated);
}
```

## Quality checklist

Before emitting done, verify:
- [ ] Context clearly explains WHY a decision was needed
- [ ] At least 2 options considered
- [ ] Trade-offs honestly stated (don't just advocate for the chosen option)
- [ ] Decision outcome has a clear "because" clause
- [ ] ADR number is sequential and unique
