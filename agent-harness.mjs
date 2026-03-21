#!/usr/bin/env node
/**
 * agent-harness.mjs — CLI harness
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node agent-harness.mjs                # REPL mode
 *   ANTHROPIC_API_KEY=sk-ant-... node agent-harness.mjs "prompt here"  # single-shot
 *
 * Requires Node 18+ (native fetch + AsyncFunction)
 */

import readline from 'node:readline/promises';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output, env } from 'node:process';
import { createVFS, execute, createLLMClient, extractCode } from './agent-core.js';
import { runTurn, buildSkillIndex } from './agent-loop.js';
import { runRSI, runSkillRSI } from './agent-rsi.js';

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
    output.write(c('gray', '  :skill — run skill RSI experiment loop\n'));
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
  // Load harness source files
  for (const f of ['agent-core.js', 'agent-loop.js', 'agent-rsi.js', 'agent-harness.mjs']) {
    try {
      const content = readFileSync(new URL(f, import.meta.url), 'utf8');
      vfs.write(`/harness/${f}`, content);
      vfs.markClean(`/harness/${f}`);
    } catch { /* file not found — skip */ }
  }

  // Load artifacts from disk
  const artifactsDir = join(__dirname, 'artifacts');
  if (existsSync(artifactsDir)) {
    for (const f of readdirSync(artifactsDir)) {
      try {
        const content = readFileSync(join(artifactsDir, f), 'utf8');
        vfs.write(`/artifacts/${f}`, content);
        vfs.markClean(`/artifacts/${f}`);
      } catch { /* skip */ }
    }
  }

  // Load memory from disk
  const memoryDir = join(__dirname, 'memory');
  if (existsSync(memoryDir)) {
    for (const f of readdirSync(memoryDir)) {
      try {
        const content = readFileSync(join(memoryDir, f), 'utf8');
        vfs.write(`/memory/${f}`, content);
        vfs.markClean(`/memory/${f}`);
      } catch { /* skip */ }
    }
  }

  // Load skills from disk (recursive)
  loadDirToVFS(join(__dirname, 'skills'), '/skills/', vfs);
}

/** Recursively load a directory tree into VFS. */
function loadDirToVFS(baseDir, vfsPrefix, vfs) {
  if (!existsSync(baseDir)) return;
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    const diskPath = join(baseDir, entry.name);
    const vfsPath = vfsPrefix + entry.name;
    if (entry.isDirectory()) {
      loadDirToVFS(diskPath, vfsPath + '/', vfs);
    } else {
      try {
        vfs.write(vfsPath, readFileSync(diskPath, 'utf8'));
        vfs.markClean(vfsPath);
      } catch { /* skip */ }
    }
  }
}

/** Write a manifest of artifacts + memory + skills files for the browser harness to discover. */
function writeManifest() {
  const manifest = { artifacts: [], memory: [], skills: [] };
  const artifactsDir = join(__dirname, 'artifacts');
  if (existsSync(artifactsDir)) manifest.artifacts = readdirSync(artifactsDir);
  const memoryDir = join(__dirname, 'memory');
  if (existsSync(memoryDir)) manifest.memory = readdirSync(memoryDir);
  const skillsDir = join(__dirname, 'skills');
  if (existsSync(skillsDir)) {
    (function walk(dir, prefix) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name), prefix + entry.name + '/');
        else manifest.skills.push(prefix + entry.name);
      }
    })(skillsDir, '');
  }
  writeFileSync(join(__dirname, 'vfs-manifest.json'), JSON.stringify(manifest), 'utf8');
}

