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
    onStepBlocked      = () => {},
    onCheckpointUpdated = () => {},
    onComplete         = () => {},
    onUserMsg          = () => {},
  } = hooks;

  const { runTurn } = deps;

  const HISTORY_PATH = '/memory/agent-history.json';

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
  } else {
    // Resuming — restore conversation history if saved
    const savedHistory = vfs.read(HISTORY_PATH);
    if (savedHistory && state.history.length === 0) {
      try { state.history = JSON.parse(savedHistory); } catch { /* ignore */ }
    }
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

    // Build turn prompt — inject full skill instructions if referenced
    let turnPrompt = step.prompt;
    if (step.skill) {
      const skillMd = vfs.read(`/skills/${step.skill}/SKILL.md`);
      if (skillMd) {
        turnPrompt = `## Skill: ${step.skill}\n\nFollow these skill instructions exactly:\n\n${skillMd}\n\n## Task\n\n${step.prompt}`;
      }
    }

    // Append checkpoint + commit instructions
    const commitInstruction = step.no_commit
      ? '2. Do NOT call context.commit() — files must remain dirty for the next step.'
      : `2. Call await context.commit('workflow: ${wfName} — step ${step.id} complete').`;
    turnPrompt += `\n\nAfter completing this step:
1. Update /scratch/workflow-state.json: add "${step.id}" to completedSteps, set outputs["${step.id}"] to a brief result summary.
${commitInstruction}
3. context.emit({ type: 'done', message: 'Step ${step.id} complete' })`;

    // Intercept blocked events emitted during this step
    let stepBlockedReason = null;
    const origEmit = state.context.emit;
    state.context.emit = (ev) => {
      if (ev.type === 'blocked') stepBlockedReason = ev.reason ?? 'blocked';
      origEmit(ev);
    };

    onUserMsg(turnPrompt);
    await runTurn(turnPrompt, state, deps);

    state.context.emit = origEmit; // restore

    // Halt workflow if step emitted blocked
    if (stepBlockedReason) {
      onStepBlocked(step.id, stepBlockedReason);
      vfs.write(HISTORY_PATH, JSON.stringify(state.history));
      return;
    }

    // Continuation pass: verify and fill any gaps
    onStepVerifying(step.id);
    await runTurn(
      `You just ran step "${step.id}". Its task was:\n${step.prompt}\n\n` +
      `Call context.vfs.list() and verify every file or output the step required now exists. ` +
      `If anything is missing or incomplete, write it now. ` +
      `context.emit({ type: 'done', message: 'Step ${step.id} verified' })`,
      state, deps
    );

    state.context.emit = origEmit; // restore after continuation pass too

    // Re-read checkpoint (agent may have updated it)
    const updated = loadState(vfs);
    if (updated) wfState = updated;

    // Safety net: mark complete if agent didn't
    if (!wfState.completedSteps.includes(step.id)) {
      wfState.completedSteps.push(step.id);
      vfs.write(STATE_PATH, JSON.stringify(wfState, null, 2));
      onCheckpointUpdated(step.id);
    }

    // Persist conversation history so resumption has full context
    vfs.write(HISTORY_PATH, JSON.stringify(state.history));

    onStepDone(step.id);
  }

  onComplete(wfName);
}

// ════════════════════════════════════════════════════
// WORKFLOW RSI
// ════════════════════════════════════════════════════

/**
 * Score a workflow run.
 * Returns { completed, completedSteps, totalSteps, artifactCount, artifactSize, errors, qualityScore }.
 *
 * @param {Function|null} scorer - Optional async (goal, artifactMap) → number (0-10)
 */
async function runWorkflowEval(wfName, wf, state, deps, vfs, scorer = null) {
  // Clear workflow state for a fresh run
  vfs.write(STATE_PATH, 'null');

  const artifactPrefix = `/artifacts/${wfName}/`;
  const beforeSet = new Set(vfs.list().filter(p => p.startsWith(artifactPrefix)));

  let allStepsDone = false;
  let errors = 0;

  const origEmit = state.context.emit;
  state.context.emit = (ev) => {
    if (ev.type === 'error') errors++;
    origEmit(ev);
  };

  try {
    await runWorkflowSteps(wf, wfName, vfs, state, deps, {
      onComplete: () => { allStepsDone = true; },
    });
  } catch { /* step loop failed */ } finally {
    state.context.emit = origEmit;
  }

  const afterArtifacts = vfs.list().filter(p => p.startsWith(artifactPrefix));
  const newArtifacts = afterArtifacts.filter(p => !beforeSet.has(p));
  const artifactSize = newArtifacts.reduce((sum, p) => sum + (vfs.read(p)?.length ?? 0), 0);
  const wfStateNow = loadState(vfs);

  // LLM quality score — optional, falls back to null
  let qualityScore = null;
  if (scorer && wf.description && newArtifacts.length > 0) {
    const artifactMap = Object.fromEntries(newArtifacts.map(p => [p, vfs.read(p) ?? '']));
    qualityScore = await scorer(wf.description, artifactMap).catch(() => null);
  }

  return {
    completed: allStepsDone,
    completedSteps: wfStateNow?.completedSteps?.length ?? 0,
    totalSteps: wf.steps.length,
    artifactCount: newArtifacts.length,
    artifactSize,
    errors,
    qualityScore,
  };
}

