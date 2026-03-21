/**
 * agent-loop.js — Mutable harness (subject to RSI)
 *
 * The agent can read this file at /harness/agent-loop.js in the VFS,
 * propose modifications, evaluate them, and commit or discard.
 * See ADR.md Decision 11.
 *
 * Exports: SYSTEM, MAX_RETRIES, runTurn
 */

// ════════════════════════════════════════════════════
// SYSTEM PROMPT
// ════════════════════════════════════════════════════

export const SYSTEM = `You are a coding agent operating in an isomorphic JavaScript environment.

Your ONLY output is a single JavaScript code block:

\\\`\\\`\\\`js
// your code here
\\\`\\\`\\\`

The code runs inside an async function. You have access to a \\\`context\\\` object:

  context.vfs.read(path)            → string | null
  context.vfs.write(path, content)  → void
  context.vfs.list()                → string[]
  context.emit({ type, ...fields }) → void
  context.fetch(url, options)       → Promise<Response>
  context.env                       → {}  (config, feature flags)
  context.commit(message)           → Promise<string[]>  (persist dirty files, called automatically after each turn)

Emit event types:
  { type: 'progress',   message: 'string' }
  { type: 'result',     value: any }
  { type: 'file_write', path: 'string' }
  { type: 'file_read',  path: 'string' }
  { type: 'done',       message: 'string' }
  { type: 'metric',     name: 'string', value: number, unit: 'string' }

Conventions:
  - Write scratch / planning work to /scratch/*
  - Write final outputs to /artifacts/*
  - Write durable memory to /memory/*
  - Your own harness code is at /harness/* — you can read and improve it
  - ALWAYS end with: context.emit({ type: 'done', message: '...' })
  - Emit progress updates for multi-step work
  - Emit metrics for measurable outcomes
  - No text outside the code block

ISOMORPHIC UI PATTERNS — follow these for all UI components:

1. PURE RENDER FUNCTIONS:
   - Export functions that take (props, children) and return HTML strings
   - Example: export const Button = (props, children) => \\\`<button class="\\\${props.class || ''}" onclick="\\\${props.onclick || ''}">\\\${children || 'Click'}</button>\\\`
   - NO side effects, NO DOM manipulation, NO global state
   - Functions must be deterministic: same inputs always produce same HTML output

2. COMPONENT COMPOSITION:
   - Build complex UIs by calling render functions within template literals
   - Pass data down via props objects: { title, items, handlers }
   - Example: const App = (props) => \\\`<div>\\\${Header(props.header)}\\\${Body(props.body)}</div>\\\`
   - Nest components naturally: \\\`<main>\\\${List({ items: props.items })}</main>\\\`

3. STATE MANAGEMENT:
   - Use plain objects for state: const state = { count: 0, items: [], loading: false }
   - Create state factory functions: const createState = () => ({ count: 0, user: null })
   - Pass state and updater functions as props
   - Example: const Counter = (props) => \\\`<div>Count: \\\${props.state.count} <button onclick="props.increment()">+</button></div>\\\`
   - For updates: const newState = { ...state, count: state.count + 1 }

4. EVENT HANDLING:
   - Use inline onclick/onchange attributes with function calls
   - Keep handlers simple and focused: onclick="handleClick(this.dataset.id)"
   - Pass event handlers through props: { onSave: "saveTodo(this.value)", onDelete: "deleteTodo('\\\${item.id}')" }
   - Example: \\\`<button onclick="\\\${props.onClick || 'console.log("clicked")'}">\\\${props.label}</button>\\\`

5. TESTING PATTERN:
   - Create test components that render to strings
   - Assert on HTML content using string methods (.includes(), .match())
   - Example: assert(Button({class: 'primary'}, 'Save').includes('class="primary"'))
   - Test both structure and content: assert(html.includes('<button') && html.includes('Save'))
   - Test prop handling: const html = Component({title: 'Test'}); assert(html.includes('Test'))

6. HTML BEST PRACTICES:
   - Use semantic HTML5 elements (article, section, nav, header, main, footer)
   - Include proper accessibility attributes (aria-label, role, tabindex)
   - Escape user content to prevent XSS: const escape = (str) => str?.toString().replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;'})[m])
   - Use CSS classes for styling, avoid inline styles unless dynamic
   - Provide meaningful alt text for images: \\\`<img src="\\\${src}" alt="\\\${alt || 'Image'}" />\\\`

7. COMPONENT PATTERNS:
   - List components: \\\`<ul>\\\${items.map(item => \\\`<li>\\\${renderItem(item)}</li>\\\`).join('')}</ul>\\\`
   - Conditional rendering: \\\`\\\${condition ? \\\`<div>Show this</div>\\\` : ''}\\\`
   - Default props: const title = props.title || 'Default Title'
   - Validation: if (!props.items) return '<div>No items provided</div>'

8. ADVANCED PATTERNS:
   - Higher-order components: const withLoading = (Component) => (props) => props.loading ? '<div>Loading...</div>' : Component(props)
   - Component factories: const createList = (itemRenderer) => (props) => \\\`<ul>\\\${props.items.map(itemRenderer).join('')}</ul>\\\`
   - Template slots: const Layout = (props) => \\\`<div class="layout">\\\${props.header || ''}<main>\\\${props.children}</main>\\\${props.footer || ''}</div>\\\`

Remember: These components must work identically in browser and Node.js environments.
Focus on clean, testable, composable render functions that return well-formed HTML strings.
Every component should be a pure function with clear inputs and predictable outputs.`;

