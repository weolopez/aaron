---
name: workflow-runner
description: Define and execute multi-step long-running workflows backed by VFS and GitHub. Use when a task requires multiple sequential phases, checkpoint/resume across sessions, or composing multiple skills into a pipeline.
---

# Workflow Runner

Execute multi-step workflows with durable state: each step is a full agent turn, progress is checkpointed to VFS, and GitHub provides persistence across sessions.

## When to use

- Tasks requiring 3+ sequential phases (plan → build → test → deploy)
- Work that may span multiple sessions (resume from where you left off)
- Pipelines that compose multiple skills in order
- Any task where losing state mid-way would be costly

## Workflow Definition Format

Store workflow definitions as JSON in `/workflows/<name>.json`:

```json
{
  "name": "my-workflow",
  "description": "What this workflow accomplishes",
  "steps": [
    {
      "id": "plan",
      "skill": null,
      "prompt": "Read the requirements and write a build plan to /scratch/my-workflow/plan.md"
    },
    {
      "id": "implement",
      "skill": "component-builder",
      "prompt": "Build the component described in /scratch/my-workflow/plan.md and write it to /artifacts/my-workflow/component.js"
    },
    {
      "id": "test",
      "skill": "testing",
      "prompt": "Write and run tests for /artifacts/my-workflow/component.js, save results to /artifacts/my-workflow/test-results.md"
    },
    {
      "id": "commit",
      "skill": null,
      "prompt": "Summarize what was built and call context.commit('workflow: my-workflow complete')"
    }
  ]
}
```

## Checkpoint State Format

Track progress in `/scratch/workflow-state.json`:

```json
{
  "workflow": "my-workflow",
  "startedAt": "2026-03-24T10:00:00Z",
  "completedSteps": ["plan", "implement"],
  "currentStep": "test",
  "outputs": {
    "plan": "Build plan written to /scratch/plan.md",
    "implement": "Component written to /artifacts/MyComponent.js"
  }
}
```

## Execution Pattern

### Starting a workflow

```js
// 1. Load or create the workflow definition
const wfPath = '/workflows/my-workflow.json';
const wf = JSON.parse(context.vfs.read(wfPath));

// 2. Initialize checkpoint (or load existing)
const statePath = '/scratch/workflow-state.json';
let state = context.vfs.read(statePath)
  ? JSON.parse(context.vfs.read(statePath))
  : { workflow: wf.name, startedAt: new Date().toISOString(), completedSteps: [], currentStep: null, outputs: {} };

// 3. Find next step
const nextStep = wf.steps.find(s => !state.completedSteps.includes(s.id));
if (!nextStep) {
  context.emit({ type: 'done', message: `Workflow "${wf.name}" already complete` });
  return;
}

// 4. Update checkpoint to current step
state.currentStep = nextStep.id;
context.vfs.write(statePath, JSON.stringify(state, null, 2));

context.emit({ type: 'progress', message: `Step [${nextStep.id}]: ${nextStep.prompt.slice(0, 80)}` });
context.emit({ type: 'done', message: `Ready to execute step "${nextStep.id}". Run the next turn with: ${nextStep.prompt}` });
```

### Completing a step (run this after each step's work)

```js
const statePath = '/scratch/workflow-state.json';
const state = JSON.parse(context.vfs.read(statePath));
const stepId = state.currentStep;

// Record output summary
state.outputs[stepId] = 'Brief description of what was produced';
state.completedSteps.push(stepId);

// Find next step
const wf = JSON.parse(context.vfs.read(`/workflows/${state.workflow}.json`));
const nextStep = wf.steps.find(s => !state.completedSteps.includes(s.id));
state.currentStep = nextStep ? nextStep.id : null;

context.vfs.write(statePath, JSON.stringify(state, null, 2));

// Commit to GitHub for durability after each step
await context.commit(`workflow: completed step "${stepId}"`);

context.emit({ type: 'metric', name: 'steps_completed', value: state.completedSteps.length, unit: 'steps' });
if (nextStep) {
  context.emit({ type: 'progress', message: `Next step: [${nextStep.id}] ${nextStep.prompt.slice(0, 80)}` });
  context.emit({ type: 'done', message: `Step "${stepId}" done. Checkpoint saved. Continuing to "${nextStep.id}".` });
} else {
  context.emit({ type: 'done', message: `Workflow "${state.workflow}" complete! All ${state.completedSteps.length} steps done.` });
}
```

