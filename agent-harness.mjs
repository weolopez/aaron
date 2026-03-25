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
import { createVFS, execute, extractCode } from './src/agent-core.js';
import { runTurn, buildSkillIndex } from './src/agent-loop.js';
import { runRSI, runSkillRSI } from './src/agent-rsi.js';
import { createGitHubClient, initFromGitHub, commitToGitHub, parseGitHubRepo } from './src/github.js';

// ════════════════════════════════════════════════════
// .env loader (zero deps)
// ════════════════════════════════════════════════════
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!env[key]) env[key] = val;   // don't override explicit env vars
  }
}

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

const GITHUB_TOKEN = env.GITHUB_TOKEN ?? '';
const GITHUB_REPO  = env.GITHUB_REPO ?? '';   // "owner/repo" or "owner/repo@ref"

// GitHub client (created only when GITHUB_TOKEN is set)
const ghConfig = parseGitHubRepo(GITHUB_REPO);
const ghClient = GITHUB_TOKEN && ghConfig
  ? createGitHubClient({ token: GITHUB_TOKEN })
  : null;

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
    const provider = env.LLM_PROVIDER ?? 'anthropic';
    output.write('\n');
    output.write(c('amber', '  agent/harness') + c('gray', '  cli\n'));
    output.write(c('gray',  '  provider: ') + c('dim', provider) + '\n');
    output.write(c('gray',  '  node:  ') + c('dim', process.version) + '\n');
    output.write('\n');
    output.write(c('gray', '  Commands:\n'));
    output.write(c('gray', '  :vfs            — list VFS contents\n'));
    output.write(c('gray', '  :cat /path      — show a file\n'));
    output.write(c('gray', '  :workflow                         — list workflows\n'));
    output.write(c('gray', '  :workflow create <name> <goal>    — create workflow definition\n'));
    output.write(c('gray', '  :workflow improve <name> <feedback>— revise step prompts\n'));
    output.write(c('gray', '  :workflow <name>                  — run or resume a workflow\n'));
    output.write(c('gray', '  :rsi            — run RSI experiment loop\n'));
    output.write(c('gray', '  :skill          — run skill RSI experiment loop\n'));
    output.write(c('gray', '  :clear          — reset conversation history\n'));
    output.write(c('gray', '  :exit           — quit\n'));
    output.write('\n');
    this.hr();
  },
};

// ════════════════════════════════════════════════════
// VFS HYDRATION (load harness code into VFS for RSI)
// ════════════════════════════════════════════════════