// VFS path → disk path mapping for commit
const VFS_DISK_MAP = {
  '/harness/': '',           // /harness/agent-loop.js → ./agent-loop.js
  '/memory/':  'memory/',    // /memory/experiments.jsonl → ./memory/experiments.jsonl
  '/artifacts/': 'artifacts/',
  '/skills/': 'skills/',
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
  writeManifest();

  const skillIndex = buildSkillIndex(vfs);

  const context = {
    vfs,
    fetch: (...args) => fetch(...args),
    emit:  (ev) => ui.emitEvent(ev),
    env:   {},
    skillIndex,
    async commit(message = 'commit') {
      const dirty = vfs.list().filter(p => vfs.isDirty(p));
      const written = flushToDisk(vfs, dirty);
      writeManifest();
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

    if (msg === ':skill' || msg.startsWith(':skill ')) {
      const args = msg.slice(6).trim();
      const budget = parseInt(args, 10) || 3;

      // List available skills
      const skillPaths = vfs.list().filter(p => p.startsWith('/skills/') && p.endsWith('/SKILL.md'));
      if (skillPaths.length > 0) {
        output.write('\n' + c('cyan', '  Available skills:') + '\n');
        for (const p of skillPaths) {
          const name = p.split('/')[2];
          output.write(c('gray', `    - ${name}`) + '\n');
        }
      }

      output.write(c('gray', '  Enter skill name to improve (or a new name to create):') + '\n');

      let skillName;
      try {
        skillName = await rl.question(c('cyan', 'skill') + c('gray', ' › '));
      } catch { break; }
      skillName = skillName.trim();
      if (!skillName) { output.write(c('gray', '  cancelled\n')); continue; }

      output.write(c('gray', '  Enter the eval task (what the agent should accomplish):') + '\n');

      let evalPrompt;
      try {
        evalPrompt = await rl.question(c('cyan', 'eval') + c('gray', ' › '));
      } catch { break; }
      evalPrompt = evalPrompt.trim();
      if (!evalPrompt) { output.write(c('gray', '  cancelled\n')); continue; }

      const skillPath = `/skills/${skillName}/SKILL.md`;
      const existing = vfs.read(skillPath);

      const mutatePrompt = existing
        ? [
            `Read /skills/${skillName}/SKILL.md — this is a skill that provides instructions for the agent.`,
            `Now analyze how an agent would approach this eval task: "${evalPrompt}"`,
            `Improve the skill instructions to help the agent complete this type of task more reliably.`,
            `Keep the YAML frontmatter (name, description) and agentskills.io format.`,
            `Write the improved version back to /skills/${skillName}/SKILL.md.`,
            'Explain what you changed and why in a progress emit before the done emit.',
          ].join('\n')
        : [
            `Create a new skill at /skills/${skillName}/SKILL.md that would help the agent with this type of task: "${evalPrompt}"`,
            'Follow the agentskills.io SKILL.md format:',
            '  - YAML frontmatter with name and description (---\\nname: ...\\ndescription: ...\\n---)',
            '  - Markdown body with approach, templates, checklists',
            `  - name in frontmatter must be: ${skillName}`,
            'Write the file, then explain what you created in a progress emit before the done emit.',
          ].join('\n');

      output.write('\n' + c('cyan', `  Skill RSI: ${skillName} (${existing ? 'improving' : 'creating'})`) + '\n');

      const results = await runSkillRSI({
        evalPrompt,
        skillName,
        mutatePrompt,
        budget,
        state,
        deps,
        log: rsiLog,
      });

      const kept = results.filter(r => r.kept).length;
      output.write('\n' + c('cyan', `  Skill RSI complete: ${kept}/${results.length} experiments kept`) + '\n');

      // Rebuild skill index to reflect final state
      state.context.skillIndex = buildSkillIndex(vfs);

      const finalSkill = vfs.read(skillPath);
      if (finalSkill) {
        const lines = finalSkill.split('\n').length;
        output.write(c('gray', `  /skills/${skillName}/SKILL.md: ${lines} lines`) + '\n');
      }

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

// ════════════════════════════════════════════════════
// SINGLE-SHOT MODE
// ════════════════════════════════════════════════════

function requireKey() {
  if (!API_KEY) {
    output.write(c('red', 'Error: ANTHROPIC_API_KEY is not set.\n'));
    process.exit(1);
  }
}

function createRunContext() {
  const vfs = createVFS();
  hydrateHarness(vfs);
  writeManifest();
  const skillIndex = buildSkillIndex(vfs);
  const rsiLog = (msg) => output.write(c('cyan', `  rsi  `) + c('gray', msg) + '\n');

  const context = {
    vfs,
    fetch: (...args) => fetch(...args),
    emit:  (ev) => ui.emitEvent(ev),
    env:   {},
    skillIndex,
    async commit(message = 'commit') {
      const dirty = vfs.list().filter(p => vfs.isDirty(p));
      const written = flushToDisk(vfs, dirty);
      writeManifest();
      for (const p of dirty) vfs.markClean(p);
      if (written.length > 0) {
        context.emit({ type: 'progress', message: `flushed ${written.length} files to disk` });
      }
      return dirty;
    },
  };

  const state = { history: [], turn: 0, context };
  const deps = { llm, execute, extractCode, ui, runTurn };
  return { vfs, state, deps, rsiLog };
}

async function run(prompt) {
  requireKey();
  const { state, deps } = createRunContext();
  ui.setStatus('thinking');
  await runTurn(prompt, state, deps);
}

// ════════════════════════════════════════════════════
// SKILL CLI
// ════════════════════════════════════════════════════

function skillUsage() {
  output.write('\n' + c('amber', '  aaron skill') + c('gray', ' — manage agent skills\n\n'));
  output.write(c('gray', '  Usage:\n'));
  output.write(c('gray', '    aaron skill list                          list available skills\n'));
  output.write(c('gray', '    aaron skill show <name>                   print a skill\'s SKILL.md\n'));
  output.write(c('gray', '    aaron skill create <name> "eval task"     create a new skill via RSI\n'));
  output.write(c('gray', '    aaron skill improve <name> "eval task"    improve an existing skill via RSI\n'));
  output.write(c('gray', '    aaron skill rsi <name> "eval task"        alias for improve (or create if new)\n'));
  output.write('\n');
  output.write(c('gray', '  Options:\n'));
  output.write(c('gray', '    --budget N   RSI experiment budget (default: 3)\n'));
  output.write('\n');
}

async function skillList() {
  const vfs = createVFS();
  hydrateHarness(vfs);

  const skillPaths = vfs.list().filter(p => p.startsWith('/skills/') && p.endsWith('/SKILL.md'));
  if (skillPaths.length === 0) {
    output.write(c('gray', '  No skills installed.\n'));
    output.write(c('gray', '  Create one: aaron skill create <name> "eval task"\n'));
    return;
  }

  output.write('\n' + c('cyan', '  Available skills:') + '\n\n');
  for (const p of skillPaths) {
    const name = p.split('/')[2];
    const content = vfs.read(p);
    const match = content?.match(/^description:\s*(.+)$/m);
    const desc = match?.[1]?.trim() ?? '';
    output.write(c('amber', `  ${name}`));
    if (desc) output.write(c('gray', `  — ${desc}`));
    output.write('\n');
  }
  output.write('\n');
}

async function skillShow(name) {
  const vfs = createVFS();
  hydrateHarness(vfs);

  const skillPath = `/skills/${name}/SKILL.md`;
  const content = vfs.read(skillPath);
  if (!content) {
    output.write(c('red', `  Skill not found: ${name}\n`));
    output.write(c('gray', '  Available: aaron skill list\n'));
    process.exit(1);
  }

  output.write('\n' + c('amber', skillPath) + '\n');
  output.write(c('gray', '─'.repeat(60)) + '\n');
  output.write(content + '\n');
  output.write(c('gray', '─'.repeat(60)) + '\n');
}

async function skillRSI(name, evalTask, budget, mode) {
  requireKey();
  const { vfs, state, deps, rsiLog } = createRunContext();

  const skillPath = `/skills/${name}/SKILL.md`;
  const existing = vfs.read(skillPath);

  if (mode === 'create' && existing) {
    output.write(c('red', `  Skill "${name}" already exists. Use 'aaron skill improve' instead.\n`));
    process.exit(1);
  }
  if (mode === 'improve' && !existing) {
    output.write(c('red', `  Skill "${name}" not found. Use 'aaron skill create' instead.\n`));
    process.exit(1);
  }

  const isCreate = !existing;

  const mutatePrompt = isCreate
    ? [
        `Create a new skill at /skills/${name}/SKILL.md that would help the agent with this type of task: "${evalTask}"`,
        'Follow the agentskills.io SKILL.md format:',
        '  - YAML frontmatter with name and description (---\\nname: ...\\ndescription: ...\\n---)',
        '  - Markdown body with approach, templates, checklists',
        `  - name in frontmatter must be: ${name}`,
        'Write the file, then explain what you created in a progress emit before the done emit.',
      ].join('\n')
    : [
        `Read /skills/${name}/SKILL.md — this is a skill that provides instructions for the agent.`,
        `Now analyze how an agent would approach this eval task: "${evalTask}"`,
        `Improve the skill instructions to help the agent complete this type of task more reliably.`,
        `Keep the YAML frontmatter (name, description) and agentskills.io format.`,
        `Write the improved version back to /skills/${name}/SKILL.md.`,
        'Explain what you changed and why in a progress emit before the done emit.',
      ].join('\n');

  output.write('\n' + c('cyan', `  Skill RSI: ${name} (${isCreate ? 'creating' : 'improving'}) — budget ${budget}`) + '\n\n');

  const results = await runSkillRSI({
    evalPrompt: evalTask,
    skillName: name,
    mutatePrompt,
    budget,
    state,
    deps,
    log: rsiLog,
  });

  const kept = results.filter(r => r.kept).length;
  output.write('\n' + c('cyan', `  Skill RSI complete: ${kept}/${results.length} experiments kept`) + '\n');

  state.context.skillIndex = buildSkillIndex(vfs);

  const finalSkill = vfs.read(skillPath);
  if (finalSkill) {
    const lines = finalSkill.split('\n').length;
    output.write(c('gray', `  /skills/${name}/SKILL.md: ${lines} lines`) + '\n');
  }

  const journal = state.context.vfs.read('/memory/experiments.jsonl');
  if (journal) {
    output.write(c('gray', `  /memory/experiments.jsonl: ${journal.split('\n').filter(Boolean).length} entries`) + '\n');
  }
  output.write('\n');
}

// ════════════════════════════════════════════════════
// ENTRYPOINT
// ════════════════════════════════════════════════════

const argv = process.argv.slice(2);

function fatal(msg) {
  output.write(c('red', `\nFatal: ${msg}\n`));
  process.exit(1);
}

if (argv[0] === 'skill') {
  const sub = argv[1];
  // Parse --budget flag from anywhere in args
  let budget = 3;
  const budgetIdx = argv.indexOf('--budget');
  if (budgetIdx !== -1) {
    budget = parseInt(argv[budgetIdx + 1], 10) || 3;
    argv.splice(budgetIdx, 2);
  }

  if (!sub || sub === '-h' || sub === '--help') {
    skillUsage();
  } else if (sub === 'list' || sub === 'ls') {
    skillList().catch(e => fatal(e.message));
  } else if (sub === 'show' || sub === 'cat') {
    const name = argv[2];
    if (!name) { output.write(c('red', '  Missing skill name. Usage: aaron skill show <name>\n')); process.exit(1); }
    skillShow(name).catch(e => fatal(e.message));
  } else if (sub === 'create' || sub === 'improve' || sub === 'rsi') {
    const name = argv[2];
    const evalTask = argv.slice(3).join(' ').trim();
    if (!name) { output.write(c('red', `  Missing skill name. Usage: aaron skill ${sub} <name> "eval task"\n`)); process.exit(1); }
    if (!evalTask) { output.write(c('red', `  Missing eval task. Usage: aaron skill ${sub} <name> "eval task"\n`)); process.exit(1); }
    skillRSI(name, evalTask, budget, sub).catch(e => fatal(e.message));
  } else {
    output.write(c('red', `  Unknown skill command: ${sub}\n`));
    skillUsage();
    process.exit(1);
  }
} else {
  const prompt = argv.join(' ').trim();
  if (prompt) {
    run(prompt).catch(e => fatal(e.message));
  } else {
    repl().catch(e => fatal(e.message));
  }
}
