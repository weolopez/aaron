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
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output, env } from 'node:process';
import { createVFS, execute, extractCode } from './src/core/agent-core.js';
import { runTurn, buildSkillIndex } from './src/harness/agent-loop.js';
import { runSkillRSI, buildSkillScorer } from './src/harness/agent-rsi.js';
import { createGitHubClient, initFromGitHub, commitToGitHub, parseGitHubRepo } from './src/runtime/github.js';
import { loadSession, saveSession, clearSession, listSessions, migrateLegacySession } from './src/runtime/session.js';
import { snapshotWorkspace, restoreWorkspace, getWorkspaceId, getSelfWorkspaceId, isWorkspacePath } from './src/runtime/workspace.js';
import { buildCreatePrompt, buildImprovePrompt, runWorkflowSteps } from './src/runtime/workflow-runner.js';
import { getLLMClient } from './src/core/llm-client.js';
import { dispatchWorkflowCommand } from './src/runtime/commands.js';
import { createCommitFn } from './src/runtime/commit.js';

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

/**
 * Resolve GitHub token: prefer GITHUB_TOKEN env var, fall back to `gh auth token`.
 * Returns '' if neither is available.
 */
function resolveGitHubToken() {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  try {
    const token = execSync('gh auth token', { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (token) {
      output.write(c('gray', '  github token: ') + c('dim', 'from gh CLI') + '\n');
      return token;
    }
  } catch {
    // gh CLI not installed or not logged in — fall through
  }
  return '';
}

const GITHUB_TOKEN = resolveGitHubToken();
const GITHUB_REPO  = env.GITHUB_REPO ?? '';   // "owner/repo" or "owner/repo@ref"

// GitHub client (created only when token is available)
const ghConfig = parseGitHubRepo(GITHUB_REPO);
const ghClient = GITHUB_TOKEN && ghConfig
  ? createGitHubClient({ token: GITHUB_TOKEN })
  : null;

if (GITHUB_REPO && !ghClient) {
  output.write(c('red', '  ✕ GitHub token not found.\n'));
  output.write(c('gray', '    Set GITHUB_TOKEN or run: ') + c('dim', 'gh auth login') + '\n\n');
}

// ════════════════════════════════════════════════════
// GITHUB HELPER — full API surface exposed to agent
// ════════════════════════════════════════════════════

/**
 * Build a bound GitHub helper for a specific repo.
 * All methods are pre-bound to owner/repo so agent code stays concise.
 */
function makeGitHubHelper(client, cfg) {
  const { owner, repo, ref } = cfg;
  return {
    owner, repo, ref,
    async getLatestSha(branch = ref) {
      const data = await client.getBranch(owner, repo, branch);
      if (!data) throw new Error(`Branch not found: ${branch}`);
      return data.sha;
    },
    async createBranch(name, fromRef = ref) {
      const sha = await this.getLatestSha(fromRef);
      await client.createBranch(owner, repo, name, sha);
    },
    async createPR({ title, body, head, base = 'main' }) {
      return client.createPR(owner, repo, { title, body, head, base });
    },
    async listPRs(state = 'open') {
      return client.listPRs(owner, repo, state);
    },
    async getPR(number) {
      return client.getPR(owner, repo, number);
    },
    async mergePR(number, opts) {
      return client.mergePR(owner, repo, number, opts);
    },
    async deleteBranch(name) {
      return client.deleteBranch(owner, repo, name);
    },
  };
}

// ════════════════════════════════════════════════════
// CLI UI (implements UI adapter for runTurn)
// ════════════════════════════════════════════════════

const EV_ICONS = {
  progress:   c('blue',  '◆'),
  result:     c('cyan',  '→'),
  file_write: c('amber', '✦'),
  file_read:  c('gray',  '◇'),
  done:       c('green', '✓'),
  blocked:    c('red',   '⊘'),
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
      case 'blocked':    text = ev.reason ?? 'blocked'; break;
      case 'error':      text = ev.message ?? 'error'; break;
      case 'metric':     text = `${ev.name}: ${ev.value} ${ev.unit ?? ''}`; break;
      case 'experiment': text = `${ev.kept ? 'kept' : 'discarded'}: ${ev.reason ?? ''}`; break;
      default:           text = JSON.stringify(ev);
    }
    const colored =
      ev.type === 'done'       ? c('green', text) :
      ev.type === 'blocked'    ? c('red',   text) :
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
    const provider = env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? 'anthropic' : 'askarchitect');
    output.write('\n');
    output.write(c('amber', '  aaron') + c('gray', '  isomorphic coding agent\n'));
    output.write(c('gray',  '  provider: ') + c('dim', provider) + '\n');
    output.write(c('gray',  '  node:     ') + c('dim', process.version) + '\n');
    output.write(c('gray',  '  tip:      ') + c('dim', 'aaron --help  for full usage\n'));
    output.write('\n');
    output.write(c('gray', '  REPL commands:\n'));
    output.write(c('dim',  '  :vfs                               list VFS files\n'));
    output.write(c('dim',  '  :cat /path                         print a VFS file\n'));
    output.write(c('dim',  '  :repo [owner/repo[@ref]]           show or switch workspace\n'));
    output.write(c('dim',  '  :workspaces                        list saved workspaces\n'));
    output.write(c('dim',  '  :workflow                          list workflows\n'));
    output.write(c('dim',  '  :workflow create <name> <goal>     create workflow\n'));
    output.write(c('dim',  '  :workflow improve <name> <fb>      revise step prompts\n'));
    output.write(c('dim',  '  :workflow rsi <name> [budget]      iterate workflow definition\n'));
    output.write(c('dim',  '  :workflow <name>                   run or resume workflow\n'));
    output.write(c('dim',  '  :skill [budget]                    skill RSI loop\n'));
    output.write(c('dim',  '  :github                            show GitHub status\n'));
    output.write(c('dim',  '  :push [message]                    push /src/ to GitHub\n'));
    output.write(c('dim',  '  :clear                             reset conversation history\n'));
    output.write(c('dim',  '  :reset                             clear saved session\n'));
    output.write(c('dim',  '  :exit                              quit\n'));
    output.write('\n');
    this.hr();
  },
};

