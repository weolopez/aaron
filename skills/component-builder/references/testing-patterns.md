# Testing Patterns for Components

## Test Structure

Every component test file follows the same pattern:

```js
// 1. Import
import { ComponentName } from './<name>.js';

// 2. Basic rendering
const html = ComponentName();
console.assert(html.includes('<'), 'produces HTML');

// 3. Props rendering
const propsHtml = ComponentName({ title: 'Test' });
console.assert(propsHtml.includes('Test'), 'renders title prop');

// 4. Children rendering
const childHtml = ComponentName({}, '<p>Child</p>');
console.assert(childHtml.includes('<p>Child</p>'), 'renders children');

// 5. XSS prevention
const xssHtml = ComponentName({ title: '<script>alert(1)</script>' });
console.assert(!xssHtml.includes('<script>'), 'escapes XSS in props');

// 6. Accessibility
console.assert(propsHtml.includes('role='), 'has ARIA role');
console.assert(propsHtml.includes('aria-'), 'has ARIA attributes');

console.log('all tests passed');
```

## Edge Cases to Always Test

```js
// Null/undefined props
console.assert(ComponentName(null) !== undefined, 'handles null props');
console.assert(ComponentName(undefined) !== undefined, 'handles undefined props');
console.assert(ComponentName({}) !== '', 'handles empty props');

// Long content
const longTitle = 'A'.repeat(1000);
console.assert(ComponentName({ title: longTitle }).includes('AAAA'), 'handles long content');

// Special characters (XSS vectors)
const vectors = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "'; DROP TABLE users; --",
  '{{constructor.constructor("alert(1)")()}}',
];
for (const v of vectors) {
  const html = ComponentName({ title: v });
  console.assert(!html.includes('<script>'), `escapes: ${v.slice(0, 20)}`);
  console.assert(!html.includes('onerror'), `escapes event handler: ${v.slice(0, 20)}`);
}

// Empty children
console.assert(ComponentName({}, '').includes('<'), 'handles empty children');
```

## Composition Tests

```js
// Components compose correctly
const inner = InnerComponent({ label: 'inner' });
const outer = OuterComponent({}, inner);
console.assert(outer.includes('inner'), 'nested components render');

// Multiple children compose
const items = ['A', 'B', 'C'].map(x => Item({ label: x }));
const list = List({}, items.join(''));
console.assert(list.includes('A'), 'first child renders');
console.assert(list.includes('C'), 'last child renders');
```

## Verifiable Output Pattern

Write intermediate output to `/scratch/`, verify, then write final to `/artifacts/`:

```js
// 1. Generate component
const componentCode = `export const Widget = (props) => ...`;

// 2. Write draft to scratch
context.vfs.write('/scratch/widget-draft.js', componentCode);

// 3. Run validation (inline)
const issues = [];
if (!componentCode.includes('esc(')) issues.push('missing XSS escaping');
if (!componentCode.includes('role=')) issues.push('missing ARIA role');
if (!componentCode.includes('aria-')) issues.push('missing ARIA attributes');

// 4. If valid, promote to artifacts
if (issues.length === 0) {
  context.vfs.write('/artifacts/widget.js', componentCode);
} else {
  context.emit({ type: 'progress', message: `Issues: ${issues.join(', ')}` });
  // Fix and retry
}
```