function hydrateHarness(vfs) {
  // Load harness source files from src/
  for (const f of ['agent-core.js', 'agent-loop.js', 'agent-rsi.js']) {
    try {
      const content = readFileSync(join(__dirname, 'src', f), 'utf8');
      vfs.write(`/harness/${f}`, content);
      vfs.markClean(`/harness/${f}`);
    } catch { /* file not found — skip */ }
  }
  // Also load the CLI harness itself
  try {
    const content = readFileSync(join(__dirname, 'agent-harness.mjs'), 'utf8');
    vfs.write('/harness/agent-harness.mjs', content);
    vfs.markClean('/harness/agent-harness.mjs');
  } catch { /* skip */ }

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

  // Load workflows from disk
  loadDirToVFS(join(__dirname, 'workflows'), '/workflows/', vfs);
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
  '/harness/':   'src/',         // /harness/agent-loop.js → ./src/agent-loop.js
  '/memory/':    'memory/',      // /memory/experiments.jsonl → ./memory/experiments.jsonl
  '/artifacts/': 'artifacts/',
  '/skills/':    'skills/',
  '/workflows/': 'workflows/',
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
  const provider = env.LLM_PROVIDER ?? 'anthropic';
  if (provider === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    output.write(c('red', '\nError: ANTHROPIC_API_KEY is not set.\n'));
    output.write(c('gray', 'Usage: ANTHROPIC_API_KEY=sk-ant-... node agent-harness.mjs\n\n'));
    process.exit(1);
  }

  ui.banner();

  const vfs = createVFS();
  hydrateHarness(vfs);
  writeManifest();

  // GitHub hydration (if configured)
  if (ghClient && ghConfig) {
    output.write(c('cyan', `  github`) + c('gray', ` → ${ghConfig.owner}/${ghConfig.repo}@${ghConfig.ref}\n`));
    try {
      const result = await initFromGitHub(ghConfig, vfs, ghClient, (ev) => ui.emitEvent(ev));
      output.write(c('green', `  ✓ `) + c('gray', `${result.files} files hydrated from GitHub`) + '\n');
    } catch (e) {
      output.write(c('red', `  ✕ GitHub hydration failed: ${e.message}\n`));
    }
  }

  const skillIndex = buildSkillIndex(vfs);

  const context = {
    vfs,
    fetch: (...args) => fetch(...args),
    emit:  (ev) => ui.emitEvent(ev),
    env:   {},
    skillIndex,
    github: ghClient ? { owner: ghConfig.owner, repo: ghConfig.repo, ref: ghConfig.ref } : null,
    async commit(message = 'commit') {
      const dirty = vfs.list().filter(p => vfs.isDirty(p));
      // Always flush to disk
      const written = flushToDisk(vfs, dirty);
      writeManifest();
      // Also push to GitHub if connected and /src/ files are dirty
      if (ghClient && ghConfig) {
        const srcDirty = dirty.filter(p => p.startsWith('/src/'));
        if (srcDirty.length > 0) {
          try {
            await commitToGitHub(vfs, ghClient, {
              owner: ghConfig.owner, repo: ghConfig.repo,
              branch: ghConfig.ref, message, pathPrefix: '/src/',
            }, (ev) => context.emit(ev));
          } catch (e) {
            context.emit({ type: 'progress', message: `GitHub push failed: ${e.message}` });
          }
        }
      }
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

  const deps = { execute, extractCode, ui, runTurn };

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

    if (msg === ':github') {
      if (!ghClient || !ghConfig) {
        output.write(c('gray', '  GitHub not configured.\n'));
        output.write(c('gray', '  Set GITHUB_TOKEN and GITHUB_REPO="owner/repo" env vars.\n'));
      } else {
        output.write('\n' + c('cyan', '  GitHub status') + '\n');
        output.write(c('gray', `  repo:   ${ghConfig.owner}/${ghConfig.repo}\n`));
        output.write(c('gray', `  ref:    ${ghConfig.ref}\n`));
        const srcFiles = vfs.list().filter(p => p.startsWith('/src/'));
        const srcDirty = srcFiles.filter(p => vfs.isDirty(p));
        output.write(c('gray', `  files:  ${srcFiles.length} in /src/ (${srcDirty.length} dirty)\n`));
      }
      continue;
    }

    if (msg === ':push' || msg.startsWith(':push ')) {
      if (!ghClient || !ghConfig) {
        output.write(c('red', '  GitHub not configured. Set GITHUB_TOKEN and GITHUB_REPO.\n'));
        continue;
      }
      const pushMsg = msg.slice(5).trim() || 'Update from Aaron';
      try {
        const result = await commitToGitHub(vfs, ghClient, {
          owner: ghConfig.owner, repo: ghConfig.repo,
          branch: ghConfig.ref, message: pushMsg, pathPrefix: '/src/',
        }, (ev) => ui.emitEvent(ev));
        output.write(c('green', `  ✓ `) + c('gray', `pushed ${result.pushed.length} file(s)`) + '\n');
        if (result.conflicts.length > 0) {
          output.write(c('red', `  ✕ ${result.conflicts.length} conflict(s)`) + '\n');
        }
      } catch (e) {
        output.write(c('red', `  push failed: ${e.message}\n`));
      }
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
        'CRITICAL: The file you write MUST be valid ESM. Never use require(), module.exports, or any CommonJS syntax. All exports must use the export keyword. Backticks inside template literals must be escaped as \\`.',
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

    if (msg === ':workflow' || msg.startsWith(':workflow ')) {
      const args = msg.slice(10).trim();

      // ── :workflow (list) ──
      if (!args || args === 'list') {
        const wfPaths = vfs.list().filter(p => p.startsWith('/workflows/') && p.endsWith('.json'));
        if (wfPaths.length === 0) {
          output.write(c('gray', '  No workflows yet.\n'));
          output.write(c('gray', '  Create one: :workflow create <name> <goal>\n'));
        } else {
          output.write('\n' + c('cyan', '  Workflows:') + '\n');
          for (const p of wfPaths) {
            try {
              const wf = JSON.parse(vfs.read(p));
              const stateRaw = vfs.read('/scratch/workflow-state.json');
              const wfState = stateRaw ? JSON.parse(stateRaw) : null;
              const active = wfState?.workflow === wf.name;
              const done = active && wfState?.completedSteps?.length === wf.steps?.length;
              const status = active ? (done ? c('green', 'complete') : c('amber', `step ${wfState.currentStep}`)) : c('gray', 'not started');
              output.write(c('gray', `    ${wf.name}`) + '  ' + status + '\n');
              if (wf.description) output.write(c('gray', `      ${wf.description}\n`));
            } catch { output.write(c('gray', `    ${p}\n`)); }
          }
          output.write(c('gray', '\n  :workflow <name>                   — run\n'));
          output.write(c('gray', '  :workflow create <name> <goal>     — create new\n'));
          output.write(c('gray', '  :workflow improve <name> <feedback>— revise steps\n'));
        }
        output.write('\n');
        continue;
      }

      // ── :workflow create <name> <goal> ──
      if (args.startsWith('create ')) {
        const rest = args.slice(7).trim();
        const spaceIdx = rest.indexOf(' ');
        if (spaceIdx === -1) {
          output.write(c('red', '  Usage: :workflow create <name> <goal description>\n'));
          continue;
        }
        const wfName = rest.slice(0, spaceIdx);
        const goal = rest.slice(spaceIdx + 1).trim();
        const createPrompt = [
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
        ui.user(`:workflow create ${wfName} ${goal}`);
        await runTurn(createPrompt, state, deps);
        continue;
      }

      // ── :workflow improve <name> <feedback> ──
      if (args.startsWith('improve ')) {
        const rest = args.slice(8).trim();
        const spaceIdx = rest.indexOf(' ');
        if (spaceIdx === -1) {
          output.write(c('red', '  Usage: :workflow improve <name> <feedback>\n'));
          continue;
        }
        const wfName = rest.slice(0, spaceIdx);
        const feedback = rest.slice(spaceIdx + 1).trim();
        const wfPath = `/workflows/${wfName}.json`;
        const wfRaw = vfs.read(wfPath);
        if (!wfRaw) {
          output.write(c('red', `  Workflow "${wfName}" not found.\n`));
          output.write(c('gray', `  Create it first: :workflow create ${wfName} <goal>\n`));
          continue;
        }
        const improvePrompt = [
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
        ui.user(`:workflow improve ${wfName} "${feedback}"`);
        await runTurn(improvePrompt, state, deps);
        continue;
      }

      // ── :workflow <name> — run or resume ──
      const wfName = args;
      const wfPath = `/workflows/${wfName}.json`;
      const wfRaw = vfs.read(wfPath);
      if (!wfRaw) {
        output.write(c('red', `  Workflow "${wfName}" not found.\n`));
        output.write(c('gray', `  Create it: :workflow create ${wfName} <goal description>\n`));
        continue;
      }

      let wf;
      try { wf = JSON.parse(wfRaw); }
      catch { output.write(c('red', `  Invalid workflow JSON: ${wfPath}\n`)); continue; }

      // Load or init checkpoint
      const statePath = '/scratch/workflow-state.json';
      let wfState = vfs.read(statePath) ? (() => { try { return JSON.parse(vfs.read(statePath)); } catch { return null; } })() : null;
      if (!wfState || wfState.workflow !== wfName) {
        wfState = { workflow: wfName, startedAt: new Date().toISOString(), completedSteps: [], currentStep: null, outputs: {} };
        vfs.write(statePath, JSON.stringify(wfState, null, 2));
      }

      const totalSteps = wf.steps.length;
      const doneSteps = wfState.completedSteps.length;
      output.write('\n' + c('cyan', `  Workflow: ${wfName}`) + c('gray', ` (${doneSteps}/${totalSteps} steps done)`) + '\n');

      // Drive steps sequentially
      for (const step of wf.steps) {
        if (wfState.completedSteps.includes(step.id)) {
          output.write(c('gray', `  ✓ [${step.id}] already done\n`));
          continue;
        }

        output.write('\n' + c('amber', `  ▶ [${step.id}]`) + c('gray', ` ${step.prompt.slice(0, 80)}`) + '\n');

        // Update checkpoint
        wfState.currentStep = step.id;
        vfs.write(statePath, JSON.stringify(wfState, null, 2));

        // Build the turn prompt — include skill instructions if referenced
        let turnPrompt = step.prompt;
        if (step.skill) {
          const skillMd = vfs.read(`/skills/${step.skill}/SKILL.md`);
          if (skillMd) {
            turnPrompt = `Use the "${step.skill}" skill for this step.\n\n${step.prompt}`;
          }
        }

        // Append checkpoint update instructions to the step prompt
        turnPrompt += `\n\nAfter completing this step:
1. Update /scratch/workflow-state.json: add "${step.id}" to completedSteps, set outputs["${step.id}"] to a brief result summary.
2. Call await context.commit('workflow: ${wfName} — step ${step.id} complete').
3. context.emit({ type: 'done', message: 'Step ${step.id} complete' })`;

        ui.user(turnPrompt);
        await runTurn(turnPrompt, state, deps);

        // Continuation pass: verify step completion and fill any gaps
        output.write(c('gray', `  ↺ [${step.id}] verifying...\n`));
        await runTurn(
          `You just ran step "${step.id}". Its task was:\n${step.prompt}\n\n` +
          `Call context.vfs.list() and verify every file or output the step required now exists. ` +
          `If anything is missing or incomplete, write it now. ` +
          `context.emit({ type: 'done', message: 'Step ${step.id} verified' })`,
          state, deps
        );

        // Read updated state after the step ran
        const updatedRaw = vfs.read(statePath);
        if (updatedRaw) {
          try { wfState = JSON.parse(updatedRaw); } catch {}
        }

        // If agent didn't update completedSteps, do it here as a safety net
        if (!wfState.completedSteps.includes(step.id)) {
          wfState.completedSteps.push(step.id);
          vfs.write(statePath, JSON.stringify(wfState, null, 2));
          output.write(c('gray', `  (checkpoint updated for step ${step.id})\n`));
        }

        output.write(c('green', `  ✓ [${step.id}] complete\n`));
      }

      output.write('\n' + c('green', `  ✅ Workflow "${wfName}" complete!`) + '\n\n');
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
  const provider = env.LLM_PROVIDER ?? 'anthropic';
  if (provider === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    output.write(c('red', 'Error: ANTHROPIC_API_KEY is not set.\n'));
    process.exit(1);
  }
  // askarchitect doesn't need an API key upfront (uses session auth)
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
    github: ghClient ? { owner: ghConfig.owner, repo: ghConfig.repo, ref: ghConfig.ref } : null,
    async commit(message = 'commit') {
      const dirty = vfs.list().filter(p => vfs.isDirty(p));
      const written = flushToDisk(vfs, dirty);
      writeManifest();
      if (ghClient && ghConfig) {
        const srcDirty = dirty.filter(p => p.startsWith('/src/'));
        if (srcDirty.length > 0) {
          try {
            await commitToGitHub(vfs, ghClient, {
              owner: ghConfig.owner, repo: ghConfig.repo,
              branch: ghConfig.ref, message, pathPrefix: '/src/',
            }, (ev) => context.emit(ev));
          } catch { /* logged by commitToGitHub */ }
        }
      }
      for (const p of dirty) vfs.markClean(p);
      if (written.length > 0) {
        context.emit({ type: 'progress', message: `flushed ${written.length} files to disk` });
      }
      return dirty;
    },
  };

  const state = { history: [], turn: 0, context };
  const deps = { execute, extractCode, ui, runTurn };
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
// WORKFLOW CLI
// ════════════════════════════════════════════════════

function workflowUsage() {
  output.write('\n' + c('amber', '  aaron workflow') + c('gray', ' — manage workflows\n\n'));
  output.write(c('gray', '  Usage:\n'));
  output.write(c('gray', '    aaron workflow list                            list defined workflows\n'));
  output.write(c('gray', '    aaron workflow create <name> "goal"            define a new workflow\n'));
  output.write(c('gray', '    aaron workflow improve <name> "feedback"       revise step prompts\n'));
  output.write(c('gray', '    aaron workflow run <name>                      run or resume a workflow\n'));
  output.write(c('gray', '    aaron :workflow <sub> ...                      colon prefix also works\n'));
  output.write('\n');
}

async function workflowList() {
  const vfs = createVFS();
  hydrateHarness(vfs);

  const wfPaths = vfs.list().filter(p => p.startsWith('/workflows/') && p.endsWith('.json'));
  if (wfPaths.length === 0) {
    output.write(c('gray', '  No workflows yet.\n'));
    output.write(c('gray', '  Create one: aaron workflow create <name> "goal"\n'));
    return;
  }

  output.write('\n' + c('cyan', '  Workflows:') + '\n\n');
  for (const p of wfPaths) {
    try {
      const wf = JSON.parse(vfs.read(p));
      const stateRaw = vfs.read('/scratch/workflow-state.json');
      const wfState = stateRaw ? (() => { try { return JSON.parse(stateRaw); } catch { return null; } })() : null;
      const active = wfState?.workflow === wf.name;
      const done = active && wfState?.completedSteps?.length === wf.steps?.length;
      const status = active ? (done ? c('green', 'complete') : c('amber', `step ${wfState.currentStep}`)) : c('gray', 'not started');
      output.write(c('amber', `  ${wf.name}`) + '  ' + status + '\n');
      if (wf.description) output.write(c('gray', `    ${wf.description}\n`));
      if (wf.steps?.length) output.write(c('gray', `    ${wf.steps.length} step(s)\n`));
    } catch { output.write(c('gray', `  ${p}\n`)); }
  }
  output.write('\n');
}

async function workflowCreate(wfName, goal) {
  requireKey();
  const { state, deps } = createRunContext();
  const createPrompt = [
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
    `context.emit({ type: 'done', message: 'Workflow "${wfName}" created. Run it with: aaron workflow run ${wfName}' })`,
  ].join('\n');
  output.write('\n' + c('cyan', `  Creating workflow: ${wfName}`) + '\n\n');
  await runTurn(createPrompt, state, deps);
}

async function workflowImprove(wfName, feedback) {
  requireKey();
  const { vfs, state, deps } = createRunContext();
  const wfPath = `/workflows/${wfName}.json`;
  const wfRaw = vfs.read(wfPath);
  if (!wfRaw) {
    output.write(c('red', `  Workflow "${wfName}" not found.\n`));
    output.write(c('gray', `  Create it first: aaron workflow create ${wfName} "goal"\n`));
    process.exit(1);
  }
  const improvePrompt = [
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
    `context.emit({ type: 'done', message: 'Workflow "${wfName}" improved. Run it with: aaron workflow run ${wfName}' })`,
  ].join('\n');
  output.write('\n' + c('cyan', `  Improving workflow: ${wfName}`) + '\n\n');
  await runTurn(improvePrompt, state, deps);
}

async function workflowRun(wfName) {
  requireKey();
  const { vfs, state, deps } = createRunContext();
  const wfPath = `/workflows/${wfName}.json`;
  const wfRaw = vfs.read(wfPath);
  if (!wfRaw) {
    output.write(c('red', `  Workflow "${wfName}" not found.\n`));
    output.write(c('gray', `  Create it: aaron workflow create ${wfName} "goal"\n`));
    process.exit(1);
  }
  let wf;
  try { wf = JSON.parse(wfRaw); } catch { output.write(c('red', `  Invalid workflow JSON: ${wfPath}\n`)); process.exit(1); }

  const statePath = '/scratch/workflow-state.json';
  let wfState = (() => { try { return JSON.parse(vfs.read(statePath) || 'null'); } catch { return null; } })();
  if (!wfState || wfState.workflow !== wfName) {
    wfState = { workflow: wfName, startedAt: new Date().toISOString(), completedSteps: [], currentStep: null, outputs: {} };
    vfs.write(statePath, JSON.stringify(wfState, null, 2));
  }

  const totalSteps = wf.steps.length;
  const doneSteps = wfState.completedSteps.length;
  output.write('\n' + c('cyan', `  Workflow: ${wfName}`) + c('gray', ` (${doneSteps}/${totalSteps} steps done)`) + '\n');

  for (const step of wf.steps) {
    if (wfState.completedSteps.includes(step.id)) {
      output.write(c('gray', `  ✓ [${step.id}] already done\n`));
      continue;
    }

    output.write('\n' + c('amber', `  ▶ [${step.id}]`) + c('gray', ` ${step.prompt.slice(0, 80)}`) + '\n');

    wfState.currentStep = step.id;
    vfs.write(statePath, JSON.stringify(wfState, null, 2));

    let turnPrompt = step.prompt;
    if (step.skill && vfs.read(`/skills/${step.skill}/SKILL.md`)) {
      turnPrompt = `Use the "${step.skill}" skill for this step.\n\n${step.prompt}`;
    }
    turnPrompt += `\n\nAfter completing this step:
1. Update /scratch/workflow-state.json: add "${step.id}" to completedSteps, set outputs["${step.id}"] to a brief result summary.
2. Call await context.commit('workflow: ${wfName} — step ${step.id} complete').
3. context.emit({ type: 'done', message: 'Step ${step.id} complete' })`;

    await runTurn(turnPrompt, state, deps);

    // Continuation pass: verify step completion and fill any gaps
    output.write(c('gray', `  ↺ [${step.id}] verifying...\n`));
    await runTurn(
      `You just ran step "${step.id}". Its task was:\n${step.prompt}\n\n` +
      `Call context.vfs.list() and verify every file or output the step required now exists. ` +
      `If anything is missing or incomplete, write it now. ` +
      `context.emit({ type: 'done', message: 'Step ${step.id} verified' })`,
      state, deps
    );

    const updatedRaw = vfs.read(statePath);
    if (updatedRaw) { try { wfState = JSON.parse(updatedRaw); } catch {} }
    if (!wfState.completedSteps.includes(step.id)) {
      wfState.completedSteps.push(step.id);
      vfs.write(statePath, JSON.stringify(wfState, null, 2));
    }
    output.write(c('green', `  ✓ [${step.id}] complete\n`));
  }

  output.write('\n' + c('green', `  ✅ Workflow "${wfName}" complete!`) + '\n\n');
}

// ════════════════════════════════════════════════════
// ENTRYPOINT
// ════════════════════════════════════════════════════

const argv = process.argv.slice(2);

function fatal(msg) {
  output.write(c('red', `\nFatal: ${msg}\n`));
  process.exit(1);
}

// Normalize argv[0]: `:workflow` → treat as `workflow`
const isWorkflowCmd = argv[0] === 'workflow' || argv[0] === ':workflow';
const isSkillCmd    = argv[0] === 'skill';

if (isSkillCmd) {
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
} else if (isWorkflowCmd) {
  const sub = argv[1] || '';

  if (!sub || sub === 'list' || sub === 'ls' || sub === '-h' || sub === '--help') {
    if (sub === '-h' || sub === '--help') {
      workflowUsage();
    } else {
      workflowList().catch(e => fatal(e.message));
    }
  } else if (sub === 'create') {
    const name = argv[2];
    const goal = argv.slice(3).join(' ').trim();
    if (!name) { output.write(c('red', '  Missing workflow name. Usage: aaron workflow create <name> "goal"\n')); process.exit(1); }
    if (!goal) { output.write(c('red', '  Missing goal. Usage: aaron workflow create <name> "goal"\n')); process.exit(1); }
    workflowCreate(name, goal).catch(e => fatal(e.message));
  } else if (sub === 'improve') {
    const name = argv[2];
    const feedback = argv.slice(3).join(' ').trim();
    if (!name) { output.write(c('red', '  Missing workflow name. Usage: aaron workflow improve <name> "feedback"\n')); process.exit(1); }
    if (!feedback) { output.write(c('red', '  Missing feedback. Usage: aaron workflow improve <name> "feedback"\n')); process.exit(1); }
    workflowImprove(name, feedback).catch(e => fatal(e.message));
  } else if (sub === 'run') {
    const name = argv[2];
    if (!name) { output.write(c('red', '  Missing workflow name. Usage: aaron workflow run <name>\n')); process.exit(1); }
    workflowRun(name).catch(e => fatal(e.message));
  } else {
    // bare workflow name: aaron :workflow hello → run hello
    workflowRun(sub).catch(e => fatal(e.message));
  }
} else {
  const prompt = argv.join(' ').trim();
  if (prompt) {
    run(prompt).catch(e => fatal(e.message));
  } else {
    repl().catch(e => fatal(e.message));
  }
}
