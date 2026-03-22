---
name: form-validation
description: Build form validators with custom validation rules, error messages, async validation, field dependencies, and real-time feedback patterns
---

# Form Validation Skill

## Overview

Form validation is the process of checking that user input meets specified requirements before submission. This skill covers building composable validators, handling complex dependencies between fields, providing real-time feedback, and managing async validation.

## Core Concepts

### 1. Validator Functions
A validator is a pure function that takes a value and returns a result object with `valid` and `error` properties:

```js
const validator = (value) => {
  if (typeof value !== 'string') {
    return { valid: false, error: 'Must be a string' };
  }
  return { valid: true };
};
```

### 2. Validation Result Format
All validators should return:
- `{ valid: true }` on success
- `{ valid: false, error: 'error message' }` on failure

### 3. Field-Level vs Form-Level
- **Field-level**: Validates individual field (email, required, pattern)
- **Form-level**: Validates relationships between fields (password match, conditional required)

### 4. Sync vs Async Validation
- **Sync**: Immediate validation (format, length, pattern)
- **Async**: Validation requiring network/database calls (username availability, email verification)

## Approach

### Step 1: Create Base Validators
Start with fundamental validators that can be composed:

```js
const validators = {
  required: (value) => 
    value && String(value).trim().length > 0
      ? { valid: true }
      : { valid: false, error: 'This field is required' },
  
  minLength: (min) => (value) =>
    String(value).length >= min
      ? { valid: true }
      : { valid: false, error: `Must be at least ${min} characters` },
  
  email: (value) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(value)
      ? { valid: true }
      : { valid: false, error: 'Invalid email format' };
  },
  
  pattern: (regex, message) => (value) =>
    regex.test(value)
      ? { valid: true }
      : { valid: false, error: message || 'Invalid format' };
};
```

### Step 2: Create Composite Validators
Combine multiple validators for a single field:

```js
const composeValidators = (...validatorFns) => (value) => {
  for (const validator of validatorFns) {
    const result = validator(value);
    if (!result.valid) return result;
  }
  return { valid: true };
};

const passwordValidator = composeValidators(
  validators.required,
  validators.minLength(8),
  validators.pattern(/[A-Z]/, 'Must contain uppercase letter'),
  validators.pattern(/[0-9]/, 'Must contain a number')
);
```

### Step 3: Implement Async Validators
For validation that requires async operations:

```js
const asyncValidators = {
  checkEmailAvailability: (email) => 
    fetch(`/api/check-email?email=${encodeURIComponent(email)}`)
      .then(res => res.json())
      .then(data => data.available
        ? { valid: true }
        : { valid: false, error: 'Email already in use' }
      )
      .catch(() => ({ valid: false, error: 'Could not verify email' })),
  
  checkUsername: (username) =>
    fetch(`/api/check-username?username=${encodeURIComponent(username)}`)
      .then(res => res.json())
      .then(data => data.available
        ? { valid: true }
        : { valid: false, error: 'Username already taken' }
      )
};
```

### Step 4: Create Field State Manager
Track validation state for each field:

```js
const createFieldState = (initialValue = '') => ({
  value: initialValue,
  touched: false,
  validating: false,
  error: null,
  valid: true
});

const updateFieldState = (state, field, updates) => ({
  ...state,
  [field]: { ...state[field], ...updates }
});
```

### Step 5: Implement Field Dependencies
Handle cases where one field's validation depends on another:

```js
const validateField = (fieldName, fields, validators) => {
  const value = fields[fieldName].value;
  
  // Get all validators for this field
  const fieldValidators = validators[fieldName] || [];
  
  // Handle dependent validation (e.g., password confirmation)
  if (fieldName === 'confirmPassword') {
    const passwordMatch = value === fields.password?.value
      ? { valid: true }
      : { valid: false, error: 'Passwords do not match' };
    
    fieldValidators.push(() => passwordMatch);
  }
  
  // Run all validators
  for (const validator of fieldValidators) {
    const result = validator(value, fields);
    if (!result.valid) return result;
  }
  
  return { valid: true };
};
```

### Step 6: Add Real-Time Feedback
Provide immediate feedback without overwhelming the user:

```js
const createRealTimeValidator = (debounceMs = 300) => {
  const timers = new Map();
  
  return {
    validate: (fieldName, validator, onResult) => {
      // Clear existing timer
      if (timers.has(fieldName)) {
        clearTimeout(timers.get(fieldName));
      }
      
      // Set new timer
      const timer = setTimeout(() => {
        const result = validator();
        onResult(fieldName, result);
        timers.delete(fieldName);
      }, debounceMs);
      
      timers.set(fieldName, timer);
    }
  };
};
```

### Step 7: Build Validation Middleware
Create middleware for form submission and field updates:

```js
const createFormValidator = (schema) => {
  return {
    validateField: (fieldName, value) => {
      const validator = schema[fieldName];
      if (!validator) return { valid: true };
      return validator(value);
    },
    
    validateForm: (values) => {
      const errors = {};
      for (const [fieldName, validator] of Object.entries(schema)) {
        const result = validator(values[fieldName]);
        if (!result.valid) {
          errors[fieldName] = result.error;
        }
      }
      return { 
        valid: Object.keys(errors).length === 0,
        errors 
      };
    },
    
    validateAsync: async (values) => {
      const results = await Promise.all(
        Object.entries(schema).map(async ([fieldName, validator]) => {
          const result = await Promise.resolve(validator(values[fieldName]));
          return { fieldName, ...result };
        })
      );
      
      const errors = {};
      for (const { fieldName, valid, error } of results) {
        if (!valid) errors[fieldName] = error;
      }
      
      return {
        valid: Object.keys(errors).length === 0,
        errors
      };
    }
  };
};
```

## Common Validation Rules

### Basic Validators
- `required`: Field must have a value
- `minLength(n)`: Minimum character length
- `maxLength(n)`: Maximum character length
- `min(n)`: Minimum numeric value
- `max(n)`: Maximum numeric value
- `email`: Valid email format
- `url`: Valid URL format
- `pattern(regex)`: Matches regex pattern

### Dependent Validators
- `match(otherField)`: Field matches another field
- `conditional(condition, validator)`: Validate only if condition is true
- `custom(fn)`: Custom validation function

### Async Validators
- `unique(endpoint)`: Check if value is unique
- `available(endpoint)`: Check if resource is available
- `custom(asyncFn)`: Custom async validation

## Template: Complete Form Validator

```js
const createUserFormValidator = () => {
  const validators = {
    email: composeValidators(
      v.required,
      v.email,
      checkEmailAvailability
    ),
    password: composeValidators(
      v.required,
      v.minLength(8),
      v.pattern(/[A-Z]/, 'Must have uppercase'),
      v.pattern(/[0-9]/, 'Must have number')
    ),
    confirmPassword: (value, formValues) =>
      value === formValues.password
        ? { valid: true }
        : { valid: false, error: 'Passwords do not match' },
    username: composeValidators(
      v.required,
      v.minLength(3),
      v.maxLength(20),
      checkUsername
    ),
    acceptTerms: (value) =>
      value === true
        ? { valid: true }
        : { valid: false, error: 'You must accept the terms' }
  };
  
  return createFormValidator(validators);
};
```

## Testing Patterns

### Unit Test Validators
```js
const testValidator = () => {
  assert(validators.required('').valid === false);
  assert(validators.required('value').valid === true);
  assert(validators.email('test@example.com').valid === true);
  assert(validators.email('invalid').valid === false);
};
```

### Test Composed Validators
```js
const testComposed = () => {
  const pwd = passwordValidator;
  assert(pwd('short').valid === false);
  assert(pwd('ValidPwd1').valid === true);
  assert(pwd('nouppercase1').valid === false);
};
```

### Test Async Validators
```js
const testAsync = async () => {
  const result = await asyncValidators.checkEmailAvailability('new@example.com');
  assert(result.valid === true || result.valid === false);
  assert(result.error !== undefined);
};
```

## Checklist

- [ ] Define validation schema with all required fields
- [ ] Create base validators for common patterns
- [ ] Implement composite validators for complex rules
- [ ] Handle async validation with error handling
- [ ] Test field dependencies work correctly
- [ ] Add debouncing for real-time feedback
- [ ] Validate entire form before submission
- [ ] Provide clear, user-friendly error messages
- [ ] Handle edge cases (empty, null, undefined values)
- [ ] Document custom validation rules
- [ ] Add loading states for async validators
- [ ] Implement error recovery and retry logic

## Best Practices

1. **Keep validators pure**: No side effects, same input always produces same output
2. **Compose validators**: Build complex validators from simple, reusable ones
3. **Use consistent error messages**: Help users understand what went wrong
4. **Debounce async validators**: Don't overload the server with requests
5. **Show validation state clearly**: Use visual feedback (colors, icons, messages)
6. **Validate on submission**: Don't prevent submission on first keystroke
7. **Handle edge cases**: null, undefined, empty strings, whitespace
8. **Test thoroughly**: Unit test validators, integration test forms
9. **Provide feedback early**: Show patterns and requirements before validation
10. **Batch async validators**: Request multiple validations in parallel when possible

## Common Pitfalls

- **Blocking on invalid input**: Only prevent submission, not user input
- **Missing error context**: Don't just say "invalid", explain why
- **Not handling async state**: Show loading, timeouts, and network errors
- **Cascading errors**: Validate related fields when dependencies change
- **Over-validating**: Don't validate on every keystroke without debouncing
- **Ignoring edge cases**: Null values, empty strings, and whitespace matter

## Resources

- Validator.js: Popular validation library
- Zod: TypeScript-first validation
- Yup: Object schema validation
- Joi: Data validation for JavaScript
- Valibot: Small validation library
