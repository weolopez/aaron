---
name: evaluate-workflow
description: Evaluate workflow run quality by analyzing artifacts and scratch outputs, identify gaps and root causes, and write a structured assessment with actionable recommendations.
---

# evaluate-workflow

Assess the quality of a completed workflow run by reading its artifacts, comparing them to the workflow definition's intended goals, identifying missing or thin outputs, and producing a structured report with root-cause analysis and concrete recommendations.

## When to use

- After a workflow run completes and you want to know if it succeeded fully
- When artifacts look incomplete, empty, or lower quality than expected
- Before deciding whether to re-run or improve a workflow definition
- As part of an RSI loop to score workflow output quality

## Steps

### 1. Locate the workflow definition and run state

```js
context.emit({ type: 'progress', message: 'Step 1: Locating workflow definition and run state...' });

// Find the most recently run workflow
const files = context.vfs.list();
const workflowFiles = files.filter(f => f.startsWith('/workflows/') && f.endsWith('.json'));
context.emit({ type: 'progress', message: `Found ${workflowFiles.length} workflow definition(s): ${workflowFiles.join(', ')}` });

// Try to find which workflow was last run from workflow-state.json
const stateRaw = context.vfs.read('/scratch/workflow-state.json');
let lastWorkflowName = null;
let completedSteps = [];
if (stateRaw) {
  try {
    const state = JSON.parse(stateRaw);
    lastWorkflowName = state.workflowName || null;
    completedSteps = state.completedSteps || [];
    context.emit({ type: 'progress', message: `Last run workflow: ${lastWorkflowName}, completed steps: ${completedSteps.length}` });
  } catch {
    context.emit({ type: 'progress', message: 'Warning: workflow-state.json is malformed' });
  }
}

// Load the workflow definition
let workflowDef = null;
if (lastWorkflowName) {
  const wfRaw = context.vfs.read(`/workflows/${lastWorkflowName}.json`);
  if (wfRaw) {
    try { workflowDef = JSON.parse(wfRaw); } catch {}
  }
}
// Fallback: load first available workflow
if (!workflowDef && workflowFiles.length > 0) {
  try { workflowDef = JSON.parse(context.vfs.read(workflowFiles[0])); } catch {}
}
context.emit({ type: 'progress', message: workflowDef ? `Loaded workflow: ${workflowDef.name || 'unnamed'} (${(workflowDef.steps||[]).length} steps)` : 'No workflow definition found' });
```

### 2. Collect all artifacts and scratch outputs

```js
context.emit({ type: 'progress', message: 'Step 2: Collecting artifacts and scratch outputs...' });

const artifactPaths = files.filter(f => f.startsWith('/artifacts/'));
const scratchPaths = files.filter(f => f.startsWith('/scratch/') && f !== '/scratch/workflow-state.json');
const memoryPaths = files.filter(f => f.startsWith('/memory/') && !f.includes('agent-history'));

context.emit({ type: 'progress', message: `Artifacts: ${artifactPaths.length}, Scratch: ${scratchPaths.length}, Memory: ${memoryPaths.length}` });

// Read and measure each artifact
const artifacts = artifactPaths.map(path => {
  const content = context.vfs.read(path);
  return { path, size: content ? content.length : 0, empty: !content || content.trim().length === 0 };
});
const scratchFiles = scratchPaths.map(path => {
  const content = context.vfs.read(path);
  return { path, size: content ? content.length : 0, empty: !content || content.trim().length === 0 };
});

const emptyArtifacts = artifacts.filter(a => a.empty);
const thinArtifacts = artifacts.filter(a => !a.empty && a.size < 100);
context.emit({ type: 'progress', message: `Empty artifacts: ${emptyArtifacts.length}, Thin (<100 bytes): ${thinArtifacts.length}` });
```

### 3. Compare expected outputs against actual outputs

