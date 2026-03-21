#!/usr/bin/env node
/**
 * agent-harness.mjs — CLI harness
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node agent-harness.mjs
 *
 * Requires Node 18+ (native fetch + AsyncFunction)
 */

import readline from 'node:readline/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output, env } from 'node:process';
import { createVFS, execute, createLLMClient, extractCode } from './agent-core.js';
import { runTurn } from './agent-loop.js';
import { runRSI } from './agent-rsi.js';

// ════════════════════════════════════════════════════
// ANSI
// ════════════════════════════════════════════════════

const A = {
  reset:  '\x1b[0m',
  dim:    '\x1b[2m',
  bold:   '\x1b[1m',
  amber:  '\x1b[33m',
  cyan:   '\x1b[36m',
  blue:   '\x1b[34m',
  red:    '\x1b[31m',
  gray:   '\x1b[90m',
  green:  '\x1b[32m',
  white:  '\x1b[97m',
};

const c = (color, str) => `${A[color]}${str}${A.reset}`;

// ════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════

const MODEL = 'claude-sonnet-4-20250514';
const API_KEY = env.ANTHROPIC_API_KEY ?? '';

const llm = createLLMClient({
  model: MODEL,
  headers: {
    'x-api-key': API_KEY,
    'anthropic-version': '2023-06-01',
  },
});

// ════════════════════════════════════════════════════
// CLI UI (implements UI adapter for runTurn)
// ════════════════════════════════════════════════════

const EV_ICONS = {
  progress:   c('blue',  '◆'),
  result:     c('cyan',  '→'),
  file_write: c('amber', '✦'),
  file_read:  c('gray',  '◇'),
  done:       c('green', '✓'),
  error:      c('red',   '✕'),
  metric:     c('blue',  '▪'),
  experiment: c('cyan',  '◉'),
};

const ui = {
  hr() {
    output.write(c('gray', '─'.repeat(60)) + '\n');
  },

  user(msg) {
    output.write('\n' + c('amber', 'you') + '\n');
    output.write(c('amber', msg) + '\n');
  },

  // ── UI adapter interface ──────────────────────────

  setStatus(s) {
    const colored =
      s === 'thinking' ? c('amber', s) :
      s === 'running'  ? c('cyan',  s) :
      s === 'error'    ? c('red',   s) :
                         c('gray',  s);
    output.write(c('gray', '\n[') + colored + c('gray', ']\n'));
  },

  showCode(code) {
    const lines = code.split('\n');
    output.write('\n' + c('cyan', `agent → executing  `) + c('gray', `(${lines.length} lines)`) + '\n');
    output.write(c('gray', '┌' + '─'.repeat(58) + '┐') + '\n');
    for (const line of lines) {
      output.write(c('gray', '│ ') + c('dim', line) + '\n');
    }
    output.write(c('gray', '└' + '─'.repeat(58) + '┘') + '\n');
  },

  emitEvent(ev) {
    const icon = EV_ICONS[ev.type] ?? c('gray', '·');
    let text = '';
    switch (ev.type) {
      case 'progress':   text = ev.message ?? ''; break;
      case 'result':     text = JSON.stringify(ev.value ?? null); break;
      case 'file_write': text = ev.path ?? ''; break;
      case 'file_read':  text = ev.path ?? ''; break;
      case 'done':       text = ev.message ?? 'done'; break;
      case 'error':      text = ev.message ?? 'error'; break;
      case 'metric':     text = `${ev.name}: ${ev.value} ${ev.unit ?? ''}`; break;
      case 'experiment': text = `${ev.kept ? 'kept' : 'discarded'}: ${ev.reason ?? ''}`; break;
      default:           text = JSON.stringify(ev);
    }
    const colored =
      ev.type === 'done'       ? c('green', text) :
      ev.type === 'error'      ? c('red',   text) :
      ev.type === 'file_write' ? c('amber', text) :
      ev.type === 'result'     ? c('white', text) :
                                 c('gray',  text);

    output.write(`  ${icon}  ${colored}\n`);
  },

  onRetry(attempt, max) {
    output.write(c('red', `\n  ↺ retry ${attempt}/${max}\n`));
  },

  onTurnComplete(turn, vfs) {
    this.showVFS(vfs);
    output.write(c('gray', `\nturn ${turn} complete\n`));
    this.hr();
  },

  // ── Non-adapter helpers ──────────────────────────

  showVFS(vfs) {
    const paths = vfs.list();
    if (paths.length === 0) return;
    output.write('\n' + c('gray', 'VFS') + '\n');
    for (const p of paths) {
      const dirty = vfs.isDirty(p);
      const bytes = vfs.size(p);
      const flag  = dirty ? c('amber', ' ●') : '';
      output.write(
        c('gray', '  ') +
        (dirty ? c('amber', p) : c('dim', p)) +
        c('gray', `  ${bytes}b`) +
        flag + '\n'
      );
    }
  },

  banner() {
    output.write('\n');
    output.write(c('amber', '  agent/harness') + c('gray', '  cli\n'));
    output.write(c('gray',  '  model: ') + c('dim', llm.model) + '\n');
    output.write(c('gray',  '  node:  ') + c('dim', process.version) + '\n');
    output.write('\n');
    output.write(c('gray', '  Commands:\n'));
    output.write(c('gray', '  :vfs   — list VFS contents\n'));
    output.write(c('gray', '  :cat   — :cat /path  show a file\n'));
    output.write(c('gray', '  :rsi   — run RSI experiment loop\n'));
    output.write(c('gray', '  :clear — reset conversation history\n'));
    output.write(c('gray', '  :exit  — quit\n'));
    output.write('\n');
    this.hr();
  },
};

