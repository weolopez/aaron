---
name: data-transform
description: Transform and reshape data structures like JSON, CSV, arrays, and objects with mapping, filtering, grouping, pivoting, and flattening operations
---

# Data Transform Skill

## Overview
This skill provides patterns and utilities for transforming, reshaping, and manipulating data structures. It covers common operations on JSON, arrays, objects, and CSV data including mapping, filtering, grouping, pivoting, sorting, and flattening.

## Core Concepts

### Data Transformation Patterns
- **Mapping**: Transform each item in a collection using a function
- **Filtering**: Select items matching a condition
- **Grouping**: Organize items by a key or predicate
- **Pivoting**: Rotate data from row format to column format
- **Flattening**: Convert nested structures to flat structures
- **Sorting**: Order items by criteria
- **Aggregation**: Combine items into summary values

## Approach

### 1. Map Operations
Transform data by applying a function to each element:

```js
// Basic mapping
const numbers = [1, 2, 3];
const doubled = numbers.map(n => n * 2);
// [2, 4, 6]

// Object mapping
const users = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
const names = users.map(u => u.name);
// ['Alice', 'Bob']

// Nested mapping
const transformed = users.map(u => ({
  ...u,
  greeting: `Hello, ${u.name}`
}));
```

### 2. Filter Operations
Select items matching a condition:

```js
// Simple filter
const numbers = [1, 2, 3, 4, 5];
const evens = numbers.filter(n => n % 2 === 0);
// [2, 4]

// Complex filtering
const users = [
  { id: 1, name: 'Alice', age: 30, active: true },
  { id: 2, name: 'Bob', age: 25, active: false },
  { id: 3, name: 'Charlie', age: 35, active: true }
];
const activeAdults = users.filter(u => u.active && u.age >= 30);
// [{ id: 1, name: 'Alice', age: 30, active: true }, ...]

// Negation filter
const inactive = users.filter(u => !u.active);
```

### 3. Grouping Operations
Organize data by keys:

```js
// Group by single key
const groupBy = (array, key) => {
  return array.reduce((groups, item) => ({
    ...groups,
    [item[key]]: [...(groups[item[key]] || []), item]
  }), {});
};

const users = [
  { id: 1, role: 'admin', name: 'Alice' },
  { id: 2, role: 'user', name: 'Bob' },
  { id: 3, role: 'admin', name: 'Charlie' }
];

const byRole = groupBy(users, 'role');
// { admin: [...], user: [...] }

// Group by computed key
const byDept = array.reduce((acc, item) => {
  const dept = item.email.split('@')[1];
  return {
    ...acc,
    [dept]: [...(acc[dept] || []), item]
  };
}, {});
```

### 4. Pivot Operations
Rotate data structure:

```js
// Array of objects to object of arrays
const records = [
  { year: 2020, product: 'A', sales: 100 },
  { year: 2020, product: 'B', sales: 150 },
  { year: 2021, product: 'A', sales: 120 },
  { year: 2021, product: 'B', sales: 180 }
];

const pivot = (data, rowKey, colKey, valueKey) => {
  const result = {};
  data.forEach(row => {
    const rowVal = row[rowKey];
    const colVal = row[colKey];
    const val = row[valueKey];
    if (!result[rowVal]) result[rowVal] = {};
    result[rowVal][colVal] = val;
  });
  return result;
};

const pivoted = pivot(records, 'year', 'product', 'sales');
// { 2020: { A: 100, B: 150 }, 2021: { A: 120, B: 180 } }
```

### 5. Flatten Operations
Convert nested structures:

```js
// Simple flatten
const nested = [1, [2, 3], [4, [5, 6]]];
const flat = nested.flat(1);
// [1, 2, 3, 4, [5, 6]]

const deepFlat = nested.flat(Infinity);
// [1, 2, 3, 4, 5, 6]

// Flatten objects
const flattenObject = (obj, prefix = '') => {
  return Object.entries(obj).reduce((acc, [key, val]) => {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return { ...acc, ...flattenObject(val, newKey) };
    }
    return { ...acc, [newKey]: val };
  }, {});
};

const nested = { user: { name: 'Alice', address: { city: 'NYC' } } };
const flat = flattenObject(nested);
// { 'user.name': 'Alice', 'user.address.city': 'NYC' }
```

### 6. Sorting Operations
Order data:

```js
// Simple sort
const numbers = [3, 1, 4, 1, 5];
const sorted = [...numbers].sort((a, b) => a - b);
// [1, 1, 3, 4, 5]

// Object sorting
const users = [
  { name: 'Charlie', age: 30 },
  { name: 'Alice', age: 25 },
  { name: 'Bob', age: 35 }
];

// By property
const byName = [...users].sort((a, b) => a.name.localeCompare(b.name));
const byAge = [...users].sort((a, b) => a.age - b.age);

// Multi-key sort
const multiSort = [...users].sort((a, b) => {
  if (a.age === b.age) return a.name.localeCompare(b.name);
  return a.age - b.age;
});
```

### 7. Aggregation Operations
Combine data:

```js
// Sum
const numbers = [1, 2, 3, 4];
const total = numbers.reduce((sum, n) => sum + n, 0);
// 10

// Count
const counts = items.reduce((acc, item) => ({
  ...acc,
  [item.type]: (acc[item.type] || 0) + 1
}), {});

// Average
const avg = numbers.reduce((sum, n) => sum + n, 0) / numbers.length;

// Aggregate with grouping
const byCategory = items.reduce((acc, item) => ({
  ...acc,
  [item.category]: {
    count: (acc[item.category]?.count || 0) + 1,
    total: (acc[item.category]?.total || 0) + item.value,
    items: [...(acc[item.category]?.items || []), item]
  }
}), {});
```

### 8. CSV Transformation
Parse and transform CSV data:

```js
// Parse CSV to array of objects
const parseCSV = (csv, delimiter = ',') => {
  const lines = csv.trim().split('\n');
  const headers = lines[0].split(delimiter).map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split(delimiter).map(v => v.trim());
    return Object.fromEntries(headers.map((h, i) => [h, values[i]]));
  });
};

// CSV string to JSON
const csv = `name,age,city
Alice,30,NYC
Bob,25,LA`;

const data = parseCSV(csv);
// [{ name: 'Alice', age: '30', city: 'NYC' }, ...]

// Array of objects to CSV
const toCSV = (data, headers) => {
  const headerRow = headers.join(',');
  const rows = data.map(obj => headers.map(h => obj[h]).join(','));
  return [headerRow, ...rows].join('\n');
};
```

## Templates

### Generic Transform Utility
```js
class DataTransform {
  constructor(data) {
    this.data = data;
  }

  map(fn) {
    return new DataTransform(this.data.map(fn));
  }

  filter(predicate) {
    return new DataTransform(this.data.filter(predicate));
  }

  sort(compareFn) {
    return new DataTransform([...this.data].sort(compareFn));
  }

  groupBy(keyFn) {
    const grouped = this.data.reduce((acc, item) => {
      const key = keyFn(item);
      return { ...acc, [key]: [...(acc[key] || []), item] };
    }, {});
    return grouped;
  }

  reduce(fn, init) {
    return this.data.reduce(fn, init);
  }

  get() {
    return this.data;
  }
}

// Usage
const result = new DataTransform(users)
  .filter(u => u.active)
  .map(u => ({ ...u, fullName: u.name.toUpperCase() }))
  .sort((a, b) => a.fullName.localeCompare(b.fullName))
  .get();
```

### Chained Transformation Pipeline
```js
const pipe = (...fns) => (data) =>
  fns.reduce((acc, fn) => fn(acc), data);

const transformPipeline = pipe(
  (data) => data.filter(item => item.active),
  (data) => data.map(item => ({ ...item, processed: true })),
  (data) => data.sort((a, b) => a.id - b.id)
);

const result = transformPipeline(rawData);
```

### Safe Data Navigation
```js
// Deep property access with default
const getIn = (obj, path, defaultValue) => {
  const value = path.split('.').reduce((curr, prop) => curr?.[prop], obj);
  return value !== undefined ? value : defaultValue;
};

// Safe mapping with null handling
const safeMap = (array, mapper) => {
  return (Array.isArray(array) ? array : [])
    .filter(item => item != null)
    .map(mapper);
};
```

## Checklists

### Planning Transformation
- [ ] Identify input data structure (array, object, nested, CSV)
- [ ] Define desired output structure
- [ ] List required operations (map, filter, group, pivot, etc.)
- [ ] Consider edge cases (null values, empty arrays, missing keys)
- [ ] Plan for performance (large datasets, nested loops)
- [ ] Decide between immutable or mutable transformations

### Implementation
- [ ] Use immutable patterns (`...spread`, `map`, `filter` instead of `push`, `splice`)
- [ ] Preserve original data when needed
- [ ] Handle null/undefined gracefully
- [ ] Use type-appropriate comparisons (loose vs strict equality)
- [ ] Test with edge cases (empty, single item, duplicates)
- [ ] Document complex transformations with comments

### Testing Transformations
- [ ] Test with empty data
- [ ] Test with single item
- [ ] Test with duplicate keys
- [ ] Test with null/undefined values
- [ ] Test with deeply nested structures
- [ ] Verify output structure matches expectations
- [ ] Check for performance issues with large datasets

## Common Patterns

### Find and Replace
```js
const findReplace = (array, matcher, replacement) =>
  array.map(item => matcher(item) ? replacement(item) : item);
```

### Deduplicate
```js
const unique = (array, keyFn) => {
  const seen = new Set();
  return array.filter(item => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
```

### Merge Objects
```js
const merge = (...objects) =>
  objects.reduce((acc, obj) => ({ ...acc, ...obj }), {});
```

### Deep Clone
```js
const deepClone = (obj) => JSON.parse(JSON.stringify(obj));
```

## References
- MDN: Array methods (map, filter, reduce, sort)
- MDN: Object methods (Object.entries, Object.fromEntries)
- JavaScript: Spread operator and destructuring
- Functional programming: Composition and immutability