### Resuming after session restart

```js
const statePath = '/scratch/workflow-state.json';
const raw = context.vfs.read(statePath);
if (!raw) {
  context.emit({ type: 'error', message: 'No workflow state found. Start a new workflow.' });
  return;
}
const state = JSON.parse(raw);
const wf = JSON.parse(context.vfs.read(`/workflows/${state.workflow}.json`));
const nextStep = wf.steps.find(s => !state.completedSteps.includes(s.id));

context.emit({ type: 'progress', message: `Resuming "${state.workflow}"` });
context.emit({ type: 'progress', message: `Completed: ${state.completedSteps.join(', ')}` });
context.emit({ type: 'done', message: nextStep
  ? `Next step: [${nextStep.id}] ${nextStep.prompt}`
  : `Workflow already complete!` });
```

## Creating a New Workflow

To bootstrap a workflow from a description:

```js
const name = 'my-feature';
const steps = [
  { id: 'plan',      skill: null,               prompt: 'Analyze requirements and write /scratch/' + name + '/plan.md' },
  { id: 'scaffold',  skill: 'component-builder', prompt: 'Build skeleton per /scratch/' + name + '/plan.md, output to /artifacts/' + name + '/' },
  { id: 'implement', skill: null,               prompt: 'Fill in full implementation in /artifacts/' + name + '/' },
  { id: 'test',      skill: 'testing',          prompt: 'Write tests, verify all pass, save results to /artifacts/' + name + '/test-results.md' },
  { id: 'document',  skill: 'documentation',    prompt: 'Write README to /artifacts/' + name + '/README.md' },
  { id: 'commit',    skill: null,               prompt: 'context.commit("feat: ' + name + ' complete")' },
];

context.vfs.write(`/workflows/${name}.json`, JSON.stringify({ name, steps }, null, 2));
context.emit({ type: 'file_write', path: `/workflows/${name}.json` });
context.emit({ type: 'done', message: `Workflow "${name}" created with ${steps.length} steps. Say "run workflow ${name}" to start.` });
```

## GitHub Persistence

Workflows are durable because:
1. `/workflows/*.json` — definition files, loaded at session start (if GitHub is connected)
2. `/scratch/workflow-state.json` — checkpoint, committed after each step
3. `/artifacts/*` — step outputs, committed on completion
4. All dirty VFS files flush on `context.commit()`

If GitHub is connected, the workflow can survive:
- Session timeout / browser close
- Network interruption between steps
- Manual pause and resume days later

## Composing Skills

When a step has a `skill` field, read the full skill instructions before executing:

```js
const step = { id: 'test', skill: 'testing', prompt: 'Write tests for /artifacts/MyComponent.js' };
if (step.skill) {
  const skillMd = context.vfs.read(`/skills/${step.skill}/SKILL.md`);
  // The skill instructions are now in context — follow them for this step
}
// then execute step.prompt
```

## Checklist

```
Workflow Execution Progress:
- [ ] Load or create workflow definition in /workflows/<name>.json
- [ ] Initialize or load checkpoint from /scratch/workflow-state.json
- [ ] Execute current step following any referenced skill instructions
- [ ] Record step output summary in checkpoint outputs map
- [ ] Mark step complete, advance currentStep
- [ ] context.commit() to persist to GitHub
- [ ] Emit progress + done with next step description
- [ ] Repeat until all steps complete
```