// ════════════════════════════════════════════════════
// VFS HYDRATION (load harness code into VFS for RSI)
// ════════════════════════════════════════════════════

const __dirname = dirname(fileURLToPath(import.meta.url));

function hydrateHarness(vfs) {
  for (const f of ['agent-core.js', 'agent-loop.js', 'agent-rsi.js', 'agent-harness.mjs']) {
    try {
      const content = readFileSync(new URL(f, import.meta.url), 'utf8');
      vfs.write(`/harness/${f}`, content);
      vfs.markClean(`/harness/${f}`);
    } catch { /* file not found — skip */ }
  }
}

// VFS path → disk path mapping for commit
const VFS_DISK_MAP = {
  '/harness/': '',           // /harness/agent-loop.js → ./agent-loop.js
  '/memory/':  'memory/',    // /memory/experiments.jsonl → ./memory/experiments.jsonl
  '/artifacts/': 'artifacts/',
};

function vfsToDisk(vfsPath) {
  for (const [prefix, diskPrefix] of Object.entries(VFS_DISK_MAP)) {
    if (vfsPath.startsWith(prefix)) {
      return join(__dirname, diskPrefix, vfsPath.slice(prefix.length));
    }
  }
  return null; // unmapped paths don't get written to disk
}

function flushToDisk(vfs, paths) {
  const written = [];
  for (const p of paths) {
    const diskPath = vfsToDisk(p);
    if (!diskPath) continue;
    const content = vfs.read(p);
    if (content === null) continue;
    mkdirSync(dirname(diskPath), { recursive: true });
    writeFileSync(diskPath, content, 'utf8');
    written.push(p);
  }
  return written;
}

// ════════════════════════════════════════════════════
// REPL
// ════════════════════════════════════════════════════