// ════════════════════════════════════════════════════
// VFS HYDRATION (load harness code into VFS for RSI)
// ════════════════════════════════════════════════════

function hydrateHarness(vfs) {
  // Load harness source files from src/harness/ (agent-loop, agent-rsi) and src/core/ (agent-core)
  const harnessFiles = { 'agent-core.js': 'src/core', 'agent-loop.js': 'src/harness', 'agent-rsi.js': 'src/harness' };
  for (const [f, dir] of Object.entries(harnessFiles)) {
    try {
      const content = readFileSync(join(__dirname, dir, f), 'utf8');
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

/** Write a manifest of artifacts + memory + skills + workflows files for the browser harness to discover. */
function writeManifest() {
  const manifest = { artifacts: [], memory: [], skills: [], workflows: [] };
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
  const workflowsDir = join(__dirname, 'workflows');
  if (existsSync(workflowsDir)) manifest.workflows = readdirSync(workflowsDir).filter(f => f.endsWith('.json'));
  writeFileSync(join(__dirname, 'vfs-manifest.json'), JSON.stringify(manifest), 'utf8');
}

// VFS path → disk path mapping for commit
const VFS_DISK_MAP = {
  '/harness/':   'src/harness/', // /harness/agent-loop.js → ./src/harness/agent-loop.js
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
  const provider = env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? 'anthropic' : 'askarchitect');
  if (provider === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    output.write(c('red', '\nError: ANTHROPIC_API_KEY is not set.\n'));
    output.write(c('gray', 'Usage: ANTHROPIC_API_KEY=sk-ant-... node agent-harness.mjs\n\n'));
    process.exit(1);
  }

  ui.banner();

  const rl = readline.createInterface({ input, output, terminal: true });

  // Migrate legacy session if present (one-time upgrade to workspace model)
  await migrateLegacySession();

  // Check for saved session and offer to resume
  // Default to 'self' workspace for initial load
  const selfId = getSelfWorkspaceId();
  const savedSession = await loadSession(selfId);
  let state;
  let vfs;
  let currentWorkspaceId = selfId;

  if (savedSession) {
    const age = Date.now() - new Date(savedSession.timestamp).getTime();
    const minutes = Math.floor(age / 60000);
    const hours = Math.floor(age / 3600000);
    const ageStr = hours > 0 ? `${hours}h ago` : `${minutes}m ago`;
    const turns = savedSession.state?.history?.filter(m => m.role === 'assistant').length || 0;

    const answer = (await rl.question(
      c('cyan', '\n  [session]') + c('gray', ` Saved session found (${turns} turns, ${ageStr})\n  Resume? [y/n] `)
    )).trim().toLowerCase();

    if (answer === 'y' || answer === 'yes') {
      vfs = createVFS();
      // Restore VFS contents
      if (savedSession.vfs) {
        for (const [path, content] of Object.entries(savedSession.vfs)) {
          vfs.write(path, content);
        }
      }
      hydrateHarness(vfs);
      writeManifest();

      const skillIndex = buildSkillIndex(vfs);
      const context = {
        vfs,
        fetch: (...args) => fetch(...args),
        emit:  (ev) => ui.emitEvent(ev),
        env:   {},
        skillIndex,
        workspaceId: currentWorkspaceId,
        github: ghClient ? makeGitHubHelper(ghClient, ghConfig) : null,
        commit: createCommitFn({
          vfs,
          getGitHub: () => ghClient && ghConfig ? { client: ghClient, config: ghConfig } : null,
          commitToGitHub,
          emit: (ev) => ui.emitEvent(ev),
          onFlush: (v, dirty) => { flushToDisk(v, dirty); writeManifest(); },
        }),
      };

      state = {
        history: savedSession.state?.history || [],
        turn: savedSession.state?.turn || 0,
        context,
      };

      output.write(c('green', '\n  ✓ ') + c('gray', `Session resumed (${state.history.filter(m => m.role === 'user').length} messages)\n`));
    } else {
      output.write(c('gray', '\n  Starting fresh session\n'));
      vfs = null;
    }
  }

  // Fresh session if not resumed
  if (!vfs) {
    vfs = createVFS();
    hydrateHarness(vfs);
    writeManifest();
  }

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

  if (!state) {
    const skillIndex = buildSkillIndex(vfs);

    const emitFn = (ev) => ui.emitEvent(ev);
    const context = {
      vfs,
      fetch: (...args) => fetch(...args),
      emit:  emitFn,
      approve: () => true,  // CLI: auto-approve risky patterns (user has shell access)
      env:   {},
      skillIndex,
      workspaceId: getSelfWorkspaceId(),
      github: ghClient ? makeGitHubHelper(ghClient, ghConfig) : null,
      commit: createCommitFn({
        vfs,
        getGitHub: () => ghClient && ghConfig ? { client: ghClient, config: ghConfig } : null,
        commitToGitHub,
        emit: emitFn,
        onFlush: (v, dirty) => { flushToDisk(v, dirty); writeManifest(); },
      }),
    };

    state = {
      history: [],
      turn:    0,
      context,
    };
  }

  const deps = { execute, extractCode, ui, runTurn };

  const rsiLog = (msg) => output.write(c('cyan', `  rsi  `) + c('gray', msg) + '\n');

  // Set initial workspace ID if not set
  if (!state.context.workspaceId) {
    state.context.workspaceId = getSelfWorkspaceId();
  }

  // Graceful exit — save session before quitting
  rl.on('close', async () => {
    await saveSession(state.context.workspaceId, state, vfs);
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

    if (msg === ':reset') {
      await clearSession(state.context.workspaceId);
      output.write(c('gray', '  session cleared\n'));
      continue;
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

      output.write(c('gray', '  Enter skill name to improve (or "all" to RSI all skills):') + '\n');

      let skillName;
      try {
        skillName = await rl.question(c('cyan', 'skill') + c('gray', ' › '));
      } catch { break; }
      skillName = skillName.trim();
      if (!skillName) { output.write(c('gray', '  cancelled\n')); continue; }

      // RSI all skills — use each skill's description as eval prompt
      if (skillName === 'all') {
        output.write('\n' + c('cyan', `  RSI all skills: ${skillPaths.length} skills × ${budget} experiments each (LLM scoring)`) + '\n\n');
        const allSummary = [];
        for (const p of skillPaths) {
          const name = p.split('/')[2];
          const content = vfs.read(p);
          const descMatch = content?.match(/^description:\s*(.+)$/m);
          const desc = descMatch?.[1]?.trim();
          if (!desc) {
            output.write(c('amber', `  ⏭ ${name}: no description, skipping`) + '\n');
            allSummary.push({ name, kept: 0, total: 0, skipped: true });
            continue;
          }
          const mp = [
            `Read /skills/${name}/SKILL.md — this is a skill that provides agent instructions.`,
            `Now analyze how an agent would approach this eval task: "${desc}"`,
            `Improve the skill instructions to help the agent complete this type of task more reliably.`,
            `Keep the YAML frontmatter (name, description) and agentskills.io format.`,
            `Write the improved version back to /skills/${name}/SKILL.md.`,
            'Explain what you changed and why in a progress emit before the done emit.',
          ].join('\n');
          output.write(c('cyan', `  ── ${name} ──`) + '\n');
          const sc = buildSkillScorer(getLLMClient());
          const res = await runSkillRSI({ evalPrompt: desc, skillName: name, mutatePrompt: mp, budget, state, deps, log: rsiLog, scorer: sc });
          const kept = res.filter(r => r.kept).length;
          allSummary.push({ name, kept, total: res.length, skipped: false });
          output.write(c('cyan', `  ${name}: ${kept}/${res.length} kept`) + '\n\n');
        }
        state.context.skillIndex = buildSkillIndex(vfs);
        output.write('\n' + c('cyan', '  ═══ RSI ALL SKILLS SUMMARY ═══') + '\n\n');
        for (const s of allSummary) {
          if (s.skipped) {
            output.write(c('gray', `    ${s.name}: skipped`) + '\n');
          } else {
            const icon = s.kept > 0 ? c('green', '✓') : c('gray', '·');
            output.write(`    ${icon} ${s.name}: ${s.kept}/${s.total} kept\n`);
          }
        }
        const totalKept = allSummary.reduce((n, s) => n + s.kept, 0);
        const totalRun = allSummary.reduce((n, s) => n + s.total, 0);
        output.write('\n' + c('cyan', `  Total: ${totalKept}/${totalRun} kept across ${skillPaths.length} skills`) + '\n');
        ui.hr();
        continue;
      }

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
            `Read /skills/${skillName}/SKILL.md — this is a skill that provides agent instructions.`,
            '',
            `The eval task is: "${evalPrompt}"`,
            '',
            'To improve effectively:',
            '1. Re-read the skill to understand its current steps and code blocks.',
            '2. Read /memory/experiments.jsonl — find the most recent experiment for this skill and check why it scored lower than expected.',
            '3. Read any artifacts written under /scratch/ — look for thin content, missing files, or incomplete analysis.',
            '4. Identify the ONE weakest step: vague instructions, missing code snippet, wrong output path, or missing edge-case handling.',
            '5. Strengthen that step: add or sharpen the JS code block, clarify the emit protocol, fix the output path.',
            `6. Rules: keep YAML frontmatter unchanged; every step must have a \`\`\`js block; every step must call context.emit({type:"progress",...}); final step must call context.emit({type:"done",...}).`,
            `7. Write the improved version to /skills/${skillName}/SKILL.md.`,
            '8. Emit a progress event describing exactly what you changed and why, then emit done.',
          ].join('\n')
        : [
            `Create a new skill at /skills/${skillName}/SKILL.md that teaches the agent to: "${evalPrompt}"`,
            '',
            'FORMAT — read this reference skill first to match its structure:',
            `  const ref = context.vfs.read('/skills/bug-fixer/SKILL.md');`,
            `  context.emit({type:'progress', message:'Format reference loaded: ' + (ref ? ref.split('\\n').length + ' lines' : 'not found')});`,
            '',
            'REQUIRED STRUCTURE:',
            '  ---',
            `  name: ${skillName}`,
            '  description: <one sentence — when to use this skill>',
            '  ---',
            '',
            `  # ${skillName}`,
            '  <2-3 sentence overview>',
            '',
            '  ## When to use',
            '  - <condition 1>',
            '  - <condition 2>',
            '',
            '  ## Steps',
            '  Each step MUST have:',
            '    ### N. <Step title>',
            '    <prose>',
            '    ```js',
            '    context.emit({type:"progress", message:"Step N: ..."});',
            '    // read/analyze/write',
            `    context.emit({type:"file_write", path:"/scratch/${skillName}/output.md"});`,
            '    ```',
            '',
            '  FINAL step MUST end with:',
            '    context.emit({type:"result", value:{...summary}});',
            '    context.emit({type:"done", message:"<one-liner>"});',
            '',
            'RULES:',
            `  - Write outputs to /scratch/${skillName}/`,
            '  - Read inputs from /memory/ or /scratch/ — check vfs.list() first',
            '  - Code blocks: valid JS only (no TypeScript, no imports — use context.* directly)',
            '  - Include Anti-patterns section',
            '',
            `Write the complete SKILL.md to /skills/${skillName}/SKILL.md, then emit progress describing what you built, then emit done.`,
          ].join('\n');

      const scorer = buildSkillScorer(getLLMClient());
      output.write('\n' + c('cyan', `  Skill RSI: ${skillName} (${existing ? 'improving' : 'creating'}, LLM scoring)`) + '\n');

      const results = await runSkillRSI({
        evalPrompt,
        skillName,
        mutatePrompt,
        budget,
        state,
        deps,
        log: rsiLog,
        scorer,
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
      const wfArgs = msg.slice(10).trim();
      await dispatchWorkflowCommand(wfArgs, {
        vfs, state, deps,
        getLLMClient,
        callbacks: {
          onError:    (m) => output.write(c('red', `  ${m}\n`)),
          onNotFound: (n) => { output.write(c('red', `  Workflow "${n}" not found.\n`)); output.write(c('gray', `  Create it: :workflow create ${n} <goal>\n`)); },
          onList: (workflows) => {
            if (workflows.length === 0) {
              output.write(c('gray', '  No workflows yet.\n'));
              output.write(c('gray', '  Create one: :workflow create <name> <goal>\n'));
            } else {
              output.write('\n' + c('cyan', '  Workflows:') + '\n');
              for (const wf of workflows) {
                const statusStr = wf.status === 'complete'     ? c('green', 'complete')
                                : wf.status === 'in-progress'  ? c('amber', `step ${wf.currentStep}`)
                                : c('gray', 'not started');
                output.write(c('gray', `    ${wf.name}`) + '  ' + statusStr + '\n');
                if (wf.description) output.write(c('gray', `      ${wf.description}\n`));
              }
              output.write(c('gray', '\n  :workflow <name>                    — run\n'));
              output.write(c('gray', '  :workflow create <name> <goal>      — create new\n'));
              output.write(c('gray', '  :workflow improve <name> <feedback> — revise steps\n'));
              output.write(c('gray', '  :workflow rsi <name> [budget]       — iterate definition\n'));
            }
            output.write('\n');
          },
          onUserMsg:  (text) => ui.user(text),
          onRSIStart: (n, b) => output.write('\n' + c('cyan', `  Workflow RSI: ${n} (${b} experiments, LLM scoring enabled)`) + '\n'),
          onRSIDone:  (results) => {
            const kept = results.filter(r => r.kept).length;
            output.write('\n' + c('cyan', `  Workflow RSI complete: ${kept}/${results.length} experiments kept`) + '\n');
            const journal = vfs.read('/memory/experiments.jsonl');
            if (journal) output.write(c('gray', `  experiments.jsonl: ${journal.split('\n').filter(Boolean).length} entries\n`));
            ui.hr();
          },
          onRunStart: (n, done, total) => output.write('\n' + c('cyan', `  Workflow: ${n}`) + c('gray', ` (${done}/${total} steps done)`) + '\n'),
          stepCallbacks: {
            onStepStart:          (id, preview) => output.write('\n' + c('amber', `  ▶ [${id}]`) + c('gray', ` ${preview}`) + '\n'),
            onStepVerifying:      (id) => output.write(c('gray', `  ↺ [${id}] verifying...\n`)),
            onStepDone:           (id) => output.write(c('green', `  ✓ [${id}] complete\n`)),
            onStepSkipped:        (id) => output.write(c('gray', `  ✓ [${id}] already done\n`)),
            onCheckpointUpdated:  (id) => output.write(c('gray', `  (checkpoint updated for step ${id})\n`)),
            onComplete:           (name) => { output.write('\n' + c('green', `  ✅ Workflow "${name}" complete!`) + '\n\n'); ui.hr(); },
            onUserMsg:            (text) => ui.user(text),
          },
        },
      });
      continue;
    }

    // ════════════════════════════════════════════════════
    // :repo — Workspace management (ADR.md Decision 14)
    // ════════════════════════════════════════════════════

    if (msg === ':repo' || msg.startsWith(':repo ')) {
      const args = msg.slice(5).trim();

      // ── :repo (show current) ──
      if (!args) {
        const currentId = state.context.workspaceId || 'self';
        const github = state.context.github;
        output.write('\n' + c('cyan', '  Current workspace') + '\n');
        output.write(c('gray', `  id:     ${currentId}\n`));
        if (github) {
          output.write(c('gray', `  repo:   ${github.owner}/${github.repo}\n`));
          output.write(c('gray', `  ref:    ${github.ref}\n`));
        }
        const srcFiles = vfs.list().filter(p => p.startsWith('/src/')).length;
        const projSkills = vfs.list().filter(p => p.startsWith('/project-skills/')).length;
        output.write(c('gray', `  files:  ${srcFiles} in /src/, ${projSkills} project skills\n`));
        output.write(c('gray', '\n  Use :repo <owner/repo> to switch, or :workspaces to list saved.\n'));
        continue;
      }

      // ── :repo list / :workspaces ──
      if (args === 'list' || msg === ':workspaces') {
        const sessions = await listSessions();
        if (sessions.length === 0) {
          output.write(c('gray', '  No saved workspaces.\n'));
          output.write(c('gray', '  Switch to a repo: :repo owner/repo[@ref]\n'));
        } else {
          output.write('\n' + c('cyan', '  Saved workspaces:') + '\n\n');
          for (const s of sessions) {
            const age = Date.now() - new Date(s.timestamp).getTime();
            const hours = Math.floor(age / 3600000);
            const mins = Math.floor(age / 60000) % 60;
            const ageStr = hours > 0 ? `${hours}h ${mins}m ago` : `${mins}m ago`;
            const current = s.workspaceId === (state.context.workspaceId || 'self');
            const marker = current ? c('green', '▸ ') : '  ';
            output.write(marker + c('amber', s.workspaceId) + c('gray', `  (${ageStr})`) + '\n');
          }
        }
        continue;
      }

      // ── :repo <owner/repo[@ref]> — switch workspace ──
      const repoStr = args;
      const targetRepo = parseGitHubRepo(repoStr);
      if (!targetRepo) {
        output.write(c('red', '  Invalid repo format. Use: owner/repo or owner/repo@ref\n'));
        output.write(c('gray', '  Example: :repo weolopez/aaron-test-repo\n'));
        continue;
      }

      if (!ghClient) {
        output.write(c('red', '  GitHub not configured. Set GITHUB_TOKEN env var.\n'));
        continue;
      }

      const targetId = getWorkspaceId(targetRepo.owner, targetRepo.repo, targetRepo.ref);
      const currentId = state.context.workspaceId || 'self';

      if (targetId === currentId) {
        output.write(c('gray', `  Already in workspace: ${targetId}\n`));
        continue;
      }

      output.write('\n' + c('cyan', `  Switching workspace`) + '\n');
      output.write(c('gray', `  from: ${currentId}\n`));
      output.write(c('gray', `  to:   ${targetId}\n`));

      // Save current workspace
      output.write(c('gray', '\n  Saving current workspace...\n'));
      await saveSession(currentId, state, vfs);

      // Snapshot current workspace layer
      const currentBundle = snapshotWorkspace(vfs, state);

      // Try to load existing target workspace
      const targetSession = await loadSession(targetId);

      if (targetSession) {
        // Restore saved target workspace
        output.write(c('gray', `  Restoring saved workspace: ${targetId}\n`));
        restoreWorkspace(vfs, { ...currentBundle, ...targetSession.vfs }); // Merge to keep agent layer
        if (targetSession.state) {
          state.history = targetSession.state.history || [];
          state.turn = targetSession.state.turn || 0;
        }
      } else {
        // Fresh hydration from GitHub
        output.write(c('gray', `  Hydrating from GitHub: ${targetRepo.owner}/${targetRepo.repo}@${targetRepo.ref}\n`));
        restoreWorkspace(vfs, {}); // Clear workspace layer
        try {
          const result = await initFromGitHub(targetRepo, vfs, ghClient, (ev) => ui.emitEvent(ev));
          output.write(c('green', `  ✓ `) + c('gray', `${result.files} files hydrated`) + '\n');
          if (result.aaronFiles > 0) {
            output.write(c('green', `  ✓ `) + c('gray', `${result.aaronFiles} .aaron/ file(s) mounted`) + '\n');
          }
          state.history = [];
          state.turn = 0;
        } catch (e) {
          output.write(c('red', `  ✕ Hydration failed: ${e.message}\n`));
          output.write(c('gray', '  Restoring previous workspace...\n'));
          restoreWorkspace(vfs, currentBundle);
          continue;
        }
      }

      // Update context
      state.context.workspaceId = targetId;
      state.context.github = ghClient ? makeGitHubHelper(ghClient, targetRepo) : null;
      state.context.skillIndex = buildSkillIndex(vfs);

      output.write(c('green', '\n  ✓ ') + c('gray', `Switched to workspace: ${targetId}`) + '\n');
      ui.hr();
      continue;
    }

    if (msg === ':workspaces') {
      // Alias for :repo list
      const sessions = await listSessions();
      if (sessions.length === 0) {
        output.write(c('gray', '  No saved workspaces.\n'));
      } else {
        output.write('\n' + c('cyan', '  Saved workspaces:') + '\n\n');
        for (const s of sessions) {
          const age = Date.now() - new Date(s.timestamp).getTime();
          const hours = Math.floor(age / 3600000);
          const mins = Math.floor(age / 60000) % 60;
          const ageStr = hours > 0 ? `${hours}h ${mins}m ago` : `${mins}m ago`;
          const current = s.workspaceId === (state.context.workspaceId || 'self');
          const marker = current ? c('green', '▸ ') : '  ';
          output.write(marker + c('amber', s.workspaceId) + c('gray', `  (${ageStr})`) + '\n');
        }
      }
      continue;
    }

    if (msg === ':help' || msg === ':h') {
      ui.banner();
      continue;
    }

    if (msg.startsWith(':')) {
      output.write(c('gray', `  unknown command: ${msg}\n`));
      output.write(c('dim',  `  type :exit to quit, or see aaron --help for full reference\n`));
      continue;
    }

    ui.user(msg);
    await runTurn(msg, state, deps);
    await saveSession(state.context.workspaceId, state, vfs);
  }
}

// ════════════════════════════════════════════════════
// SINGLE-SHOT MODE
// ════════════════════════════════════════════════════

function requireKey() {
  const provider = env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? 'anthropic' : 'askarchitect');
  if (provider === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    output.write(c('red', 'Error: ANTHROPIC_API_KEY is not set.\n'));
    process.exit(1);
  }
  // askarchitect doesn't need an API key upfront (uses session auth)
}

async function createRunContext() {
  const vfs = createVFS();
  hydrateHarness(vfs);
  writeManifest();

  // GitHub hydration (if configured)
  if (ghClient && ghConfig) {
    try {
      const result = await initFromGitHub(ghConfig, vfs, ghClient, (ev) => ui.emitEvent(ev));
      output.write(c('green', `  ✓ `) + c('gray', `${result.files} files hydrated from GitHub`) + '\n');
    } catch (e) {
      output.write(c('red', `  ✕ GitHub hydration failed: ${e.message}\n`));
    }
  }

  const skillIndex = buildSkillIndex(vfs);
  const rsiLog = (msg) => output.write(c('cyan', `  rsi  `) + c('gray', msg) + '\n');

  const emitFn = (ev) => ui.emitEvent(ev);
  const context = {
    vfs,
    fetch: (...args) => fetch(...args),
    emit:  emitFn,
    approve: () => true,  // CLI: auto-approve risky patterns (user has shell access)
    env:   {},
    skillIndex,
    workspaceId: ghConfig ? getWorkspaceId(ghConfig.owner, ghConfig.repo, ghConfig.ref) : getSelfWorkspaceId(),
    github: ghClient ? makeGitHubHelper(ghClient, ghConfig) : null,
    commit: createCommitFn({
      vfs,
      getGitHub: () => ghClient && ghConfig ? { client: ghClient, config: ghConfig } : null,
      commitToGitHub,
      emit: emitFn,
      onFlush: (v, dirty) => { flushToDisk(v, dirty); writeManifest(); },
    }),
  };

  const state = { history: [], turn: 0, context };
  const deps = { execute, extractCode, ui, runTurn };
  return { vfs, state, deps, rsiLog };
}

async function run(prompt) {
  requireKey();
  const { state, deps } = await createRunContext();
  ui.setStatus('thinking');
  await runTurn(prompt, state, deps);
}

// ════════════════════════════════════════════════════
// SKILL CLI
// ════════════════════════════════════════════════════

function skillUsage() {
  output.write('\n' + c('amber', '  aaron skill') + c('gray', ' — manage agent skills\n\n'));
  output.write(c('cyan', '  Usage:\n'));
  output.write(c('dim',  '    aaron skill list                          ') + c('gray', 'list installed skills\n'));
  output.write(c('dim',  '    aaron skill show <name>                   ') + c('gray', 'print SKILL.md to stdout\n'));
  output.write(c('dim',  '    aaron skill create <name> "eval task"     ') + c('gray', 'create new skill via RSI\n'));
  output.write(c('dim',  '    aaron skill improve <name> "eval task"    ') + c('gray', 'improve existing skill via RSI\n'));
  output.write(c('dim',  '    aaron skill rsi <name> "eval task"        ') + c('gray', 'create-or-improve (auto-detects)\n'));
  output.write(c('dim',  '    aaron skill rsi-all                       ') + c('gray', 'RSI all skills (uses description as eval)\n'));
  output.write('\n');
  output.write(c('cyan', '  Options:\n'));
  output.write(c('dim',  '    --budget N   ') + c('gray', 'RSI experiment budget (default: 3)\n'));
  output.write('\n');
  output.write(c('cyan', '  Examples:\n'));
  output.write(c('dim',  '    aaron skill list\n'));
  output.write(c('dim',  '    aaron skill create summarizer "summarize long documents"\n'));
  output.write(c('dim',  '    aaron skill improve summarizer "make summaries shorter" --budget 5\n'));
  output.write(c('dim',  '    aaron skill show summarizer\n'));
  output.write('\n');
  output.write(c('gray', '  Skills live in skills/<name>/SKILL.md (agentskills.io format).\n'));
  output.write(c('gray', '  Run ') + c('dim', 'aaron --help') + c('gray', ' for full documentation.\n'));
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
  const { vfs, state, deps, rsiLog } = await createRunContext();

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

  const scorer = buildSkillScorer(getLLMClient());
  output.write('\n' + c('cyan', `  Skill RSI: ${name} (${isCreate ? 'creating' : 'improving'}, LLM scoring) — budget ${budget}`) + '\n\n');

  const results = await runSkillRSI({
    evalPrompt: evalTask,
    skillName: name,
    mutatePrompt,
    budget,
    state,
    deps,
    log: rsiLog,
    scorer,
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

async function skillRSIAll(budget) {
  requireKey();
  const { vfs, state, deps, rsiLog } = await createRunContext();

  const skillPaths = vfs.list().filter(p => p.startsWith('/skills/') && p.endsWith('/SKILL.md'));
  if (skillPaths.length === 0) {
    output.write(c('red', '  No skills installed.\n'));
    process.exit(1);
  }

  output.write('\n' + c('cyan', `  RSI all skills: ${skillPaths.length} skills × ${budget} experiments each (LLM scoring)`) + '\n\n');

  const summary = [];

  for (const p of skillPaths) {
    const name = p.split('/')[2];
    const content = vfs.read(p);
    const descMatch = content?.match(/^description:\s*(.+)$/m);
    const desc = descMatch?.[1]?.trim();

    if (!desc) {
      output.write(c('amber', `  ⏭ ${name}: no description in frontmatter, skipping`) + '\n');
      summary.push({ name, kept: 0, total: 0, skipped: true });
      continue;
    }

    const evalPrompt = desc;
    const mutatePrompt = [
      `Read /skills/${name}/SKILL.md — this is a skill that provides instructions for the agent.`,
      `Now analyze how an agent would approach this eval task: "${evalPrompt}"`,
      `Improve the skill instructions to help the agent complete this type of task more reliably.`,
      `Keep the YAML frontmatter (name, description) and agentskills.io format.`,
      `Write the improved version back to /skills/${name}/SKILL.md.`,
      'Explain what you changed and why in a progress emit before the done emit.',
    ].join('\n');

    output.write(c('cyan', `  ── ${name} ──`) + '\n');
    output.write(c('gray', `  eval: "${desc}"`) + '\n');

    const scorer = buildSkillScorer(getLLMClient());
    const results = await runSkillRSI({
      evalPrompt,
      skillName: name,
      mutatePrompt,
      budget,
      state,
      deps,
      log: rsiLog,
      scorer,
    });

    const kept = results.filter(r => r.kept).length;
    summary.push({ name, kept, total: results.length, skipped: false });
    output.write(c('cyan', `  ${name}: ${kept}/${results.length} kept`) + '\n\n');
  }

  // Rebuild skill index to reflect final state
  state.context.skillIndex = buildSkillIndex(vfs);

  // Summary table
  output.write('\n' + c('cyan', '  ═══ RSI ALL SKILLS SUMMARY ═══') + '\n\n');
  for (const s of summary) {
    if (s.skipped) {
      output.write(c('gray', `    ${s.name}: skipped (no description)`) + '\n');
    } else {
      const icon = s.kept > 0 ? c('green', '✓') : c('gray', '·');
      output.write(`    ${icon} ${s.name}: ${s.kept}/${s.total} kept\n`);
    }
  }

  const totalKept = summary.reduce((n, s) => n + s.kept, 0);
  const totalRun = summary.reduce((n, s) => n + s.total, 0);
  output.write('\n' + c('cyan', `  Total: ${totalKept}/${totalRun} experiments kept across ${skillPaths.length} skills`) + '\n\n');
}

// ════════════════════════════════════════════════════
// WORKFLOW CLI
// ════════════════════════════════════════════════════

function workflowUsage() {
  output.write('\n' + c('amber', '  aaron workflow') + c('gray', ' — manage multi-step agent workflows\n\n'));
  output.write(c('cyan', '  Usage:\n'));
  output.write(c('dim',  '    aaron workflow list                        ') + c('gray', 'list workflows with status\n'));
  output.write(c('dim',  '    aaron workflow create <name> "goal"        ') + c('gray', 'define a new workflow via agent\n'));
  output.write(c('dim',  '    aaron workflow improve <name> "feedback"   ') + c('gray', 'revise step prompts via agent\n'));
  output.write(c('dim',  '    aaron workflow run <name>                  ') + c('gray', 'run or resume a workflow\n'));
  output.write('\n');
  output.write(c('cyan', '  Examples:\n'));
  output.write(c('dim',  '    aaron workflow list\n'));
  output.write(c('dim',  '    aaron workflow create report "generate a weekly status report"\n'));
  output.write(c('dim',  '    aaron workflow run report\n'));
  output.write(c('dim',  '    aaron workflow improve report "add an executive summary step"\n'));
  output.write('\n');
  output.write(c('gray', '  Workflows are JSON files in workflows/<name>.json.\n'));
  output.write(c('gray', '  Run/resume state is checkpointed per step (survives restarts).\n'));
  output.write(c('gray', '  Run ') + c('dim', 'aaron --help') + c('gray', ' for full documentation.\n'));
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
  const { state, deps } = await createRunContext();
  output.write('\n' + c('cyan', `  Creating workflow: ${wfName}`) + '\n\n');
  await runTurn(buildCreatePrompt(wfName, goal), state, deps);
}

async function workflowImprove(wfName, feedback) {
  requireKey();
  const { vfs, state, deps } = await createRunContext();
  if (!vfs.read(`/workflows/${wfName}.json`)) {
    output.write(c('red', `  Workflow "${wfName}" not found.\n`));
    output.write(c('gray', `  Create it first: aaron workflow create ${wfName} "goal"\n`));
    process.exit(1);
  }
  output.write('\n' + c('cyan', `  Improving workflow: ${wfName}`) + '\n\n');
  await runTurn(buildImprovePrompt(wfName, feedback), state, deps);
}

async function workflowRun(wfName) {
  requireKey();
  const { vfs, state, deps } = await createRunContext();
  const wfRaw = vfs.read(`/workflows/${wfName}.json`);
  if (!wfRaw) {
    output.write(c('red', `  Workflow "${wfName}" not found.\n`));
    output.write(c('gray', `  Create it: aaron workflow create ${wfName} "goal"\n`));
    process.exit(1);
  }
  let wf;
  try { wf = JSON.parse(wfRaw); } catch { output.write(c('red', `  Invalid workflow JSON\n`)); process.exit(1); }

  const doneCount = (() => {
    try { return JSON.parse(vfs.read('/scratch/workflow-state.json') || 'null')?.completedSteps?.length ?? 0; } catch { return 0; }
  })();
  output.write('\n' + c('cyan', `  Workflow: ${wfName}`) + c('gray', ` (${doneCount}/${wf.steps.length} steps done)`) + '\n');

  await runWorkflowSteps(wf, wfName, vfs, state, deps, {
    onStepStart:         (id, preview) => output.write('\n' + c('amber', `  ▶ [${id}]`) + c('gray', ` ${preview}`) + '\n'),
    onStepVerifying:     (id) => output.write(c('gray', `  ↺ [${id}] verifying...\n`)),
    onStepDone:          (id) => output.write(c('green', `  ✓ [${id}] complete\n`)),
    onStepSkipped:       (id) => output.write(c('gray', `  ✓ [${id}] already done\n`)),
    onCheckpointUpdated: (id) => output.write(c('gray', `  (checkpoint updated for step ${id})\n`)),
    onComplete:          (name) => output.write('\n' + c('green', `  ✅ Workflow "${name}" complete!`) + '\n\n'),
  });
}

// ════════════════════════════════════════════════════
// USAGE / HELP
// ════════════════════════════════════════════════════

function usage() {
  const b = (s) => c('amber', s);
  const g = (s) => c('gray',  s);
  const d = (s) => c('dim',   s);
  const h = (s) => c('cyan',  s);

  output.write('\n');
  output.write(b('  aaron') + g(' — isomorphic JS coding agent\n'));
  output.write('\n');

  output.write(h('  USAGE\n'));
  output.write(d('    aaron                                        ') + g('interactive REPL\n'));
  output.write(d('    aaron "prompt"                               ') + g('single-shot (no REPL)\n'));
  output.write(d('    aaron skill <sub> [args]                     ') + g('skill management\n'));
  output.write(d('    aaron workflow <sub> [args]                  ') + g('workflow management\n'));
  output.write(d('    aaron --help                                 ') + g('this message\n'));
  output.write(d('    aaron --version                              ') + g('print version info\n'));
  output.write('\n');

  output.write(h('  ENVIRONMENT\n'));
  output.write(d('    ANTHROPIC_API_KEY=sk-ant-...   ') + g('required for Anthropic provider\n'));
  output.write(d('    LLM_PROVIDER=anthropic         ') + g('LLM provider (default: anthropic)\n'));
  output.write(d('    GITHUB_TOKEN=ghp_...           ') + g('GitHub PAT for push/hydration\n'));
  output.write(d('    GITHUB_REPO=owner/repo[@ref]   ') + g('repo to sync VFS /src/ with\n'));
  output.write('\n');
  output.write(g('    Alternatively, place these in a ') + d('.env') + g(' file in the project root.\n'));
  output.write('\n');

  output.write(h('  REPL COMMANDS\n'));
  output.write(g('    The interactive REPL accepts plain messages and the following commands:\n\n'));
  output.write(d('    :vfs                              ') + g('list all VFS files (path, size, dirty)\n'));
  output.write(d('    :cat /path                        ') + g('print a VFS file to stdout\n'));
  output.write(d('    :clear                            ') + g('reset conversation history (VFS persists)\n'));
  output.write(d('    :reset                            ') + g('clear saved session from disk\n'));
  output.write(d('    :exit | :quit                     ') + g('quit (auto-saves session)\n'));
  output.write('\n');
  output.write(d('    :github                           ') + g('show GitHub connection status\n'));
  output.write(d('    :push [commit message]            ') + g('push dirty /src/ files to GitHub\n'));
  output.write('\n');
  output.write(d('    :skill [budget]                   ') + g('run skill RSI experiment loop (LLM scoring)\n'));
  output.write('\n');
  output.write(d('    :workflow                         ') + g('list defined workflows\n'));
  output.write(d('    :workflow <name>                  ') + g('run or resume a workflow\n'));
  output.write(d('    :workflow create <name> <goal>    ') + g('create a workflow via agent\n'));
  output.write(d('    :workflow improve <name> <fb>     ') + g('revise workflow step prompts\n'));
  output.write(d('    :workflow rsi <name> [budget]     ') + g('iterate workflow definition via RSI\n'));
  output.write('\n');

  output.write(h('  SKILL SUBCOMMANDS\n'));
  output.write(d('    aaron skill list                             ') + g('list installed skills\n'));
  output.write(d('    aaron skill show <name>                      ') + g('print SKILL.md to stdout\n'));
  output.write(d('    aaron skill create <name> "eval task"        ') + g('create new skill via RSI\n'));
  output.write(d('    aaron skill improve <name> "eval task"       ') + g('improve existing skill via RSI\n'));
  output.write(d('    aaron skill rsi <name> "eval task"           ') + g('create-or-improve (auto-detects)\n'));
  output.write(d('    aaron skill rsi-all                          ') + g('RSI all skills (uses description as eval)\n'));
  output.write(d('    --budget N                                   ') + g('RSI experiment budget (default: 3)\n'));
  output.write('\n');

  output.write(h('  WORKFLOW SUBCOMMANDS\n'));
  output.write(d('    aaron workflow list                          ') + g('list defined workflows\n'));
  output.write(d('    aaron workflow create <name> "goal"          ') + g('define a workflow via agent\n'));
  output.write(d('    aaron workflow improve <name> "feedback"     ') + g('revise step prompts via agent\n'));
  output.write(d('    aaron workflow run <name>                    ') + g('run or resume a workflow\n'));
  output.write('\n');

  output.write(h('  VFS DIRECTORIES\n'));
  output.write(d('    /src/          ') + g('working codebase (synced to GitHub if configured)\n'));
  output.write(d('    /harness/      ') + g('agent runtime (RSI target: agent-loop.js)\n'));
  output.write(d('    /memory/       ') + g('long-term facts (persisted to memory/ on disk)\n'));
  output.write(d('    /artifacts/    ') + g('agent outputs (persisted to artifacts/ on disk)\n'));
  output.write(d('    /skills/*/     ') + g('skill definitions (SKILL.md, agentskills.io format)\n'));
  output.write(d('    /workflows/*/  ') + g('workflow definitions (JSON, driven by :workflow)\n'));
  output.write(d('    /scratch/      ') + g('ephemeral planning scratchpad\n'));
  output.write('\n');

  output.write(h('  EXAMPLES\n'));
  output.write(d('    ANTHROPIC_API_KEY=sk-ant-... aaron\n'));
  output.write(d('    ANTHROPIC_API_KEY=sk-ant-... aaron "write a fibonacci function"\n'));
  output.write(d('    ANTHROPIC_API_KEY=sk-ant-... aaron skill create summarizer "summarize long docs"\n'));
  output.write(d('    ANTHROPIC_API_KEY=sk-ant-... aaron workflow create report "weekly status report"\n'));
  output.write(d('    ANTHROPIC_API_KEY=sk-ant-... aaron workflow run report\n'));
  output.write('\n');
  output.write(g('    With a .env file, omit the key prefix:\n'));
  output.write(d('    aaron "explain the VFS architecture"\n'));
  output.write('\n');

  output.write(h('  SESSION\n'));
  output.write(g('    The REPL auto-saves conversation state (history + VFS) on exit.\n'));
  output.write(g('    On next launch it will offer to resume. Use :reset to wipe saved state.\n'));
  output.write('\n');

  output.write(h('  DOCS\n'));
  output.write(g('    CLAUDE.md  — architecture, RSI contract, code style\n'));
  output.write(g('    ADR.md     — 13 architectural decisions with full rationale\n'));
  output.write('\n');
}

function version() {
  const provider = env.LLM_PROVIDER ?? 'anthropic';
  output.write(c('amber', 'aaron') + c('gray', '  isomorphic JS coding agent\n'));
  output.write(c('gray', `node     ${process.version}\n`));
  output.write(c('gray', `provider ${provider}\n`));
  output.write(c('gray', `platform ${process.platform} ${process.arch}\n`));
}

// ════════════════════════════════════════════════════
// ENTRYPOINT
// ════════════════════════════════════════════════════

const argv = process.argv.slice(2);

function fatal(msg) {
  output.write(c('red', `\nFatal: ${msg}\n`));
  process.exit(1);
}

// Top-level flags
if (argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
  usage();
  process.exit(0);
}
if (argv[0] === '--version' || argv[0] === '-V') {
  version();
  process.exit(0);
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
  } else if (sub === 'rsi-all') {
    skillRSIAll(budget).catch(e => fatal(e.message));
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
