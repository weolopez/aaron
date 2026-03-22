# Accessibility Patterns for Components

## Semantic Element Selection

| Component Type | Element | Required Attributes |
|---|---|---|
| Card/Panel | `<article>` or `<section>` | `role="region"`, `aria-label` |
| Navigation | `<nav>` | `aria-label="Primary navigation"` |
| Button | `<button>` | `type="button"` (not submit unless in form) |
| Link | `<a>` | `href`, descriptive text (not "click here") |
| List | `<ul>` / `<ol>` | `role="list"` if CSS removes bullets |
| Dialog/Modal | `<dialog>` or `<div>` | `role="dialog"`, `aria-modal="true"`, `aria-labelledby` |
| Tab panel | `<div>` | `role="tabpanel"`, `aria-labelledby` |
| Alert/Toast | `<div>` | `role="alert"`, `aria-live="assertive"` |
| Status | `<div>` | `role="status"`, `aria-live="polite"` |
| Form field | `<input>` | `id` + `<label for>`, `aria-describedby` for errors |
| Table | `<table>` | `<caption>`, `<thead>`, `scope="col"` on headers |

## ARIA Patterns

### Interactive button with toggle state

```js
const Toggle = (props = {}) => {
  const pressed = props.pressed ? 'true' : 'false';
  const label = esc(props.label ?? 'Toggle');
  return `<button type="button" aria-pressed="${pressed}" aria-label="${label}">
  ${esc(props.children ?? label)}
</button>`;
};
```

### Expandable/collapsible section

```js
const Accordion = (props = {}) => {
  const id = esc(props.id ?? 'section');
  const open = !!props.open;
  const title = esc(props.title ?? 'Section');
  return `<div class="accordion">
  <button type="button" aria-expanded="${open}" aria-controls="${id}-panel">
    ${title}
  </button>
  <div id="${id}-panel" role="region" aria-labelledby="${id}-btn" ${open ? '' : 'hidden'}>
    ${props.children ?? ''}
  </div>
</div>`;
};
```

### Tab interface

```js
const Tabs = (props = {}) => {
  const tabs = props.tabs ?? [];
  const active = props.active ?? 0;
  const tabButtons = tabs.map((t, i) =>
    `<button role="tab" aria-selected="${i === active}"
       aria-controls="panel-${i}" id="tab-${i}" tabindex="${i === active ? '0' : '-1'}">
      ${esc(t.label)}
    </button>`
  ).join('');
  const panels = tabs.map((t, i) =>
    `<div role="tabpanel" id="panel-${i}" aria-labelledby="tab-${i}"
       ${i !== active ? 'hidden' : ''}>
      ${t.content ?? ''}
    </div>`
  ).join('');
  return `<div class="tabs">
  <div role="tablist">${tabButtons}</div>
  ${panels}
</div>`;
};
```

### Form field with error

```js
const Field = (props = {}) => {
  const id = esc(props.id ?? 'field');
  const label = esc(props.label ?? 'Field');
  const error = props.error ? esc(props.error) : null;
  const errorId = `${id}-error`;
  return `<div class="field ${error ? 'field-error' : ''}">
  <label for="${id}">${label}</label>
  <input id="${id}" type="${esc(props.type ?? 'text')}"
    ${error ? `aria-invalid="true" aria-describedby="${errorId}"` : ''}
    value="${esc(props.value ?? '')}" />
  ${error ? `<div id="${errorId}" role="alert" class="error">${error}</div>` : ''}
</div>`;
};
```

## Keyboard Navigation Rules

- All interactive elements must be focusable (`tabindex="0"` if not natively focusable)
- Use `onkeydown` handlers for Enter and Space on custom buttons
- Escape key should close modals, dropdowns, and popovers
- Arrow keys navigate within composite widgets (tabs, menus, listboxes)
- Tab moves focus between components, not within them
- Focus must be visible — never `outline: none` without a replacement
