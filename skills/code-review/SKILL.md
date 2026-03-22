---
name: code-review
description: Analyze code for bugs, security vulnerabilities, performance issues, code smells, naming conventions, and best practices with actionable improvement suggestions
---

# Code Review Skill

## Overview
Code review is a systematic process for evaluating code quality, identifying defects, and ensuring adherence to best practices. This skill provides structured approaches, templates, and checklists for comprehensive code analysis across multiple dimensions.

## Approach

### 1. Multi-Dimensional Analysis
Code review should examine code through multiple lenses:
- **Correctness**: Does the code do what it's supposed to do?
- **Security**: Are there vulnerabilities or unsafe patterns?
- **Performance**: Are there inefficient operations or unnecessary computations?
- **Maintainability**: Is the code clear, well-organized, and easy to understand?
- **Style**: Does it follow conventions and best practices?

### 2. Analysis Phases

#### Phase 1: High-Level Assessment
- Understand the purpose and context of the code
- Identify the programming language and framework
- Assess overall structure and organization
- Review entry points and main logic flow

#### Phase 2: Bug Detection
- Trace logic paths for edge cases
- Check error handling and exception management
- Verify boundary conditions (empty inputs, null values, max/min values)
- Look for off-by-one errors, type mismatches, and logic inversions
- Check async/await and promise handling
- Verify resource cleanup (file handles, connections, memory)

#### Phase 3: Security Review
- Validate input sanitization and validation
- Check for SQL injection, XSS, and injection vulnerabilities
- Review authentication and authorization logic
- Assess data protection and encryption
- Check for hardcoded secrets or credentials
- Verify secure defaults and privilege escalation risks
- Review third-party dependency versions

#### Phase 4: Performance Analysis
- Identify algorithmic inefficiencies (O(n²) loops, redundant computations)
- Check for unnecessary allocations and memory leaks
- Review database queries for N+1 problems
- Assess caching strategies and optimization opportunities
- Look for blocking operations in async contexts
- Check for debouncing/throttling where needed

#### Phase 5: Code Quality
- Verify naming clarity (variables, functions, classes)
- Check function size and complexity (cyclomatic complexity)
- Review code duplication and DRY principle adherence
- Assess comment quality and documentation
- Check for dead code and unused variables
- Review parameter counts and function signatures

#### Phase 6: Best Practices
- Verify language-specific conventions
- Check design pattern appropriateness
- Review error handling strategy consistency
- Assess test coverage and test quality
- Verify dependency management and imports
- Check configuration and environment handling

## Code Review Checklist

### Correctness & Logic
- [ ] Does the function/module accomplish its stated purpose?
- [ ] Are all code paths tested and working correctly?
- [ ] Are edge cases (null, empty, zero, negative) handled?
- [ ] Are boundary conditions checked?
- [ ] Is the logic correct for all inputs within specification?
- [ ] Are off-by-one errors avoided?
- [ ] Are type conversions explicit and safe?
- [ ] Is error handling comprehensive?

### Security
- [ ] Is all user input validated and sanitized?
- [ ] Are SQL queries parameterized (no string concatenation)?
- [ ] Is output encoded appropriately (HTML, URL, JavaScript)?
- [ ] Are secrets/credentials not hardcoded?
- [ ] Is authentication properly implemented?
- [ ] Is authorization properly enforced?
- [ ] Are sensitive operations logged appropriately?
- [ ] Are dependencies pinned to secure versions?
- [ ] Is HTTPS enforced for external communications?
- [ ] Is sensitive data encrypted at rest and in transit?

### Performance
- [ ] Are algorithms optimal for the use case?
- [ ] Are there obvious O(n²) loops or inefficiencies?
- [ ] Is caching used where appropriate?
- [ ] Are database queries optimized?
- [ ] Is there an N+1 query problem?
- [ ] Are unnecessary computations avoided?
- [ ] Is memory usage reasonable?
- [ ] Are blocking operations avoided in async code?
- [ ] Is regex efficient (no catastrophic backtracking)?

