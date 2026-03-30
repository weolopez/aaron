/**
 * agent-rsi.js — Recursive Self-Improvement experiment runner
 *
 * Orchestrates the skill RSI autoresearch-style loop:
 *   1. Snapshot /skills/* state (baseline)
 *   2. Run eval task → collect baseline metrics
 *   3. Ask agent to mutate /skills/<name>/SKILL.md
 *   4. Run eval task again → collect experiment metrics
 *   5. Compare (LLM quality score preferred, heuristic fallback) → keep or discard
 *   6. Log result to /memory/experiments.jsonl
 *   7. Repeat up to budget
 *
 * See ADR.md Decision 11, Decision 13.
 *
 * Exports: runSkillExperiment, runSkillRSI, buildSkillScorer
 */

import { buildSkillIndex } from './agent-loop.js';
import { createGitHubClient, commitToGitHub } from '../runtime/github.js';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

// ════════════════════════════════════════════════════
// EVAL RUNNER
// ════════════════════════════════════════════════════

/**
 * Run an eval task and return metrics.
 *
 * An eval is: send a prompt, count turns/retries/errors, check for 'done'.
 * Returns { turns, retries, errors, completed, durationMs, output }.
 */
async function runEval(evalPrompt, state, deps) {
  const { runTurn } = deps;
  const metrics = { turns: 0, retries: 0, errors: 0, completed: false, durationMs: 0 };
  const outputParts = [];
  const start = Date.now();

  // Save original emit to intercept events
  const origEmit = state.context.emit;
  state.context.emit = (ev) => {
    if (ev.type === 'error') metrics.errors++;
    if (ev.type === 'done') metrics.completed = true;
    if (ev.type === 'progress' || ev.type === 'done' || ev.type === 'result') {
      outputParts.push(ev.message ?? JSON.stringify(ev.value ?? ''));
    }
    origEmit(ev);
  };

  // Save original onRetry
  const origOnRetry = deps.ui.onRetry;
  deps.ui.onRetry = (attempt, max) => {
    metrics.retries++;
    origOnRetry.call(deps.ui, attempt, max);
  };

  try {
    await runTurn(evalPrompt, state, deps);
    metrics.turns = state.turn;
  } catch {
    // runTurn failed entirely
  }

  metrics.durationMs = Date.now() - start;
  metrics.output = outputParts.join('\n');

  // Restore
  state.context.emit = origEmit;
  deps.ui.onRetry = origOnRetry;

  return metrics;
}

// ════════════════════════════════════════════════════
// SCORING
// ════════════════════════════════════════════════════

/**
 * Heuristic comparison: fewer errors → fewer retries → faster.
 */
function heuristicIsBetter(baseline, experiment) {
  if (!experiment.completed) return false;
  if (!baseline.completed) return true;

  if (experiment.errors < baseline.errors) return true;
  if (experiment.errors > baseline.errors) return false;
  if (experiment.retries < baseline.retries) return true;
  if (experiment.retries > baseline.retries) return false;
  return experiment.durationMs <= baseline.durationMs;
}

/**
 * Compare skill experiment metrics to baseline.
 * Prefers LLM quality score when available; falls back to heuristic.
 */
function skillIsBetter(baseline, experiment) {
  if (!experiment.completed) return false;
  if (!baseline.completed) return true;

  if (typeof baseline.qualityScore === 'number' && typeof experiment.qualityScore === 'number') {
    return experiment.qualityScore > baseline.qualityScore;
  }

  return heuristicIsBetter(baseline, experiment);
}

/**
 * Build an LLM-based skill quality scorer.
 * Returns async function(skillGoal, output) → number (0-10) | null.
 *
 * Modeled after buildWorkflowScorer in workflow-runner.js.
 */
