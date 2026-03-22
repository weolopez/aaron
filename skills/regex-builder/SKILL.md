---
name: regex-builder
description: Construct, explain, test, and debug regular expressions with named groups, lookaheads, character classes, quantifiers, and common patterns for emails, URLs, dates, and more
---

# Regular Expression Builder Skill

## Overview

Regular expressions are powerful tools for pattern matching, validation, and text processing. This skill provides a structured approach to constructing, explaining, testing, and debugging regex patterns with confidence.

## Core Approach

### 1. Pattern Construction Strategy

- **Start Simple**: Begin with basic character matching before adding quantifiers and advanced features
- **Build Incrementally**: Add complexity step-by-step, testing at each stage
- **Document Intent**: Write comments explaining what each part of the regex matches
- **Use Named Groups**: Leverage named capture groups for clarity and maintainability
- **Test Thoroughly**: Verify against positive and negative test cases

### 2. Regex Components Reference

#### Character Classes
- `[abc]` – Match any single character in the set
- `[^abc]` – Match any character NOT in the set
- `[a-z]` – Range: lowercase letters
- `\d` – Digit (0-9)
- `\w` – Word character (a-z, A-Z, 0-9, _)
- `\s` – Whitespace (space, tab, newline)
- `.` – Any character except newline

#### Quantifiers
- `*` – Zero or more (greedy)
- `+` – One or more (greedy)
- `?` – Zero or one (optional, greedy)
- `{n}` – Exactly n times
- `{n,}` – n or more times
- `{n,m}` – Between n and m times
- `*?`, `+?`, `??` – Non-greedy versions

#### Anchors & Assertions
- `^` – Start of string/line (with multiline flag)
- `$` – End of string/line (with multiline flag)
- `\b` – Word boundary
- `(?=...)` – Positive lookahead (assert without consuming)
- `(?!...)` – Negative lookahead
- `(?<=...)` – Positive lookbehind
- `(?<!...)` – Negative lookbehind

#### Groups & Capture
- `(...)` – Capturing group (stored in \1, \2, etc.)
- `(?<name>...)` – Named capturing group (accessed as `match.groups.name`)
- `(?:...)` – Non-capturing group (grouping without capture)
- `|` – Alternation (OR)

### 3. Common Pattern Templates

#### Email Validation
```
^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$
```

Simpler alternative:
```
^(?<email>[\w.-]+)@(?<domain>[\w.-]+\.\w{2,})$
```

#### URL Validation
```
^(?<protocol>https?|ftp):\/\/(?<domain>[\w.-]+)(?:\.\w{2,})?(?:\/[\w\-._~:/?#\[\]@!$&'()*+,;=]*)?$
```

#### ISO Date (YYYY-MM-DD)
```
^(?<year>\d{4})-(?<month>0[1-9]|1[0-2])-(?<day>0[1-9]|[12]\d|3[01])$
```

#### Phone Number (US)
```
^(?:\+1[-.]?)?(?<area>\d{3})[-.]?(?<exchange>\d{3})[-.]?(?<line>\d{4})$
```

#### Credit Card (16 digits)
```
^(?<card>\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})$
```

#### Hex Color Code
```
^#(?<color>[0-9a-fA-F]{6}|[0-9a-fA-F]{3})$
```

#### IPv4 Address
```
^(?<octet1>25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?<octet2>25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?<octet3>25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?<octet4>25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$
```

#### Markdown Heading
```
^(?<hashes>#+)\s+(?<title>.+?)(?:\s*#*\s*)?$
```

#### Username (alphanumeric + underscore, 3-16 chars)
```
^(?<username>[a-zA-Z0-9_]{3,16})$
```

#### Password (min 8 chars, at least one uppercase, digit, special char)
```
^(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$
```

## Testing & Debugging Process

### Test Suite Template

```javascript
const testRegex = (pattern, testCases, flags = '') => {
  const regex = new RegExp(pattern, flags);
  const results = [];
  
  for (const [input, shouldMatch] of testCases) {
    const matches = regex.test(input);
    const pass = matches === shouldMatch;
    results.push({
      input,
      expected: shouldMatch,
      actual: matches,
      pass,
      match: regex.exec(input)
    });
  }
  
  return results;
};

// Usage
const emailTests = [
  ['user@example.com', true],
  ['invalid.email@', false],
  ['test+tag@domain.co.uk', true],
];

const results = testRegex(emailPattern, emailTests);
results.forEach(r => console.log(`${r.input}: ${r.pass ? '✓' : '✗'}`));
```

### Debugging Checklist

