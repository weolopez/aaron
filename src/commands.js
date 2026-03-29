/**
 * src/commands.js — Isomorphic command dispatcher
 *
 * Shared parsing and execution for colon-commands used by both
 * the CLI harness and the browser harness. Each function takes
 * platform-specific callbacks for display; all logic is isomorphic.
 */

import {
  listWorkflows,
  buildCreatePrompt,
  buildImprovePrompt,
  runWorkflowSteps,
  runWorkflowRSI,
  buildWorkflowScorer,
} from './workflow-runner.js';

// ════════════════════════════════════════════════════
// WORKFLOW COMMAND
// ════════════════════════════════════════════════════

/**
 * Parse the args after `:workflow `.
 *
 * @param {string} args - everything after `:workflow ` (trimmed)
 * @returns {{ action: string, name?: string, goal?: string, feedback?: string, budget?: number, error?: string }}
 */
export function parseWorkflowArgs(args) {
  if (!args || args === 'list') return { action: 'list' };

  if (args.startsWith('create ')) {
    const rest = args.slice(7).trim();
    const sp = rest.indexOf(' ');
    if (sp === -1) return { action: 'error', error: 'Usage: :workflow create <name> <goal description>' };
    return { action: 'create', name: rest.slice(0, sp), goal: rest.slice(sp + 1).trim() };
  }

  if (args.startsWith('improve ')) {
    const rest = args.slice(8).trim();
    const sp = rest.indexOf(' ');
    if (sp === -1) return { action: 'error', error: 'Usage: :workflow improve <name> <feedback>' };
    return { action: 'improve', name: rest.slice(0, sp), feedback: rest.slice(sp + 1).trim() };
  }

  if (args.startsWith('rsi ')) {
    const rest = args.slice(4).trim();
    const parts = rest.split(/\s+/);
    if (!parts[0]) return { action: 'error', error: 'Usage: :workflow rsi <name> [budget]' };
    return { action: 'rsi', name: parts[0], budget: parseInt(parts[1], 10) || 3 };
  }

  return { action: 'run', name: args };
}

/**
 * Execute a parsed workflow command.
 *
 * @param {object}   parsed       - from parseWorkflowArgs()
 * @param {object}   opts
 * @param {object}   opts.vfs
 * @param {object}   opts.state
 * @param {object}   opts.deps        - { execute, extractCode, ui, runTurn }
 * @param {Function} opts.getLLMClient - () => llmClient
 * @param {object}   opts.callbacks   - platform-specific display hooks
 *
 * callbacks shape:
 *   onError(msg)                    — display an error
 *   onNotFound(name)                — workflow not found
 *   onList(workflows)               — display workflow list
 *   onUserMsg(text)                 — echo user command
 *   onRSIStart(name, budget)        — RSI starting
 *   onRSILog(msg)                   — RSI progress line (optional, defaults to noop)
 *   onRSIDone(results)              — RSI finished
 *   onRunStart(name, done, total)   — workflow run starting
 *   stepCallbacks                   — passed to runWorkflowSteps()
 *
 * @returns {Promise<{ ok: boolean, data?: any }>}
 */
export async function executeWorkflowCommand(parsed, { vfs, state, deps, getLLMClient, callbacks }) {
  const { runTurn } = deps;

  switch (parsed.action) {
    case 'error':
      callbacks.onError(parsed.error);
      return { ok: false };

    case 'list': {
      const workflows = listWorkflows(vfs);
      callbacks.onList(workflows);
      return { ok: true, data: workflows };
    }

    case 'create': {
      callbacks.onUserMsg(`:workflow create ${parsed.name} ${parsed.goal}`);
      await runTurn(buildCreatePrompt(parsed.name, parsed.goal), state, deps);
      return { ok: true };
    }

    case 'improve': {
      if (!vfs.read(`/workflows/${parsed.name}.json`)) {
        callbacks.onNotFound(parsed.name);
        return { ok: false };
      }
      callbacks.onUserMsg(`:workflow improve ${parsed.name} "${parsed.feedback}"`);
      await runTurn(buildImprovePrompt(parsed.name, parsed.feedback), state, deps);
      return { ok: true };
    }

    case 'rsi': {
      if (!vfs.read(`/workflows/${parsed.name}.json`)) {
        callbacks.onNotFound(parsed.name);
        return { ok: false };
      }
      callbacks.onRSIStart(parsed.name, parsed.budget);
      const scorer = buildWorkflowScorer(getLLMClient());
      const log = callbacks.onRSILog || (() => {});
      const results = await runWorkflowRSI({
        wfName: parsed.name, budget: parsed.budget, state, deps, log, scorer,
      });
      callbacks.onRSIDone(results);
      return { ok: true, data: results };
    }

    case 'run': {
      const wfRaw = vfs.read(`/workflows/${parsed.name}.json`);
      if (!wfRaw) {
        callbacks.onNotFound(parsed.name);
        return { ok: false };
      }
      let wf;
      try { wf = JSON.parse(wfRaw); } catch {
        callbacks.onError(`Invalid workflow JSON: /workflows/${parsed.name}.json`);
        return { ok: false };
      }
      const doneCount = (() => {
        try {
          return JSON.parse(vfs.read('/scratch/workflow-state.json') || 'null')?.completedSteps?.length ?? 0;
        } catch { return 0; }
      })();
      callbacks.onRunStart(parsed.name, doneCount, wf.steps.length);
      await runWorkflowSteps(wf, parsed.name, vfs, state, deps, callbacks.stepCallbacks);
      return { ok: true };
    }
  }

  return { ok: false };
}

/**
 * Convenience: parse + execute in one call.
 */
export async function dispatchWorkflowCommand(args, opts) {
  const parsed = parseWorkflowArgs(args);
  return executeWorkflowCommand(parsed, opts);
}