function workflowIsBetter(baseline, experiment) {
  if (!experiment.completed) return false;
  if (!baseline.completed) return true;
  // Prefer LLM quality score when both have one
  if (baseline.qualityScore !== null && experiment.qualityScore !== null) {
    return experiment.qualityScore > baseline.qualityScore;
  }
  // Fall back to artifact count/size heuristic
  if (experiment.artifactCount > baseline.artifactCount) return true;
  if (experiment.artifactCount < baseline.artifactCount) return false;
  if (experiment.artifactSize > baseline.artifactSize) return true;
  if (experiment.artifactSize < baseline.artifactSize) return false;
  return experiment.errors <= baseline.errors;
}

function buildWorkflowMutatePrompt(wfName, metrics) {
  const qualityLine = metrics.qualityScore !== null
    ? `  quality:    ${metrics.qualityScore}/10 (LLM-judged)`
    : `  quality:    (not scored)`;
  return [
    `Read /workflows/${wfName}.json — this is the current workflow definition.`,
    ``,
    `Last run metrics:`,
    `  completed:  ${metrics.completed}`,
    `  steps done: ${metrics.completedSteps}/${metrics.totalSteps}`,
    `  artifacts:  ${metrics.artifactCount} file(s), ${metrics.artifactSize} bytes total`,
    `  errors:     ${metrics.errors}`,
    qualityLine,
    ``,
    `Improve the workflow so it completes more reliably and produces richer artifacts:`,
    `- Make step prompts more specific — include exact output file paths`,
    `- If a step is too vague, add directive instructions or split it`,
    `- Ensure each step has one clear, measurable deliverable`,
    `- Keep 3-6 steps; merge trivial steps, split overloaded ones`,
    ``,
    `Write the improved workflow back to /workflows/${wfName}.json.`,
    `Do NOT execute the steps — only improve the definition.`,
    `context.emit({ type: 'done', message: 'Workflow improved' })`,
  ].join('\n');
}

/**
 * Run the workflow RSI loop — iterates on the workflow JSON definition.
 *
 * Each experiment: run the workflow baseline → ask agent to improve the definition
 * → run experiment → keep/discard based on artifact quality.
 *
 * @param {object} opts
 * @param {string}   opts.wfName   — workflow name
 * @param {number}   opts.budget   — max experiments (default 3)
 * @param {object}   opts.state    — agent state
 * @param {object}   opts.deps     — { runTurn, ... }
 * @param {function} opts.log      — logger
 * @param {Function|null} opts.scorer — optional async (goal, artifactMap) → number (0-10);
 *   create with buildWorkflowScorer(llm) from the harness
 */