- [ ] Is the pattern anchored correctly? (^ and $ for full match)
- [ ] Are quantifiers greedy or non-greedy as intended?
- [ ] Do character classes match all required characters?
- [ ] Are special characters escaped properly?
- [ ] Does the pattern handle edge cases (empty strings, boundaries)?
- [ ] Are named groups used for clarity?
- [ ] Have you tested against both positive and negative cases?
- [ ] Is the complexity justified, or can it be simplified?
- [ ] Does the pattern perform well on long inputs?
- [ ] Are there regex syntax errors (use regex tester tools)?

## Construction Workflow

### Phase 1: Planning
- [ ] Define the exact pattern to match
- [ ] Identify required vs. optional components
- [ ] List edge cases and invalid inputs
- [ ] Choose flags (global, multiline, case-insensitive, etc.)

### Phase 2: Build
- [ ] Start with character classes for basic matching
- [ ] Add quantifiers for repetition
- [ ] Incorporate groups for structure
- [ ] Use named groups for key components
- [ ] Add lookaheads/lookbehinds for context matching

### Phase 3: Test
- [ ] Create comprehensive test cases
- [ ] Test positive matches
- [ ] Test negative (non-matching) cases
- [ ] Test boundary/edge cases
- [ ] Test performance on large inputs

### Phase 4: Optimize
- [ ] Simplify if possible
- [ ] Remove unnecessary groups
- [ ] Consider alternation order (most specific first)
- [ ] Add comments for maintainability

### Phase 5: Document
- [ ] Explain what the regex matches
- [ ] Document named groups
- [ ] Provide usage examples
- [ ] Note any limitations or caveats

## Common Pitfalls

| Issue | Example | Solution |
|-------|---------|----------|
| Greedy vs. Non-greedy | `.*` matches too much | Use `.*?` for non-greedy |
| Missing Escapes | `.` matches any char, not literal dot | Use `\.` |
| Character Class Confusion | `[a-z-A-Z]` may not work as intended | Use `[a-zA-Z]` |
| Unclosed Groups | `(?<name>pattern` | Verify all groups are closed |
| Lookahead Backtracking | Performance issues with complex lookaheads | Simplify or use possessive quantifiers |
| Empty Alternatives | `(a|)` allows empty match | Remove empty alternative or make it non-matching |

## Output Formats

### Regex Documentation Template

```
Pattern: /^pattern$/flags
Purpose: [What this regex matches]

Components:
- ^pattern - Anchors and main matching logic

Named Groups:
- `groupName` – Description of what this captures

Test Cases:
✓ Valid: "example1", "example2"
✗ Invalid: "bad1", "bad2"

Performance: O(n) - linear time complexity
Compatibility: All modern browsers, Node.js 8+
```

### Explanation Format

Structure your regex explanations in layers:
1. **Overall Purpose**: One-sentence description
2. **Component Breakdown**: Each major part explained
3. **Named Groups**: What each capture group extracts
4. **Flags Used**: Why each flag is needed
5. **Examples**: Real input/output examples
6. **Edge Cases**: Known limitations or surprises

## Tools & Resources

- **Online Testers**: regex101.com, regexr.com, regexpal.com
- **Visual Debuggers**: regexper.com (shows syntax tree)
- **Performance**: Use `regex.test()` or `regex.exec()` timing
- **Validation**: Test in your target language/environment
- **Backup Plan**: Have a fallback function for complex validation

## Advanced Patterns

### Balanced Parentheses (Limited Depth)
```
^(\([^()]*\))*$
```

### Nested Quotes
```
^"(?:[^"\\]|\\.)*"$
```

### Markdown Links
```
\[(?<text>[^\]]+)\]\((?<url>[^)]+)\)
```

### Time (HH:MM:SS)
```
^(?<hours>[01]\d|2[0-3]):(?<minutes>[0-5]\d):(?<seconds>[0-5]\d)$
```

### Slug (URL-safe)
```
^(?<slug>[a-z0-9]+(?:-[a-z0-9]+)*)$
```

## Integration Guide

When using regex in code:

```javascript
// Define patterns as constants
const PATTERNS = {
  email: /^[\w.-]+@[\w.-]+\.\w{2,}$/i,
  url: /^https?:\/\/.+/i,
  phone: /^\+?1?\d{10}$/
};

// Create validator functions
const validators = {
  email: (str) => PATTERNS.email.test(str),
  phone: (str) => PATTERNS.phone.test(str)
};

// Use with error handling
try {
  const match = str.match(pattern);
  const groups = match?.groups || {};
} catch (e) {
  console.error('Regex error:', e.message);
}
```

## Summary

The regex-builder skill emphasizes:
1. **Methodical construction** from simple to complex
2. **Comprehensive testing** with positive and negative cases
3. **Named groups** for maintainability and clarity
4. **Clear documentation** of intent and usage
5. **Performance awareness** for production patterns
6. **Edge case handling** for robust validation