async function repl() {
  if (!API_KEY) {
    output.write(c('red', '\nError: ANTHROPIC_API_KEY is not set.\n'));
    output.write(c('gray', 'Usage: ANTHROPIC_API_KEY=sk-ant-... node agent-harness.mjs\n\n'));
    process.exit(1);
  }

  ui.banner();

  const vfs = createVFS();
  hydrateHarness(vfs);

  const context = {
    vfs,
    fetch: (...args) => fetch(...args),
    emit:  (ev) => ui.emitEvent(ev),
    env:   {},
    async commit(message = 'commit') {
      const dirty = vfs.list().filter(p => vfs.isDirty(p));
      const written = flushToDisk(vfs, dirty);
      for (const p of dirty) vfs.markClean(p);
      context.emit({ type: 'experiment', id: String(Date.now()), kept: true, reason: message });
      if (written.length > 0) {
        context.emit({ type: 'progress', message: `flushed ${written.length} files to disk` });
      }
      return dirty;
    },
  };

  const state = {
    history: [],
    turn:    0,
    context,
  };

  const deps = { llm, execute, extractCode, ui, runTurn };

  const rsiLog = (msg) => output.write(c('cyan', `  rsi  `) + c('gray', msg) + '\n');

  const rl = readline.createInterface({ input, output, terminal: true });

  // Graceful exit
  rl.on('close', () => {
    output.write(c('gray', '\nbye\n\n'));
    process.exit(0);
  });

  while (true) {
    let msg;
    try {
      msg = await rl.question(c('amber', 'you') + c('gray', ' › '));
    } catch {
      break;
    }

    msg = msg.trim();
    if (!msg) continue;

    // Built-in commands
    if (msg === ':exit' || msg === ':quit') {
      rl.close();
      break;
    }

    if (msg === ':vfs') {
      ui.showVFS(vfs);
      if (vfs.list().length === 0) output.write(c('gray', '  (empty)\n'));
      continue;
    }

    if (msg.startsWith(':cat ')) {
      const path    = msg.slice(5).trim();
      const content = vfs.read(path);
      if (content === null) {
        output.write(c('red', `  not found: ${path}\n`));
      } else {
        output.write('\n' + c('amber', path) + '\n');
        output.write(c('gray', '─'.repeat(40)) + '\n');
        output.write(content + '\n');
        output.write(c('gray', '─'.repeat(40)) + '\n');
      }
      continue;
    }

    if (msg === ':clear') {
      state.history = [];
      output.write(c('gray', '  history cleared\n'));
      continue;
    }

    if (msg === ':rsi' || msg.startsWith(':rsi ')) {
      const args = msg.slice(4).trim();
      const budget = parseInt(args, 10) || 3;

      output.write('\n' + c('cyan', '  RSI mode') + '\n');
      output.write(c('gray', '  Enter the eval task (what the agent should accomplish):') + '\n');

      let evalPrompt;
      try {
        evalPrompt = await rl.question(c('cyan', 'eval') + c('gray', ' › '));
      } catch { break; }
      evalPrompt = evalPrompt.trim();
      if (!evalPrompt) { output.write(c('gray', '  cancelled\n')); continue; }

      const mutatePrompt = [
        'Read /harness/agent-loop.js — this is your own harness code.',
        'Analyze the SYSTEM prompt and the runTurn function.',
        'Propose ONE targeted improvement that could help the agent complete tasks more reliably (fewer errors, fewer retries, clearer instructions).',
        'Write the improved version back to /harness/agent-loop.js.',
        'Explain what you changed and why in a progress emit before the done emit.',
      ].join('\n');

      const results = await runRSI({
        evalPrompt,
        mutatePrompt,
        budget,
        state,
        deps,
        log: rsiLog,
      });

      const kept = results.filter(r => r.kept).length;
      output.write('\n' + c('cyan', `  RSI complete: ${kept}/${results.length} experiments kept`) + '\n');

      // Show final harness diff
      const currentLoop = state.context.vfs.read('/harness/agent-loop.js');
      if (currentLoop) {
        const lines = currentLoop.split('\n').length;
        output.write(c('gray', `  /harness/agent-loop.js: ${lines} lines`) + '\n');
      }

      // Show experiment journal
      const journal = state.context.vfs.read('/memory/experiments.jsonl');
      if (journal) {
        output.write(c('gray', `  /memory/experiments.jsonl: ${journal.split('\n').filter(Boolean).length} entries`) + '\n');
      }
      ui.hr();
      continue;
    }

    if (msg.startsWith(':')) {
      output.write(c('gray', `  unknown command: ${msg}\n`));
      continue;
    }

    ui.user(msg);
    await runTurn(msg, state, deps);
  }
}

repl().catch(err => {
  output.write(c('red', `\nFatal: ${err.message}\n`));
  process.exit(1);
});