```js
context.emit({ type: 'progress', message: 'Step 3: Comparing expected vs actual outputs...' });

const expectedOutputs = [];
const missingOutputs = [];
const presentOutputs = [];

if (workflowDef && workflowDef.steps) {
  for (const step of workflowDef.steps) {
    // Steps may declare expectedArtifacts, outputPath, or we infer from step name
    const stepOutputs = step.expectedArtifacts || (step.outputPath ? [step.outputPath] : []);
    for (const expected of stepOutputs) {
      expectedOutputs.push(expected);
      const normalizedPath = expected.startsWith('/') ? expected : `/artifacts/${expected}`;
      const found = artifacts.find(a => a.path === normalizedPath || a.path.endsWith(expected));
      if (!found || found.empty) {
        missingOutputs.push({ step: step.name || step.id, expected, found: !!found, empty: found?.empty });
      } else {
        presentOutputs.push({ step: step.name || step.id, path: found.path, size: found.size });
      }
    }
  }
}

context.emit({ type: 'progress', message: `Expected outputs: ${expectedOutputs.length}, Missing/empty: ${missingOutputs.length}, Present: ${presentOutputs.length}` });

// Check experiment journal for scoring signals
const journal = context.vfs.read('/memory/experiments.jsonl');
let lowScoreExperiments = [];
if (journal) {
  const entries = journal.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  lowScoreExperiments = entries.filter(e => typeof e.score === 'number' && e.score < 5);
  context.emit({ type: 'progress', message: `Experiment journal: ${entries.length} entries, ${lowScoreExperiments.length} low-score (<5)` });
}
```

### 4. Perform root-cause analysis

```js
context.emit({ type: 'progress', message: 'Step 4: Root-cause analysis...' });

const rootCauses = [];
const gaps = [];

// Missing outputs
if (missingOutputs.length > 0) {
  rootCauses.push({
    category: 'missing_outputs',
    description: `${missingOutputs.length} expected output(s) not produced or empty`,
    affected: missingOutputs.map(m => m.expected),
    likely_cause: 'Step did not run to completion, or file_write path was wrong',
  });
}

// Empty artifacts
if (emptyArtifacts.length > 0) {
  rootCauses.push({
    category: 'empty_artifacts',
    description: `${emptyArtifacts.length} artifact file(s) are empty`,
    affected: emptyArtifacts.map(a => a.path),
    likely_cause: 'Agent wrote empty string or LLM produced no output for the step',
  });
}

// Thin artifacts (content present but very short — likely incomplete)
if (thinArtifacts.length > 0) {
  rootCauses.push({
    category: 'thin_artifacts',
    description: `${thinArtifacts.length} artifact(s) are very short (<100 bytes)`,
    affected: thinArtifacts.map(a => `${a.path} (${a.size}B)`),
    likely_cause: 'Step prompt too vague, or model produced a stub rather than full output',
  });
}

// Incomplete steps
if (workflowDef && completedSteps.length < (workflowDef.steps || []).length) {
  const totalSteps = (workflowDef.steps || []).length;
  const incomplete = workflowDef.steps
    .filter(s => !completedSteps.includes(s.id || s.name))
    .map(s => s.name || s.id || 'unnamed');
  if (incomplete.length > 0) {
    rootCauses.push({
      category: 'incomplete_run',
      description: `Workflow stopped after ${completedSteps.length}/${totalSteps} steps`,
      affected: incomplete,
      likely_cause: 'Step threw an error, hit max retries, or emit done was never called',
    });
    gaps.push(...incomplete.map(s => ({ type: 'step_not_run', step: s })));
  }
}

// Low-scored experiments
if (lowScoreExperiments.length > 0) {
  rootCauses.push({
    category: 'low_quality_scores',
    description: `${lowScoreExperiments.length} experiment(s) scored below 5/10`,
    affected: lowScoreExperiments.map(e => `${e.id || 'exp'}: score ${e.score}`),
    likely_cause: 'Skill or harness mutation did not improve output quality; consider reverting or deeper analysis',
  });
}

context.emit({ type: 'progress', message: `Root causes identified: ${rootCauses.length}, Gaps: ${gaps.length}` });
```

### 5. Generate recommendations and write report