### Maintainability & Clarity
- [ ] Are variable names clear and descriptive?
- [ ] Are function names clear about what they do?
- [ ] Is the code DRY (no unnecessary duplication)?
- [ ] Is the function size reasonable (< 50 lines is often good)?
- [ ] Is complexity at acceptable levels?
- [ ] Are comments explaining "why", not "what"?
- [ ] Is the code easily testable?
- [ ] Are dependencies minimal and explicit?
- [ ] Is the code following language conventions?

### Testing & Documentation
- [ ] Are critical paths tested?
- [ ] Are edge cases covered?
- [ ] Is test coverage at acceptable levels?
- [ ] Are tests clear and well-named?
- [ ] Is public API documented?
- [ ] Are complex algorithms explained?
- [ ] Is there a README or usage guide?
- [ ] Are dependencies documented?

## Review Template

```markdown
## Code Review: [File/Module Name]

### Summary
- **Purpose**: [What does this code do?]
- **Size**: [Lines, functions, complexity]
- **Risk Level**: [Low/Medium/High]

### ✅ Strengths
- [Clear strength 1]
- [Clear strength 2]

### 🐛 Bugs Found
- **Issue**: [Description]
  - **Severity**: [Critical/High/Medium/Low]
  - **Location**: [File:Line]
  - **Fix**: [Suggested solution]

### 🔒 Security Concerns
- **Issue**: [Description]
  - **Risk**: [Description of risk]
  - **Fix**: [Suggested solution]

### ⚡ Performance Issues
- **Issue**: [Description]
  - **Impact**: [Description of impact]
  - **Fix**: [Suggested solution]

### 🏗️ Code Quality & Maintainability
- **Issue**: [Description]
  - **Category**: [Naming/Structure/Duplication/Complexity]
  - **Fix**: [Suggested solution]

### 📋 Best Practices
- **Issue**: [Description]
  - **Standard**: [Which best practice]
  - **Fix**: [Suggested solution]

### 🎯 Action Items
- [ ] [Required fix 1]
- [ ] [Suggested improvement 1]
- [ ] [Optional enhancement 1]

### Overall Assessment
[Summary of code quality and recommendation to approve/request changes]
```

## Analysis Pattern: JavaScript/TypeScript

```javascript
// Pattern for analyzing JavaScript code structure
const analyzeCode = (code) => {
  return {
    // Security checks
    security: {
      hasEval: code.includes('eval('),
      hardcodedSecrets: /password|secret|key|token/i.test(code),
      sqlInjectionRisk: /\+ *[\w"'].*\+/.test(code),
      xssRisk: /innerHTML|dangerouslySetInnerHTML/.test(code),
    },
    
    // Performance checks
    performance: {
      nestedLoops: (code.match(/for.*\n.*for/g) || []).length,
      syncWaits: /Thread\.sleep|sleep\(/.test(code),
      regexComplexity: /\([^)]{50,}\)/.test(code),
    },
    
    // Maintainability checks
    maintainability: {
      functionLineCount: Math.max(...(code.match(/function[^{]*\{([^}]*)\}/g) || [''])[0].split('\n').length),
      variableNaming: /[a-z]{1}[^=]*=/.test(code),
      commentRatio: (code.match(/\/\/|^\/\*[^*]*\*\//gm) || []).length / code.split('\n').length,
      duplication: detectDuplication(code),
    },
  };
};

const detectDuplication = (code) => {
  const lines = code.split('\n');
  const lineMap = {};
  let duplicates = 0;
  
  lines.forEach(line => {
    const trimmed = line.trim();
    lineMap[trimmed] = (lineMap[trimmed] || 0) + 1;
    if (lineMap[trimmed] > 1) duplicates++;
  });
  
  return duplicates;
};
```

## Common Bug Patterns

### Logic Errors
- **Type coercion issues**: `if (x == 0)` vs `if (x === 0)`
- **Off-by-one errors**: Loop conditions using `<` vs `<=`
- **Null/undefined checks**: Missing checks before property access
- **Copy vs reference**: Forgetting to deep clone objects/arrays
- **Async/await**: Forgetting await, race conditions