export function buildSkillScorer(llm) {
  return async function scorer(skillGoal, output) {
    if (!output || output.length === 0) return 0;

    const preview = output.slice(0, 2000) + (output.length > 2000 ? '\n[truncated]' : '');

    const data = await llm.call(
      [{
        role: 'user',
        content: `Skill goal: ${skillGoal}\n\nAgent output from eval run:\n${preview}\n\nRate the quality of this output on a scale of 0-10:\n- 0: nothing useful produced\n- 5: partial, some requirements met\n- 10: fully meets the goal with high quality\n\nRespond ONLY with JSON: {"score": <number>, "reason": "<one sentence>"}`,
      }],
      'You are an objective evaluator of automated agent skill outputs. Be concise and fair.'
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

// ════════════════════════════════════════════════════
// SKILL CONTRACT VALIDATION
// ════════════════════════════════════════════════════

/**
 * Validate a SKILL.md file meets the agentskills.io contract.
 * Returns { valid: true } or { valid: false, violations: string[] }.
 */
function validateSkill(content, expectedName) {
  const violations = [];

  // Must have YAML frontmatter
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    violations.push('Missing YAML frontmatter (---\\n...\\n---)');
    return { valid: false, violations };
  }

  const yaml = fmMatch[1];
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const desc = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim();

  if (!name) violations.push('Missing required frontmatter field: name');
  if (!desc) violations.push('Missing required frontmatter field: description');
  if (name && expectedName && name !== expectedName) {
    violations.push(`Frontmatter name "${name}" does not match skill directory "${expectedName}"`);
  }

  // Must have substantive body content beyond frontmatter
  const body = content.slice(fmMatch[0].length).trim();
  if (body.length < 50) {
    violations.push('Skill body too short — needs substantive instructions (50+ chars)');
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Extract skill description from SKILL.md frontmatter.
 */
function getSkillDescription(vfs, skillName) {
  const content = vfs.read(`/skills/${skillName}/SKILL.md`);
  if (!content) return '';
  const match = content.match(/^description:\s*(.+)$/m);
  return match?.[1]?.trim() ?? '';
}

// ════════════════════════════════════════════════════
// SKILL EXPERIMENT LOOP
// ════════════════════════════════════════════════════

/**
 * Run a single skill RSI experiment.
 *
 * Same pattern as workflow RSI but targets /skills/* instead of /workflows/*.
 * Rebuilds skillIndex after mutation so the eval sees updated skills.
 *
 * @param {object} opts
 * @param {string} opts.evalPrompt    — The task to evaluate skill quality
 * @param {string} opts.skillName     — The skill directory name (e.g. 'component-builder')
 * @param {string} opts.mutatePrompt  — Instructions for the agent to improve the skill
 * @param {object} opts.state         — Agent state (history, turn, context)
 * @param {object} opts.deps          — { llm, execute, extractCode, runTurn, ui }
 * @param {function} opts.log         — Logging function
 * @param {function|null} opts.scorer — Optional LLM scorer: (goal, output) → 0-10
 * @returns {{ kept: boolean, baseline: object, experiment: object, reason: string }}
 */
export async function runSkillExperiment({ evalPrompt, skillName, mutatePrompt, state, deps, log, scorer = null }) {
  const { vfs } = state.context;
  log = log ?? (() => {});

  // 1. Snapshot skills state
  const snap = vfs.snapshot('/skills/');
  const savedSkillIndex = state.context.skillIndex;
  log('snapshot saved (skills)');

  // Get skill description for scoring
  const skillGoal = getSkillDescription(vfs, skillName) || evalPrompt;

  // 2. Run baseline eval (fresh history)
  const savedHistory = [...state.history];
  const savedTurn = state.turn;
  state.history = [];
  state.turn = 0;

  log('running baseline eval...');
  const baseline = await runEval(evalPrompt, state, deps);
  log(`baseline: completed=${baseline.completed} errors=${baseline.errors} retries=${baseline.retries} ${baseline.durationMs}ms`);

  // Score baseline with LLM if scorer available
  if (scorer && baseline.output) {
    try {
      baseline.qualityScore = await scorer(skillGoal, baseline.output);
      log(`baseline quality score: ${baseline.qualityScore}/10`);
    } catch (e) {
      log(`baseline scoring failed: ${e.message}`);
      baseline.qualityScore = null;
    }
  }

  // 3. Reset for mutation turn
  state.history = [];
  state.turn = 0;

  log('asking agent to mutate skill...');
  await deps.runTurn(mutatePrompt, state, deps);
  log('mutation applied');

  // 3b. Validate skill contract
  const skillPath = `/skills/${skillName}/SKILL.md`;
  const mutatedContent = vfs.read(skillPath);

  if (!mutatedContent) {
    log('skill file missing after mutation — discarding');
    vfs.restore(snap);
    state.context.skillIndex = savedSkillIndex;
    state.history = savedHistory;
    state.turn = savedTurn;

    const reason = 'contract: skill file missing after mutation';
    const entry = { ts: new Date().toISOString(), kept: false, reason, target: `skill:${skillName}`, baseline: null, experiment: null };
    const existing = vfs.read('/memory/experiments.jsonl') ?? '';
    vfs.write('/memory/experiments.jsonl', existing + JSON.stringify(entry) + '\n');
    state.context.emit({ type: 'experiment', id: entry.ts, kept: false, reason });
    return { kept: false, baseline: null, experiment: null, reason };
  }

  const check = validateSkill(mutatedContent, skillName);
  if (!check.valid) {
    log(`skill contract violated — ${check.violations.length} issue(s):`);
    for (const v of check.violations) log(`  ✕ ${v}`);
    vfs.restore(snap);
    state.context.skillIndex = savedSkillIndex;
    state.history = savedHistory;
    state.turn = savedTurn;

    const reason = `contract: ${check.violations.join('; ')}`;
    const entry = { ts: new Date().toISOString(), kept: false, reason, target: `skill:${skillName}`, baseline: null, experiment: null, contractViolations: check.violations };
    const existing = vfs.read('/memory/experiments.jsonl') ?? '';
    vfs.write('/memory/experiments.jsonl', existing + JSON.stringify(entry) + '\n');
    state.context.emit({ type: 'experiment', id: entry.ts, kept: false, reason });
    return { kept: false, baseline: null, experiment: null, reason };
  }
  log('skill contract validated ✓');

  // 3c. Rebuild skill index so experiment eval sees updated skills
  state.context.skillIndex = buildSkillIndex(vfs);
  log('skill index rebuilt');

  // 4. Run experiment eval
  state.history = [];
  state.turn = 0;

  log('running experiment eval...');
  const experiment = await runEval(evalPrompt, state, deps);
  log(`experiment: completed=${experiment.completed} errors=${experiment.errors} retries=${experiment.retries} ${experiment.durationMs}ms`);

  // Score experiment with LLM if scorer available
  if (scorer && experiment.output) {
    try {
      experiment.qualityScore = await scorer(skillGoal, experiment.output);
      log(`experiment quality score: ${experiment.qualityScore}/10`);
    } catch (e) {
      log(`experiment scoring failed: ${e.message}`);
      experiment.qualityScore = null;
    }
  }

  // 5. Compare and decide
  const kept = skillIsBetter(baseline, experiment);
  const hasScores = typeof baseline.qualityScore === 'number' && typeof experiment.qualityScore === 'number';
  const reason = kept
    ? hasScores
      ? `improved: quality ${baseline.qualityScore}→${experiment.qualityScore}, errors ${baseline.errors}→${experiment.errors}`
      : `improved: errors ${baseline.errors}→${experiment.errors}, retries ${baseline.retries}→${experiment.retries}`
    : hasScores
      ? `reverted: quality ${baseline.qualityScore}→${experiment.qualityScore}, errors ${baseline.errors}→${experiment.errors}`
      : `reverted: errors ${baseline.errors}→${experiment.errors}, retries ${baseline.retries}→${experiment.retries}`;

  if (!kept) {
    vfs.restore(snap);
    state.context.skillIndex = savedSkillIndex;
    log('discarded — skills restored to snapshot');
  } else {
    if (state.context.commit) {
      await state.context.commit(`RSI skill: ${reason}`);
    }
    log('kept — skill updated and committed');
  }

  // 6. Log to experiments journal
  const entry = {
    ts: new Date().toISOString(),
    kept,
    reason,
    target: `skill:${skillName}`,
    baseline: { ...baseline, output: undefined },
    experiment: { ...experiment, output: undefined },
  };

  const journalPath = '/memory/experiments.jsonl';
  const existing = vfs.read(journalPath) ?? '';
  vfs.write(journalPath, existing + JSON.stringify(entry) + '\n');

  state.context.emit({ type: 'experiment', id: entry.ts, kept, reason });
  state.context.emit({ type: 'metric', name: 'baseline_errors', value: baseline.errors, unit: 'count' });
  state.context.emit({ type: 'metric', name: 'experiment_errors', value: experiment.errors, unit: 'count' });

  // 7. Restore conversation state
  state.history = savedHistory;
  state.turn = savedTurn;

  return { kept, baseline, experiment, reason };
}

// ════════════════════════════════════════════════════
// SKILL RSI LOOP
// ════════════════════════════════════════════════════

/**
 * Run the full skill RSI loop.
 *
 * @param {object} opts
 * @param {string}   opts.evalPrompt    — Eval task
 * @param {string}   opts.skillName     — Skill directory name
 * @param {string}   opts.mutatePrompt  — Mutation instructions
 * @param {number}   opts.budget        — Max experiments (default 5)
 * @param {object}   opts.state         — Agent state
 * @param {object}   opts.deps          — Dependencies
 * @param {function} opts.log           — Logger
 * @param {function|null} opts.scorer   — Optional LLM scorer
 * @returns {object[]} Array of experiment results
 */
export async function runSkillRSI({ evalPrompt, skillName, mutatePrompt, budget = 5, state, deps, log, scorer = null }) {
  log = log ?? (() => {});
  const results = [];

  // GitHub branch isolation for skill RSI
  const gh = state.context.github;
  let ghClient = null;
  let rsiBranch = null;
  if (gh && process.env?.GITHUB_TOKEN) {
    ghClient = createGitHubClient({ token: process.env.GITHUB_TOKEN });
    rsiBranch = `rsi/skill-${skillName}-${Date.now()}`;
    try {
      const ref = await ghClient.getBranch(gh.owner, gh.repo, gh.ref || 'main');
      if (ref) {
        await ghClient.createBranch(gh.owner, gh.repo, rsiBranch, ref.sha);
        log(`GitHub branch created: ${rsiBranch}`);
      }
    } catch (e) {
      log(`GitHub branch creation failed: ${e.message} — continuing without branch isolation`);
      rsiBranch = null;
    }
  }

  log(`\n═══ SKILL RSI: ${skillName} — ${budget} experiments${scorer ? ' (LLM scoring)' : ' (heuristic scoring)'}${rsiBranch ? ` → ${rsiBranch}` : ''} ═══\n`);

  for (let i = 0; i < budget; i++) {
    log(`\n─── experiment ${i + 1}/${budget} ───\n`);

    const result = await runSkillExperiment({ evalPrompt, skillName, mutatePrompt, state, deps, log, scorer });
    results.push(result);

    const kept = results.filter(r => r.kept).length;
    const discarded = results.filter(r => !r.kept).length;
    log(`\nrunning total: ${kept} kept, ${discarded} discarded`);
  }

  log(`\n═══ SKILL RSI COMPLETE: ${results.filter(r => r.kept).length}/${results.length} experiments kept${rsiBranch ? ` (branch: ${rsiBranch})` : ''} ═══\n`);

  return results;
}