```js
context.emit({ type: 'progress', message: 'Step 5: Writing structured assessment report...' });

const recommendations = [];

if (rootCauses.some(r => r.category === 'missing_outputs' || r.category === 'incomplete_run')) {
  recommendations.push({
    priority: 'high',
    action: 'Fix incomplete workflow steps',
    detail: 'Check step prompts for clear output instructions and correct file paths. Ensure each step emits `done` on success and surfaces errors via `progress`.',
  });
}
if (rootCauses.some(r => r.category === 'empty_artifacts' || r.category === 'thin_artifacts')) {
  recommendations.push({
    priority: 'high',
    action: 'Improve step output prompts',
    detail: 'Thin or empty artifacts indicate the LLM is not producing substantive output. Add explicit word-count minimums, example structure, or more context in the step prompt.',
  });
}
if (rootCauses.some(r => r.category === 'low_quality_scores')) {
  recommendations.push({
    priority: 'medium',
    action: 'Review RSI experiment history',
    detail: 'Low-scored experiments indicate the current skill/harness version is not improving. Use `:skill improve` with evidence from `/scratch/` to target the weakest step.',
  });
}
if (rootCauses.length === 0 && artifacts.length > 0 && emptyArtifacts.length === 0) {
  recommendations.push({
    priority: 'low',
    action: 'Consider adding assertions or quality metrics',
    detail: 'Artifacts are present and non-empty. Add structured eval criteria (word count, presence of expected sections) to distinguish good from great output.',
  });
}

// Build the report
const now = new Date().toISOString();
const workflowName = workflowDef?.name || lastWorkflowName || 'unknown';
const overallStatus = rootCauses.length === 0 ? 'PASS' : rootCauses.some(r => r.category === 'missing_outputs' || r.category === 'incomplete_run') ? 'FAIL' : 'PARTIAL';

const report = [
  `# Workflow Evaluation Report`,
  ``,
  `**Workflow:** ${workflowName}  `,
  `**Evaluated:** ${now}  `,
  `**Overall Status:** ${overallStatus}  `,
  ``,
  `## Summary`,
  ``,
  `| Metric | Value |`,
  `|--------|-------|`,
  `| Artifacts found | ${artifacts.length} |`,
  `| Empty artifacts | ${emptyArtifacts.length} |`,
  `| Thin artifacts (<100B) | ${thinArtifacts.length} |`,
  `| Expected outputs | ${expectedOutputs.length} |`,
  `| Missing/empty outputs | ${missingOutputs.length} |`,
  `| Completed steps | ${completedSteps.length} |`,
  `| Total steps | ${(workflowDef?.steps||[]).length} |`,
  ``,
  `## Artifacts`,
  ``,
  ...(artifacts.length > 0
    ? artifacts.map(a => `- \`${a.path}\`: ${a.empty ? '⚠️ empty' : `${a.size} bytes`}`)
    : ['_No artifacts found_']),
  ``,
  `## Root Cause Analysis`,
  ``,
  ...(rootCauses.length > 0
    ? rootCauses.flatMap(rc => [
        `### ${rc.category}`,
        ``,
        rc.description,
        ``,
        `**Likely cause:** ${rc.likely_cause}`,
        ``,
        `**Affected:**`,
        ...rc.affected.map(a => `- ${a}`),
        ``,
      ])
    : ['_No root causes identified. Workflow appears to have run successfully._', '']),
  `## Gaps`,
  ``,
  ...(gaps.length > 0
    ? gaps.map(g => `- ${g.type}: \`${g.step}\``)
    : ['_No gaps detected._']),
  ``,
  `## Recommendations`,
  ``,
  ...(recommendations.length > 0
    ? recommendations.flatMap(r => [
        `### [${r.priority.toUpperCase()}] ${r.action}`,
        ``,
        r.detail,
        ``,
      ])
    : ['_No recommendations — workflow output quality looks good._']),
].join('\n');

// Ensure output directory exists in VFS (write creates it)
context.vfs.write('/scratch/evaluate/report.md', report);
context.emit({ type: 'file_write', path: '/scratch/evaluate/report.md' });
context.emit({ type: 'progress', message: `Report written: ${report.split('\n').length} lines, status=${overallStatus}` });

context.emit({ type: 'result', value: {
  workflowName,
  overallStatus,
  artifactsFound: artifacts.length,
  emptyArtifacts: emptyArtifacts.length,
  rootCauses: rootCauses.length,
  recommendations: recommendations.length,
  reportPath: '/scratch/evaluate/report.md',
}});
context.emit({ type: 'done', message: `Workflow evaluation complete: ${overallStatus} — ${rootCauses.length} root cause(s), ${recommendations.length} recommendation(s)` });
```

## Anti-patterns to avoid

- **Evaluating without reading**: Always call `context.vfs.list()` first to discover actual files before asserting what exists or doesn't
- **Hard-coding paths**: Workflow artifact paths vary — infer them from the workflow definition or by scanning `/artifacts/` and `/scratch/`
- **Score inflation**: If artifacts are thin or empty, mark status as FAIL/PARTIAL, not PASS
- **Skipping root cause**: Don't jump to recommendations without identifying why the gap occurred
- **Overwriting history**: Write to `/scratch/evaluate/report.md` — do not overwrite `/memory/experiments.jsonl` or workflow state
