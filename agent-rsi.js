/**
 * agent-rsi.js — Recursive Self-Improvement experiment runner
 *
 * Orchestrates the autoresearch-style loop:
 *   1. Snapshot /harness/* state (baseline)
 *   2. Run eval task → collect baseline metrics
 *   3. Ask agent to mutate /harness/agent-loop.js
 *   4. Run eval task again → collect experiment metrics
 *   5. Compare → keep (commit) or discard (restore snapshot)
 *   6. Log result to /memory/experiments.jsonl
 *   7. Repeat up to budget
 *
 * See ADR.md Decision 11.
 *
 * Exports: runExperiment, runRSI
 */

// ════════════════════════════════════════════════════
// EVAL RUNNER
// ════════════════════════════════════════════════════

/**
 * Run an eval task and return metrics.
 *
 * An eval is: send a prompt, count turns/retries/errors, check for 'done'.
 * Returns { turns, retries, errors, completed, durationMs }.
 */
async function runEval(evalPrompt, state, deps) {
  const { runTurn } = deps;
  const metrics = { turns: 0, retries: 0, errors: 0, completed: false, durationMs: 0 };
  const start = Date.now();

  // Save original emit to intercept events
  const origEmit = state.context.emit;
  state.context.emit = (ev) => {
    if (ev.type === 'error') metrics.errors++;
    if (ev.type === 'done') metrics.completed = true;
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

  // Restore
  state.context.emit = origEmit;
  deps.ui.onRetry = origOnRetry;

  return metrics;
}

// ════════════════════════════════════════════════════
// SCORING
// ════════════════════════════════════════════════════

/**
 * Compare experiment metrics to baseline.
 * Returns true if the experiment is at least as good.
 *
 * Better = completed && (fewer errors OR fewer retries OR faster)
 */
function isBetter(baseline, experiment) {
  // Must complete to be considered
  if (!experiment.completed) return false;
  if (!baseline.completed) return true; // anything beats a failure

  // Prefer fewer errors, then fewer retries, then faster
  if (experiment.errors < baseline.errors) return true;
  if (experiment.errors > baseline.errors) return false;
  if (experiment.retries < baseline.retries) return true;
  if (experiment.retries > baseline.retries) return false;
  return experiment.durationMs <= baseline.durationMs;
}

// ════════════════════════════════════════════════════
// EXPERIMENT LOOP
// ════════════════════════════════════════════════════

/**
 * Run a single RSI experiment.
 *
 * @param {object} opts
 * @param {string} opts.evalPrompt    — The task to evaluate harness quality
 * @param {string} opts.mutatePrompt  — Instructions for the agent to improve the harness
 * @param {object} opts.state         — Agent state (history, turn, context)
 * @param {object} opts.deps          — { llm, execute, extractCode, runTurn, ui }
 * @param {function} opts.log         — Logging function (msg => void)
 * @returns {{ kept: boolean, baseline: object, experiment: object, reason: string }}
 */
export async function runExperiment({ evalPrompt, mutatePrompt, state, deps, log }) {
  const { vfs } = state.context;
  log = log ?? (() => {});

  // 1. Snapshot harness state
  const snap = vfs.snapshot('/harness/');
  log('snapshot saved');

  // 2. Run baseline eval (fresh history)
  const savedHistory = [...state.history];
  const savedTurn = state.turn;
  state.history = [];
  state.turn = 0;

  log('running baseline eval...');
  const baseline = await runEval(evalPrompt, state, deps);
  log(`baseline: completed=${baseline.completed} errors=${baseline.errors} retries=${baseline.retries} ${baseline.durationMs}ms`);

  // 3. Reset for mutation turn
  state.history = [];
  state.turn = 0;

  log('asking agent to mutate harness...');
  await deps.runTurn(mutatePrompt, state, deps);
  log('mutation applied');

  // 4. Run experiment eval
  state.history = [];
  state.turn = 0;

  log('running experiment eval...');
  const experiment = await runEval(evalPrompt, state, deps);
  log(`experiment: completed=${experiment.completed} errors=${experiment.errors} retries=${experiment.retries} ${experiment.durationMs}ms`);

  // 5. Compare and decide
  const kept = isBetter(baseline, experiment);
  const reason = kept
    ? `improved: errors ${baseline.errors}→${experiment.errors}, retries ${baseline.retries}→${experiment.retries}`
    : `reverted: errors ${baseline.errors}→${experiment.errors}, retries ${baseline.retries}→${experiment.retries}`;

  if (!kept) {
    vfs.restore(snap);
    log('discarded — harness restored to snapshot');
  } else {
    // Persist kept experiments via commit
    if (state.context.commit) {
      await state.context.commit(`RSI: ${reason}`);
    }
    log('kept — harness updated and committed');
  }

  // 6. Log to experiments journal
  const entry = {
    ts: new Date().toISOString(),
    kept,
    reason,
    baseline: { ...baseline },
    experiment: { ...experiment },
  };

  const journalPath = '/memory/experiments.jsonl';
  const existing = vfs.read(journalPath) ?? '';
  vfs.write(journalPath, existing + JSON.stringify(entry) + '\n');

  // Emit
  state.context.emit({ type: 'experiment', id: entry.ts, kept, reason });
  state.context.emit({ type: 'metric', name: 'baseline_errors', value: baseline.errors, unit: 'count' });
  state.context.emit({ type: 'metric', name: 'experiment_errors', value: experiment.errors, unit: 'count' });

  // 7. Restore conversation state
  state.history = savedHistory;
  state.turn = savedTurn;

  return { kept, baseline, experiment, reason };
}

// ════════════════════════════════════════════════════
// RSI LOOP (runs N experiments)
// ════════════════════════════════════════════════════

/**
 * Run the full RSI loop.
 *
 * @param {object} opts
 * @param {string}   opts.evalPrompt    — Eval task
 * @param {string}   opts.mutatePrompt  — Mutation instructions
 * @param {number}   opts.budget        — Max experiments (default 5)
 * @param {object}   opts.state         — Agent state
 * @param {object}   opts.deps          — Dependencies
 * @param {function} opts.log           — Logger
 * @returns {object[]} Array of experiment results
 */
export async function runRSI({ evalPrompt, mutatePrompt, budget = 5, state, deps, log }) {
  log = log ?? (() => {});
  const results = [];

  log(`\n═══ RSI LOOP: ${budget} experiments ═══\n`);

  for (let i = 0; i < budget; i++) {
    log(`\n─── experiment ${i + 1}/${budget} ───\n`);

    const result = await runExperiment({ evalPrompt, mutatePrompt, state, deps, log });
    results.push(result);

    const kept = results.filter(r => r.kept).length;
    const discarded = results.filter(r => !r.kept).length;
    log(`\nrunning total: ${kept} kept, ${discarded} discarded`);
  }

  log(`\n═══ RSI COMPLETE: ${results.filter(r => r.kept).length}/${results.length} experiments kept ═══\n`);

  return results;
}