### Resource Leaks
- Unclosed file handles, database connections, streams
- Event listeners not removed
- Timer cleanup (setInterval/setTimeout)
- Memory leaks from circular references

### Boundary Conditions
- Empty arrays/strings/collections
- Negative numbers when expecting positive
- Maximum/minimum value handling
- Division by zero
- Stack overflow from deep recursion

## Common Security Vulnerabilities

| Vulnerability | Pattern | Fix |
|--------------|---------|-----|
| SQL Injection | `'SELECT * FROM users WHERE id=' + id` | Use parameterized queries |
| XSS | `element.innerHTML = userInput` | Use textContent or sanitize |
| CSRF | Missing token validation | Add token to state-changing requests |
| Authentication | No session validation | Validate on each request |
| Secrets | `const API_KEY = '...'` | Use environment variables |
| Dependency | Outdated packages | Run `npm audit` and update |
| Path Traversal | `fs.readFile(userPath)` | Validate and normalize paths |

## Performance Anti-Patterns

| Anti-Pattern | Problem | Solution |
|------------|---------|----------|
| N+1 Queries | Loop making DB queries | Batch queries or use JOINs |
| Inefficient Sorting | `O(n²)` algorithm | Use `O(n log n)` sort |
| Missing Cache | Recalculating same values | Add memoization/cache |
| Sync I/O in Async | `fs.readFileSync()` | Use async `fs.readFile()` |
| No Debounce | Event handler fires per keystroke | Add debounce wrapper |
| Memory Leak | Global references accumulate | Clean up event listeners |

## Best Practices by Language

### JavaScript/TypeScript
- Use `const` by default, `let` when needed, avoid `var`
- Use async/await instead of callbacks
- Validate input and return types
- Use `?.optional` chaining
- Implement proper error handling
- Use destructuring for clarity
- Avoid side effects in pure functions

### Python
- Follow PEP 8 style guide
- Use type hints for clarity
- Implement `__repr__` and `__str__`
- Use context managers for resource handling
- Avoid mutable default arguments
- Use list comprehensions appropriately
- Handle exceptions specifically

### SQL
- Use parameterized queries always
- Index frequently queried columns
- Avoid SELECT * in production
- Use EXPLAIN PLAN for optimization
- Implement proper constraints
- Use transactions for consistency
- Comment complex logic

## Review Workflow

1. **Understand Context**: Read description, requirements, and related issues
2. **Scan Structure**: Review file organization and overall flow
3. **Deep Dive**: Analyze critical sections line by line
4. **Cross-Reference**: Check dependencies and related code
5. **Categorize Issues**: Group by severity and type
6. **Document Findings**: Use template and provide actionable feedback
7. **Prioritize**: Mark critical issues requiring fixes before merge
8. **Provide Examples**: Show correct patterns for suggested changes

## Tools & Commands

### Code Analysis Tools
```bash
# JavaScript/TypeScript
npm run lint              # ESLint
npm run type-check       # TypeScript
npm audit                # Security vulnerabilities
npm test                 # Test coverage

# Python
pylint file.py          # Linting
mypy file.py            # Type checking
bandit -r .             # Security analysis
coverage run -m pytest  # Test coverage

# General
git diff --check        # Whitespace issues
cyclomatic_complexity   # Complexity analysis
```

## Example Review

**Code:**
```javascript
function processUsers(users) {
  let result = [];
  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const processed = {
      name: user.name,
      email: user.email,
      active: user.active == true
    };
    result.push(processed);
  }
  return result;
}
```

**Issues Found:**

1. **Type Comparison (Medium)**: `== true` should be `=== true`
2. **Array Method (Low)**: Use `map()` instead of manual loop
3. **Naming (Low)**: `result` should be `processedUsers`

**Improved Code:**
```javascript
function processUsers(users) {
  return users.map(user => ({
    name: user.name,
    email: user.email,
    active: user.active === true
  }));
}
```
