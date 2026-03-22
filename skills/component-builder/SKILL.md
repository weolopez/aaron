---
name: component-builder
description: Build isomorphic UI components as pure render functions returning HTML strings. Use when creating UI components, widgets, cards, lists, forms, dashboards, or interactive elements.
---

# Component Builder

Build UI components that work identically in browser and Node.js.

## When to use

- Creating UI components (cards, buttons, lists, forms, dashboards)
- Building reusable render functions
- Testing component output with string assertions

## Approach

1. **Pure render functions** — `(props, children) => htmlString`
2. **No DOM APIs** — no `document`, `window`, or side effects
3. **Composable** — nest components inside template literals
4. **Testable** — assert on returned HTML strings

## Workflow

Copy and track progress:

```
Component Progress:
- [ ] Step 1: Define component API (props, defaults)
- [ ] Step 2: Implement render function with XSS escaping
- [ ] Step 3: Add accessibility (ARIA, semantic HTML)
- [ ] Step 4: Write tests (structure, content, XSS, edge cases)
- [ ] Step 5: Validate with checklist
```

### Step 1: Define Component API

Identify all props. Set sensible defaults. Plan children slot usage.

```js
const Card = (props = {}, children = '') => {
  const title = props.title ?? 'Untitled';
  const variant = props.variant ?? 'default';
  // ...
};
```

### Step 2: Implement with XSS Escaping

**CRITICAL**: Always escape user-provided content to prevent XSS.

Read the escape utility for the canonical implementation:
→ `context.vfs.read('/skills/component-builder/scripts/escape.js')`

```js
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[m]);

export const Card = (props = {}, children = '') => {
  const title = esc(props.title ?? 'Untitled');
  return `<article class="card" role="region" aria-label="${title}">
  <h2>${title}</h2>
  <div class="card-body">${children}</div>
</article>`;
};
```

### Step 3: Accessibility

Read the accessibility reference for ARIA patterns by component type:
→ `context.vfs.read('/skills/component-builder/references/accessibility.md')`

Key rules:
- Use semantic HTML5 elements (`article`, `section`, `nav`, not `div`)
- Add `role` and `aria-label` on containers
- Interactive elements need keyboard support (`tabindex`, key handlers)

### Step 4: Write Tests

Read the testing reference for assertion strategies and edge cases:
→ `context.vfs.read('/skills/component-builder/references/testing-patterns.md')`

```js
const html = Card({ title: 'Hello' }, '<p>body</p>');
console.assert(html.includes('Hello'), 'renders title');
console.assert(html.includes('<p>body</p>'), 'renders children');
console.assert(!Card({ title: '<script>' }).includes('<script>'), 'escapes XSS');
```

### Step 5: Validate

- [ ] Named export (not default)
- [ ] Props destructured with defaults
- [ ] User content escaped via `esc()`
- [ ] Semantic HTML5 elements
- [ ] Accessibility attributes (role, aria-label)
- [ ] Test file with structure + content + XSS assertions
- [ ] `context.emit({ type: 'done' })` at the end

## Conditional Workflows

**Simple component?** → Implement inline, write tests, validate

**Complex component with state?** → Write plan to `/scratch/component-plan.md` first:
1. List all states and transitions
2. Define props interface
3. Implement, then test each state

**Component system?** → Build base components first, compose into complex ones

## Output Structure

```
/artifacts/<name>.js       — component module (ESM, named exports)
/artifacts/<name>.test.js  — tests (assertions, no framework)
/artifacts/<name>.css      — styles (optional)
```

## Component Patterns

### List rendering
```js
const List = (props = {}) => {
  const items = props.items ?? [];
  if (items.length === 0) return '<p>No items</p>';
  return `<ul role="list">${items.map(item =>
    `<li>${esc(item)}</li>`).join('')}</ul>`;
};
```

### Conditional rendering
```js
const Alert = (props = {}) => {
  if (!props.message) return '';
  const type = props.type ?? 'info';
  return `<div role="alert" class="alert alert-${esc(type)}">
  ${esc(props.message)}
</div>`;
};
```

### Composition
```js
const Page = (props = {}) => `
<main>
  ${Header(props.header)}
  ${Content(props, props.children)}
  ${Footer(props.footer)}
</main>`;
```

### Higher-order component
```js
const withLoading = (Component) => (props) =>
  props.loading ? '<div aria-busy="true">Loading…</div>' : Component(props);
```