export async function runWorkflowRSI({ wfName, budget = 3, state, deps, log, scorer = null }) {
  log = log ?? (() => {});
  const { vfs } = state.context;
  const wfPath = `/workflows/${wfName}.json`;
  const results = [];

  log(`\n═══ WORKFLOW RSI: ${wfName} — ${budget} experiments ═══\n`);

  for (let i = 0; i < budget; i++) {
    log(`\n─── experiment ${i + 1}/${budget} ───\n`);

    const wfRaw = vfs.read(wfPath);
    if (!wfRaw) { log('workflow not found — aborting'); break; }
    let wf;
    try { wf = JSON.parse(wfRaw); }
    catch { log('invalid workflow JSON — aborting'); break; }

    // Snapshot
    const snap = wfRaw;
    const savedHistory = [...state.history];
    const savedTurn = state.turn;

    // Baseline eval
    state.history = [];
    state.turn = 0;
    log('running baseline eval...');
    const baseline = await runWorkflowEval(wfName, wf, state, deps, vfs, scorer);
    const bQuality = baseline.qualityScore !== null ? ` quality=${baseline.qualityScore}/10` : '';
    log(`baseline: completed=${baseline.completed} steps=${baseline.completedSteps}/${baseline.totalSteps} artifacts=${baseline.artifactCount} size=${baseline.artifactSize} errors=${baseline.errors}${bQuality}`);

    // Mutation turn
    state.history = [];
    state.turn = 0;
    log('asking agent to improve workflow...');
    await deps.runTurn(buildWorkflowMutatePrompt(wfName, baseline), state, deps);

    // Validate mutation
    const mutatedRaw = vfs.read(wfPath);
    let mutated;
    const discard = (reason) => {
      vfs.write(wfPath, snap);
      state.history = savedHistory;
      state.turn = savedTurn;
      const entry = { ts: new Date().toISOString(), kept: false, reason, target: `workflow:${wfName}`, baseline: null, experiment: null };
      const existing = vfs.read('/memory/experiments.jsonl') ?? '';
      vfs.write('/memory/experiments.jsonl', existing + JSON.stringify(entry) + '\n');
      state.context.emit({ type: 'experiment', id: entry.ts, kept: false, reason });
      results.push({ kept: false, reason });
    };

    if (!mutatedRaw) { log('workflow deleted — discarding'); discard('workflow deleted'); continue; }
    try { mutated = JSON.parse(mutatedRaw); }
    catch { log('invalid JSON after mutation — discarding'); discard('invalid JSON'); continue; }
    if (!mutated.steps?.length) { log('no steps after mutation — discarding'); discard('no steps'); continue; }
    log('mutation validated ✓');

    // Experiment eval
    state.history = [];
    state.turn = 0;
    log('running experiment eval...');
    const experiment = await runWorkflowEval(wfName, mutated, state, deps, vfs, scorer);
    const eQuality = experiment.qualityScore !== null ? ` quality=${experiment.qualityScore}/10` : '';
    log(`experiment: completed=${experiment.completed} steps=${experiment.completedSteps}/${experiment.totalSteps} artifacts=${experiment.artifactCount} size=${experiment.artifactSize} errors=${experiment.errors}${eQuality}`);

    const kept = workflowIsBetter(baseline, experiment);
    const qualityDelta = (baseline.qualityScore !== null && experiment.qualityScore !== null)
      ? `, quality ${baseline.qualityScore}→${experiment.qualityScore}/10`
      : '';
    const reason = kept
      ? `improved: artifacts ${baseline.artifactCount}→${experiment.artifactCount}, size ${baseline.artifactSize}→${experiment.artifactSize}${qualityDelta}`
      : `reverted: artifacts ${baseline.artifactCount}→${experiment.artifactCount}, size ${baseline.artifactSize}→${experiment.artifactSize}${qualityDelta}`;

    if (!kept) {
      vfs.write(wfPath, snap);
      log('discarded — workflow restored');
    } else {
      if (state.context.commit) await state.context.commit(`workflow RSI: ${wfName} — ${reason}`);
      log('kept — workflow improved and committed');
    }

    const entry = { ts: new Date().toISOString(), kept, reason, target: `workflow:${wfName}`, baseline, experiment };
    const existing = vfs.read('/memory/experiments.jsonl') ?? '';
    vfs.write('/memory/experiments.jsonl', existing + JSON.stringify(entry) + '\n');
    state.context.emit({ type: 'experiment', id: entry.ts, kept, reason });

    state.history = savedHistory;
    state.turn = savedTurn;
    results.push({ kept, baseline, experiment, reason });

    const keptCount = results.filter(r => r.kept).length;
    log(`running total: ${keptCount} kept, ${results.length - keptCount} discarded`);
  }

  log(`\n═══ WORKFLOW RSI COMPLETE: ${results.filter(r => r.kept).length}/${results.length} kept ═══\n`);
  return results;
}

// ════════════════════════════════════════════════════
// LLM SCORER FACTORY
// ════════════════════════════════════════════════════

/**
 * Build an LLM-based quality scorer for workflow RSI.
 *
 * @param {object} llm — LLM client with .call(messages, system) method
 * @returns {Function} async (goal, artifactMap) → number (0-10)
 *
 * Usage:
 *   import { getLLMClient } from './llm-client.js';
 *   const scorer = buildWorkflowScorer(getLLMClient());
 *   await runWorkflowRSI({ ..., scorer });
 */
export function buildWorkflowScorer(llm) {
  return async function scorer(goal, artifactMap) {
    const entries = Object.entries(artifactMap);
    if (entries.length === 0) return 0;

    // Truncate each artifact to keep the prompt manageable
    const preview = entries
      .map(([p, t]) => `### ${p}\n${t.slice(0, 2000)}${t.length > 2000 ? '\n[truncated]' : ''}`)
      .join('\n\n');

    const data = await llm.call(
      [{
        role: 'user',
        content: `Workflow goal: ${goal}\n\nArtifacts produced:\n${preview}\n\nRate the quality of these artifacts on a scale of 0-10:\n- 0: nothing useful produced\n- 5: partial, some requirements met\n- 10: fully meets the goal with high quality\n\nRespond ONLY with JSON: {"score": <number>, "reason": "<one sentence>"}`,
      }],
      'You are an objective evaluator of automated agent workflow outputs. Be concise and fair.'
    );

    const text = data?.content?.[0]?.text ?? '{}';
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return 5;
    try {
      const parsed = JSON.parse(match[0]);
      return typeof parsed.score === 'number' ? Math.max(0, Math.min(10, parsed.score)) : 5;
    } catch {
      return 5;
    }
  };
}
