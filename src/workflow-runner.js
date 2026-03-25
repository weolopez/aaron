/**
 * workflow-runner.js — Shared workflow orchestration logic
 *
 * Used by both agent-harness.mjs (CLI) and agent-harness.html (browser).
 * Platform-specific output is handled via the `ui` adapter passed to runWorkflowSteps.
 */

const STATE_PATH = '/scratch/workflow-state.json';

// ════════════════════════════════════════════════════
// Prompt builders (pure functions)
// ════════════════════════════════════════════════════

export function buildCreatePrompt(wfName, goal) {
  return [
    `Create a workflow definition for a task called "${wfName}".`,
    `Goal: ${goal}`,
    `Write the workflow as JSON to /workflows/${wfName}.json.`,
    'The JSON must have: { "name": "' + wfName + '", "description": "...", "steps": [...] }',
    'Each step: { "id": "step-name", "skill": null, "prompt": "..." }',
    'Rules for writing step prompts:',
    '- Each prompt must describe a COMPLETE, CONCRETE deliverable with exact file paths',
    '- If the goal involves a web page, one step must write a complete self-contained HTML file',
    '  (embed CSS and JavaScript inside the HTML — do not create separate .css / .js files)',
    '- Each prompt must include the exact artifact path: write to /artifacts/' + wfName + '/<file>',
    '- Use 3-5 focused steps',
    'Do NOT execute the steps — only write the workflow definition file.',
    `context.emit({ type: 'done', message: 'Workflow "${wfName}" created. Run it with :workflow ${wfName}' })`,
  ].join('\n');
}

export function buildImprovePrompt(wfName, feedback) {
  return [
    `Read /workflows/${wfName}.json — this is the current workflow definition.`,
    ``,
    `User feedback: ${feedback}`,
    ``,
    `Revise the workflow definition to address this feedback:`,
    `- Update step prompts to be more specific and produce complete, concrete deliverables`,
    `- If the goal involves a web page, ensure one step writes a complete self-contained HTML file`,
    `  (embed CSS and JavaScript inside the HTML — do not create separate .css / .js files)`,
    `- Each step prompt must include the exact output path under /artifacts/${wfName}/<file>`,
    `- Add new steps if needed, remove unnecessary ones, keep 3-6 steps total`,
    ``,
    `Write the revised version back to /workflows/${wfName}.json.`,
    `Do NOT execute the steps — only revise the workflow definition file.`,
    `context.emit({ type: 'done', message: 'Workflow "${wfName}" improved. Run it with :workflow ${wfName}' })`,
  ].join('\n');
}

// ════════════════════════════════════════════════════
// VFS helpers
// ════════════════════════════════════════════════════

export function listWorkflows(vfs) {
  const wfPaths = vfs.list().filter(p => p.startsWith('/workflows/') && p.endsWith('.json'));
  const stateRaw = vfs.read(STATE_PATH);
  const wfState = stateRaw ? (() => { try { return JSON.parse(stateRaw); } catch { return null; } })() : null;

  return wfPaths.map(p => {
    try {
      const wf = JSON.parse(vfs.read(p));
      const active = wfState?.workflow === wf.name;
      const done = active && wfState?.completedSteps?.length === wf.steps?.length;
      return {
        name: wf.name,
        description: wf.description || '',
        stepCount: wf.steps?.length ?? 0,
        status: active ? (done ? 'complete' : 'in-progress') : 'not-started',
        currentStep: active ? wfState.currentStep : null,
      };
    } catch {
      return { name: p, description: '', stepCount: 0, status: 'not-started', currentStep: null };
    }
  });
}

function loadState(vfs) {
  try { return JSON.parse(vfs.read(STATE_PATH) || 'null'); } catch { return null; }
}

// ════════════════════════════════════════════════════
// Step loop
// ════════════════════════════════════════════════════

/**
 * Run (or resume) all steps in a workflow.
 *
 * @param {object} wf       - Parsed workflow JSON { name, steps: [{id, skill, prompt}] }
 * @param {string} wfName   - Workflow name (used in prompts and checkpoint)
 * @param {object} vfs      - VFS instance
 * @param {object} state    - Agent conversation state
 * @param {object} deps     - { runTurn, execute, extractCode, ui }
 * @param {object} hooks    - Optional display callbacks (all default to no-ops):
 *   hooks.onStepStart(stepId, promptPreview)
 *   hooks.onStepVerifying(stepId)
 *   hooks.onStepDone(stepId)
 *   hooks.onStepSkipped(stepId)
 *   hooks.onCheckpointUpdated(stepId)
 *   hooks.onComplete(wfName)
 *   hooks.onUserMsg(text)
 */
export async function runWorkflowSteps(wf, wfName, vfs, state, deps, hooks = {}) {
  const {
    onStepStart        = () => {},
    onStepVerifying    = () => {},
    onStepDone         = () => {},
    onStepSkipped      = () => {},
    onCheckpointUpdated = () => {},
    onComplete         = () => {},
    onUserMsg          = () => {},
  } = hooks;

  const { runTurn } = deps;

  // Load or init checkpoint
  let wfState = loadState(vfs);
  if (!wfState || wfState.workflow !== wfName) {
    wfState = {
      workflow: wfName,
      startedAt: new Date().toISOString(),
      completedSteps: [],
      currentStep: null,
      outputs: {},
    };
    vfs.write(STATE_PATH, JSON.stringify(wfState, null, 2));
  }

  for (const step of wf.steps) {
    if (wfState.completedSteps.includes(step.id)) {
      onStepSkipped(step.id);
      continue;
    }

    onStepStart(step.id, step.prompt.slice(0, 80));

    // Persist current step to checkpoint
    wfState.currentStep = step.id;
    vfs.write(STATE_PATH, JSON.stringify(wfState, null, 2));

    // Build turn prompt — prepend skill instructions if referenced
    let turnPrompt = step.prompt;
    if (step.skill) {
      const skillMd = vfs.read(`/skills/${step.skill}/SKILL.md`);
      if (skillMd) turnPrompt = `Use the "${step.skill}" skill for this step.\n\n${step.prompt}`;
    }

    // Append checkpoint + commit instructions
    turnPrompt += `\n\nAfter completing this step:
1. Update /scratch/workflow-state.json: add "${step.id}" to completedSteps, set outputs["${step.id}"] to a brief result summary.
2. Call await context.commit('workflow: ${wfName} — step ${step.id} complete').
3. context.emit({ type: 'done', message: 'Step ${step.id} complete' })`;

    onUserMsg(turnPrompt);
    await runTurn(turnPrompt, state, deps);

    // Continuation pass: verify and fill any gaps
    onStepVerifying(step.id);
    await runTurn(
      `You just ran step "${step.id}". Its task was:\n${step.prompt}\n\n` +
      `Call context.vfs.list() and verify every file or output the step required now exists. ` +
      `If anything is missing or incomplete, write it now. ` +
      `context.emit({ type: 'done', message: 'Step ${step.id} verified' })`,
      state, deps
    );

    // Re-read checkpoint (agent may have updated it)
    const updated = loadState(vfs);
    if (updated) wfState = updated;

    // Safety net: mark complete if agent didn't
    if (!wfState.completedSteps.includes(step.id)) {
      wfState.completedSteps.push(step.id);
      vfs.write(STATE_PATH, JSON.stringify(wfState, null, 2));
      onCheckpointUpdated(step.id);
    }

    onStepDone(step.id);
  }

  onComplete(wfName);
}
