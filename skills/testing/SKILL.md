---
name: testing
description: Write comprehensive test suites with unit tests, integration tests, assertions, mocking, edge case coverage, and test-driven development patterns
---

# Testing Skill

## Overview

This skill enables writing comprehensive test suites that cover unit tests, integration tests, assertions, mocking, edge case coverage, and test-driven development patterns. Build reliable, maintainable code through systematic testing strategies.

## Core Approach

### 1. Test Pyramid Strategy
- **Unit Tests** (70%): Test individual functions and components in isolation
- **Integration Tests** (20%): Test interactions between modules and APIs
- **E2E Tests** (10%): Test complete user workflows

### 2. Test-Driven Development (TDD)
1. Write failing test first (Red)
2. Write minimal code to pass (Green)
3. Refactor and improve (Refactor)
4. Repeat for next feature

### 3. Assertion Patterns
- Use descriptive assertion messages
- Test both success and failure paths
- Validate edge cases and boundary conditions
- Assert on outputs, not internal implementation

### 4. Mocking & Stubbing
- Mock external dependencies (APIs, databases, file systems)
- Stub functions to control behavior in tests
- Use dependency injection for testability
- Isolate units under test

## Templates

### Basic Unit Test Template
```js
const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
};

const describe = (suite, fn) => {
  console.log(`📋 ${suite}`);
  try { fn(); } catch (e) { console.error(`  ❌ ${e.message}`); }
};

const it = (test, fn) => {
  try {
    fn();
    console.log(`  ✓ ${test}`);
  } catch (e) {
    console.error(`  ✗ ${test}: ${e.message}`);
  }
};

// Usage:
describe('Calculator', () => {
  it('adds numbers correctly', () => {
    const result = add(2, 3);
    assert(result === 5, 'Expected 2 + 3 to equal 5');
  });

  it('handles negative numbers', () => {
    const result = add(-2, 3);
    assert(result === 1, 'Expected -2 + 3 to equal 1');
  });

  it('handles zero', () => {
    const result = add(0, 0);
    assert(result === 0, 'Expected 0 + 0 to equal 0');
  });
});
```

### Mock Function Template
```js
const createMock = () => {
  const mock = function(...args) {
    mock.calls.push(args);
    return mock.returnValue;
  };
  mock.calls = [];
  mock.returnValue = undefined;
  mock.returns = (value) => { mock.returnValue = value; return mock; };
  mock.calledWith = (...args) => mock.calls.some(c => JSON.stringify(c) === JSON.stringify(args));
  mock.callCount = () => mock.calls.length;
  return mock;
};

// Usage:
const fetchMock = createMock().returns(Promise.resolve({ data: 'test' }));
await fetchMock();
assert(fetchMock.callCount() === 1, 'fetch should be called once');
assert(fetchMock.calledWith(), 'fetch should be called');
```

### Integration Test Template
```js
const testIntegration = async () => {
  // Setup: Create isolated test environment
  const testDb = createMemoryDb();
  const service = createService(testDb);

  // Act: Execute integrated behavior
  const user = await service.createUser({ name: 'Test', email: 'test@example.com' });
  const retrieved = await service.getUser(user.id);

  // Assert: Verify end-to-end behavior
  assert(retrieved.name === 'Test', 'User name should persist');
  assert(retrieved.email === 'test@example.com', 'User email should persist');

  // Cleanup
  await testDb.close();
};
```

### Edge Case Coverage Template
```js
describe('String Utils', () => {
  describe('trim()', () => {
    // Happy path
    it('removes leading and trailing whitespace', () => {
      assert(trim('  hello  ') === 'hello');
    });

    // Edge cases
    it('handles empty string', () => {
      assert(trim('') === '');
    });

    it('handles string with only whitespace', () => {
      assert(trim('   ') === '');
    });

    it('handles strings with tabs and newlines', () => {
      assert(trim('\t hello \n') === 'hello');
    });

    it('handles single character', () => {
      assert(trim(' a ') === 'a');
    });

    it('preserves internal whitespace', () => {
      assert(trim('  hello world  ') === 'hello world');
    });

    // Boundary conditions
    it('handles very long strings', () => {
      const long = ' ' + 'x'.repeat(10000) + ' ';
      assert(trim(long) === 'x'.repeat(10000));
    });
  });
});
```

## Testing Checklist

### Before Writing Code
- [ ] Identify test cases (happy path, edge cases, error cases)
- [ ] Plan mock dependencies
- [ ] Define expected behavior in tests
- [ ] Structure test file organization

### While Writing Tests
- [ ] Write test name that describes expected behavior
- [ ] Use clear Arrange-Act-Assert (AAA) pattern
- [ ] Test one thing per test
- [ ] Use descriptive assertion messages
- [ ] Mock external dependencies

### Edge Cases to Cover
- [ ] Empty/null/undefined inputs
- [ ] Boundary values (0, -1, max, min)
- [ ] Large data sets
- [ ] Special characters and unicode
- [ ] Async errors and timeouts
- [ ] Network failures (for integration tests)
- [ ] Permission/authorization issues
- [ ] Type mismatches and invalid inputs

### Test Organization
- [ ] Tests in /tests or *.test.js files
- [ ] One test suite per module
- [ ] Related tests grouped in describe blocks
- [ ] Shared setup/teardown code in beforeEach/afterEach
- [ ] Clear test names matching: "should [expected outcome] when [condition]"

### Coverage Goals
- [ ] Aim for 80%+ code coverage
- [ ] 100% coverage of critical paths
- [ ] All error paths tested
- [ ] All branches tested

## Common Patterns

### Testing Async Code
```js
it('should fetch user data', async () => {
  const user = await fetchUser(1);
  assert(user.id === 1, 'Should return correct user');
});

it('should handle fetch errors', async () => {
  try {
    await fetchUser(-1);
    assert(false, 'Should have thrown error');
  } catch (e) {
    assert(e.message.includes('not found'), 'Should be 404 error');
  }
});
```

### Testing Component Output
```js
it('should render button with correct text', () => {
  const html = Button({ label: 'Save' });
  assert(html.includes('<button'), 'Should render button element');
  assert(html.includes('Save'), 'Should include button text');
});

it('should apply CSS class', () => {
  const html = Button({ class: 'primary' });
  assert(html.includes('class="primary"'), 'Should have primary class');
});
```

### Testing with Dependencies
```js
const createUserService = (database) => ({
  create: async (user) => database.insert('users', user),
  get: async (id) => database.query('users', { id })
});

it('should create and retrieve user', async () => {
  const dbMock = { insert: createMock(), query: createMock().returns(Promise.resolve({ id: 1, name: 'Test' })) };
  const service = createUserService(dbMock);
  
  await service.create({ name: 'Test' });
  assert(dbMock.insert.calledWith('users'), 'Should call database insert');
});
```

## Running Tests

```js
// Simple test runner
const runTests = async (testFiles) => {
  let passed = 0, failed = 0;
  for (const file of testFiles) {
    const tests = await import(file);
    if (tests.default) await tests.default();
  }
  console.log(`\n✓ ${passed} passed, ✗ ${failed} failed`);
};
```

## References

- Test Pyramid: Unit > Integration > E2E
- TDD Cycle: Red → Green → Refactor
- AAA Pattern: Arrange → Act → Assert
- Mocking: Isolate units, control dependencies
- Coverage: Aim for meaningful coverage, not 100% coverage
