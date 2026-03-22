---
name: documentation
description: Generate comprehensive documentation from code including README files, API reference docs, JSDoc comments, usage examples, and changelog entries
---

# Documentation Skill

Generate comprehensive documentation from code sources. This skill helps create README files, API reference docs, JSDoc comments, usage examples, and changelog entries that are accurate, maintainable, and developer-friendly.

## Approach

### 1. Code Analysis
- Parse source files to extract functions, classes, modules, and exports
- Identify function signatures, parameters, return types, and dependencies
- Extract existing comments and docstrings for enhancement
- Determine public API surface and internal implementation details
- Analyze imports and exports to understand module structure

### 2. Documentation Structure
- **README**: Project overview, installation, quick start, features, contributing
- **API Reference**: Complete function/class documentation with signatures and examples
- **JSDoc Comments**: Inline documentation for all public exports
- **Usage Examples**: Real-world code samples for common tasks
- **Changelog**: Version history with breaking changes, features, and fixes

### 3. Quality Standards
- Include parameter types and descriptions
- Provide return value documentation
- Document error cases and exceptions
- Add usage examples for every public function
- Maintain consistency in formatting and style
- Keep documentation synchronized with code

## Templates

### README Template
```markdown
# Project Name

Brief description of what the project does.

## Features
- Feature 1
- Feature 2
- Feature 3

## Installation

\`\`\`bash
npm install package-name
\`\`\`

## Quick Start

\`\`\`javascript
import { mainFunction } from 'package-name';

const result = mainFunction(options);
console.log(result);
\`\`\`

## API Reference

See [API.md](./API.md) for complete documentation.

## Examples

### Basic Usage
\`\`\`javascript
// Example code here
\`\`\`

### Advanced Usage
\`\`\`javascript
// Advanced example here
\`\`\`

## Contributing

Contributions welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
```

### API Reference Template
```markdown
# API Reference

## Functions

### functionName(param1, param2, options)

**Description**: Clear description of what this function does.

**Parameters**:
- `param1` (string): Description of param1
- `param2` (number): Description of param2
- `options` (object, optional):
  - `option1` (boolean, default: false): Description
  - `option2` (string): Description

**Returns**: (Promise<object>) Resolved with { key: value, ... }

**Throws**: 
- `TypeError`: If param1 is not a string
- `RangeError`: If param2 is negative

**Example**:
\`\`\`javascript
const result = await functionName('value', 42, { option1: true });
console.log(result);
\`\`\`

## Classes

### ClassName

**Description**: What this class does.

#### constructor(config)

**Parameters**:
- `config` (object):
  - `name` (string): Required name
  - `timeout` (number, default: 5000): Timeout in ms

#### methodName(arg)

**Description**: Method description.

**Parameters**:
- `arg` (any): Argument description

**Returns**: (any) Return description

**Example**:
\`\`\`javascript
const instance = new ClassName({ name: 'test' });
const result = instance.methodName('value');
\`\`\`
```

### JSDoc Template
```javascript
/**
 * Brief description of the function.
 *
 * Longer description explaining the purpose, behavior, and important details.
 * Can include multiple sentences or paragraphs.
 *
 * @param {string} param1 - Description of param1
 * @param {number} [param2=0] - Optional param2 with default value
 * @param {Object} options - Configuration object
 * @param {boolean} [options.flag=false] - Description of flag
 * @param {string[]} [options.items=[]] - Array of items
 *
 * @returns {Promise<Object>} Resolves with object containing:
 *   - `success` (boolean): Whether operation succeeded
 *   - `data` (any): Result data
 *
 * @throws {TypeError} If param1 is not a string
 * @throws {RangeError} If param2 is negative
 *
 * @example
 * // Basic usage
 * const result = await myFunction('test', 42);
 * console.log(result.success);
 *
 * @example
 * // With options
 * const result = await myFunction('test', 42, {
 *   flag: true,
 *   items: ['a', 'b']
 * });
 */
export function myFunction(param1, param2 = 0, options = {}) {
  // implementation
}
```

