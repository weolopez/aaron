/**
 * XSS escape utility for component props.
 *
 * Copy this function into your component file.
 * Escapes all HTML-significant characters to prevent XSS
 * when interpolating user content into HTML strings.
 *
 * Usage:
 *   const title = esc(props.title ?? 'Default');
 *   return `<h2>${title}</h2>`;
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[m]);

/**
 * Escape for use inside HTML attribute values (double-quoted).
 * Same as esc() but makes the intent explicit.
 */
const escAttr = esc;

/**
 * Validate a component's output for common issues.
 * Returns an array of issue strings (empty = valid).
 *
 * Usage:
 *   const html = MyComponent({ title: 'Test' });
 *   const issues = validateComponent(html, 'MyComponent');
 */
function validateComponent(html, name) {
  const issues = [];
  if (typeof html !== 'string') issues.push(`${name} must return a string`);
  if (!html.trim()) issues.push(`${name} returned empty HTML`);
  if (!html.includes('role=') && !html.match(/<(nav|main|header|footer|article|section|button|a)\b/))
    issues.push(`${name} missing semantic element or ARIA role`);

  // Check for unescaped user content patterns
  if (html.includes('<script>')) issues.push(`${name} contains unescaped script tag`);

  return issues;
}
