---
name: component-builder
description: Build isomorphic UI components as pure render functions returning HTML strings
---

# Component Builder

Build UI components that work identically in browser and Node.js.

## Approach

1. **Pure render functions** — every component is `(props, children) => htmlString`
2. **No DOM APIs** — no `document`, no `window`, no side effects
3. **Composable** — nest components by calling them inside template literals
4. **Testable** — assert on returned HTML strings with `.includes()` / `.match()`

## Structure

```
/artifacts/<name>.js     — component module (ESM, named exports)
/artifacts/<name>.test.js — tests (assertions, no framework)
```

## Component Template

```js
// Escape user content to prevent XSS
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[m]);

export const ComponentName = (props = {}, children = '') => {
  const title = esc(props.title ?? 'Default');
  return `<section class="component-name" role="region" aria-label="${title}">
  <h2>${title}</h2>
  <div class="content">${children}</div>
</section>`;
};
```

## Testing Template

```js
import { ComponentName } from './component-name.js';

const html = ComponentName({ title: 'Hello' }, '<p>body</p>');
console.assert(html.includes('Hello'), 'renders title');
console.assert(html.includes('<p>body</p>'), 'renders children');
console.assert(html.includes('role="region"'), 'has aria role');
console.assert(html.includes('aria-label="Hello"'), 'has aria-label');

// XSS safety
const xss = ComponentName({ title: '<script>alert(1)</script>' });
console.assert(!xss.includes('<script>'), 'escapes XSS in title');

console.log('all tests passed');
```

## Checklist

- [ ] Named export (not default)
- [ ] Props destructured with defaults
- [ ] User content escaped via `esc()`
- [ ] Semantic HTML5 elements
- [ ] Accessibility attributes (role, aria-label)
- [ ] Test file with structure + content + XSS assertions
- [ ] `context.emit({ type: 'done' })` at the end