### Changelog Template
```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2024-01-15

### Added
- New feature description
- Another feature with use case

### Changed
- Behavior change description
- API improvement explanation

### Fixed
- Bug fix description
- Performance improvement

### Deprecated
- Deprecated API note

### Removed
- Removed feature explanation

### Security
- Security fix description

### Breaking Changes
- How to migrate from old API to new API

## [1.1.0] - 2024-01-01

### Added
- Initial release features
```

## Checklists

### Code Analysis Checklist
- [ ] Identify all exported functions and classes
- [ ] Extract existing JSDoc comments
- [ ] Determine parameter types and defaults
- [ ] Document return types and values
- [ ] List all thrown errors and exceptions
- [ ] Identify module dependencies and imports
- [ ] Note any async/Promise-based APIs
- [ ] Document configuration objects and options

### README Checklist
- [ ] Project name and one-line description
- [ ] List of key features
- [ ] Installation instructions
- [ ] Quick start code example
- [ ] Link to full API reference
- [ ] 2-3 usage examples
- [ ] Contributing guidelines link
- [ ] License information
- [ ] Links to documentation files

### API Reference Checklist
- [ ] Every public function documented
- [ ] Every public class documented
- [ ] All parameters described with types
- [ ] All return values documented
- [ ] Error cases and exceptions listed
- [ ] At least one example per function
- [ ] Default values noted
- [ ] Optional parameters marked
- [ ] Cross-references between related APIs

### JSDoc Checklist
- [ ] Concise one-line description
- [ ] Extended description for complex behavior
- [ ] All parameters documented with types
- [ ] Return value documented
- [ ] Exceptions/errors documented
- [ ] At least one usage example
- [ ] Optional parameters marked with brackets
- [ ] Default values specified
- [ ] Related functions linked with @see

### Changelog Checklist
- [ ] Version follows semantic versioning
- [ ] Date is present and ISO 8601 format
- [ ] Changes organized by: Added, Changed, Fixed, Deprecated, Removed, Security
- [ ] Each change is user-facing and descriptive
- [ ] Breaking changes clearly marked and explained
- [ ] Migration instructions included for breaking changes
- [ ] Links to closed issues or PRs (if applicable)
- [ ] Previous versions documented

## Best Practices

### 1. Keep Documentation Close to Code
- Place JSDoc comments directly above function definitions
- Update docs when code changes, not months later
- Use tools to validate JSDoc syntax

### 2. Write for Your Audience
- **README**: Target new users and quick start
- **API Reference**: Target developers using the API
- **JSDoc**: Target other developers reading the code
- **Examples**: Show real-world use cases and error handling

### 3. Use Real, Testable Examples
- Copy examples directly from working tests
- Test examples with actual code execution
- Show both success and error cases
- Include typical option combinations

### 4. Document Edge Cases
- Explain behavior with empty inputs
- Note type coercion or validation rules
- Document limitations and constraints
- Warn about common pitfalls

### 5. Maintain Consistency
- Use same terminology throughout
- Follow consistent formatting patterns
- Use consistent code style in examples
- Keep changelog entries at similar detail level

### 6. Make It Discoverable
- Include table of contents for long docs
- Use clear heading hierarchy
- Add internal links between related docs
- Cross-reference with @see tags in JSDoc

## Workflow

1. **Extract** code structure and existing comments
2. **Analyze** signatures, types, and behaviors
3. **Write** JSDoc comments for all exports
4. **Create** API reference from JSDoc
5. **Write** README with quick start
6. **Add** usage examples for common tasks
7. **Document** configuration objects in detail
8. **Create** changelog entry for release
9. **Validate** all code examples execute correctly
10. **Review** for consistency and completeness

## Tools & Integration

- **JSDoc Parsers**: Parse existing comments and metadata
- **Type Extractors**: Infer types from TypeScript or JSDoc
- **Code Samples**: Embed runnable examples in documentation
- **Changelog Generators**: Auto-generate from commits with conventional format
- **Linters**: Validate JSDoc completeness and format
- **Documentation Sites**: Deploy docs to sites like GitHub Pages