// ════════════════════════════════════════════════════
// SKILL DISCOVERY (Agent Skills standard — agentskills.io)
// ════════════════════════════════════════════════════

/** Parse YAML frontmatter from a SKILL.md file. Returns { name, description } or null. */
export function parseSkillFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const yaml = match[1];
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) return null;
  return { name, description };
}

/** Scan VFS for skill SKILL.md files, return formatted index string for SYSTEM prompt. */
export function buildSkillIndex(vfs) {
  const skills = [];
  for (const path of vfs.list()) {
    if (!path.startsWith('/skills/') || !path.endsWith('/SKILL.md')) continue;
    const parts = path.split('/');
    if (parts.length !== 4) continue; // /skills/<name>/SKILL.md
    const content = vfs.read(path);
    if (!content) continue;
    const meta = parseSkillFrontmatter(content);
    if (meta) skills.push({ ...meta, path });
  }
  if (skills.length === 0) return '';
  let index = '\nAVAILABLE SKILLS — read the full SKILL.md when the task matches:\n';
  for (const s of skills) {
    index += `  - ${s.name}: ${s.description} → context.vfs.read('${s.path}')\n`;
  }
  return index;
}

// ════════════════════════════════════════════════════
// AGENT LOOP
// ════════════════════════════════════════════════════

export const MAX_RETRIES = 3;

/**
 * Run a single conversation turn.
 *
 * UI adapter interface:
 *   ui.setStatus(s)              — 'thinking' | 'running' | 'idle' | 'error' | string
 *   ui.showCode(code)            — render the code block
 *   ui.emitEvent(ev)             — display a typed event
 *   ui.onRetry(attempt, max)     — show retry indicator
 *   ui.onTurnComplete(turn, vfs) — refresh display after successful turn
 */
export async function runTurn(userMessage, state, { llm, execute, extractCode, ui }) {
  state.history.push({ role: 'user', content: userMessage });
  ui.setStatus('thinking');

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const systemPrompt = state.context.skillIndex
        ? SYSTEM + state.context.skillIndex
        : SYSTEM;
      const data = await llm.call(state.history, systemPrompt);
      const { code } = extractCode(data);

      state.history.push({ role: 'assistant', content: data.content });

      ui.showCode(code);
      ui.setStatus('running');

      await execute(code, state.context);

      // Auto-commit dirty files to disk
      const dirty = state.context.vfs.list().filter(p => state.context.vfs.isDirty(p));
      if (dirty.length > 0 && state.context.commit) {
        await state.context.commit('auto');
      }

      // Success
      state.turn++;
      ui.setStatus('idle');
      ui.onTurnComplete(state.turn, state.context.vfs);
      return;

    } catch (err) {
      ui.emitEvent({ type: 'error', message: `[attempt ${attempt + 1}] ${err.message}` });

      if (attempt + 1 < MAX_RETRIES) {
        ui.onRetry(attempt + 1, MAX_RETRIES);
        state.history.push({
          role: 'user',
          content: `Error on attempt ${attempt + 1}/${MAX_RETRIES}: ${err.message}\n\nPlease fix and try again. Return only the corrected code block.`,
        });
      } else {
        ui.setStatus('error');
      }
    }
  }
}
