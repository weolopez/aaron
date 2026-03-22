---
name: algorithm
description: Implement common algorithms and data structures including sorting, searching, graph traversal, dynamic programming, trees, hash maps, and complexity analysis
---

# Algorithm Skill

Master the implementation of fundamental computer science algorithms and data structures, with emphasis on correctness, efficiency, and complexity analysis.

## Approach

### 1. Problem Analysis
- **Understand the problem**: Clarify inputs, outputs, constraints, and edge cases
- **Identify the category**: Sorting, searching, graph, dynamic programming, trees, or hash-based
- **Analyze constraints**: Time/space complexity requirements, data size, special properties
- **Consider trade-offs**: Simplicity vs. performance, space vs. time

### 2. Algorithm Selection
- **Sorting**: Use quicksort/mergesort for general cases, counting sort for range-limited data
- **Searching**: Binary search for sorted data, hash maps for O(1) lookup, BFS/DFS for graphs
- **Graphs**: BFS for shortest path (unweighted), Dijkstra/Bellman-Ford for weighted, DFS for cycles
- **Dynamic Programming**: Identify overlapping subproblems and optimal substructure; use memoization or tabulation
- **Trees**: Choose BST, AVL, or hash map based on balance/range query needs
- **Hash Maps**: Best for frequency counting, caching, and deduplication

### 3. Implementation Strategy
- Write pseudocode first to outline the logic
- Implement the core algorithm with clear variable names
- Add input validation and edge case handling
- Test with multiple cases including edge cases
- Analyze actual complexity: count operations and space usage
- Optimize if necessary based on profiling

### 4. Testing & Validation
- Test with minimal inputs (n=1, empty, single element)
- Test with typical inputs matching the use case
- Test with adversarial inputs (worst-case scenarios)
- Verify time and space complexity empirically
- Check for off-by-one errors and boundary conditions

## Templates

### Sorting Algorithm Template

```js
/**
 * [AlgorithmName] sort
 * Time: O(n log n) average, O(n²) worst case
 * Space: O(log n) for recursion stack
 * @param {number[]} arr - Array to sort
 * @return {number[]} - Sorted array
 */
function sort(arr) {
  if (arr.length <= 1) return arr;
  
  // Core sorting logic here
  
  return arr;
}

// Test cases
console.assert(JSON.stringify(sort([3, 1, 4, 1, 5])) === JSON.stringify([1, 1, 3, 4, 5]));
console.assert(JSON.stringify(sort([])) === JSON.stringify([]));
console.assert(JSON.stringify(sort([1])) === JSON.stringify([1]));
```

### Searching Algorithm Template

```js
/**
 * [AlgorithmName] search
 * Time: O(log n) for binary search, O(n) for linear
 * Space: O(1) or O(log n) for recursion
 * @param {number[]} arr - Array to search (usually sorted)
 * @param {number} target - Value to find
 * @return {number} - Index of target, or -1 if not found
 */
function search(arr, target) {
  if (!arr || arr.length === 0) return -1;
  
  // Search logic here
  
  return -1; // Not found
}

// Test cases
console.assert(search([1, 3, 5, 7, 9], 5) === 2);
console.assert(search([1, 3, 5, 7, 9], 4) === -1);
console.assert(search([], 5) === -1);
```

### Graph Traversal Template

```js
/**
 * BFS/DFS traversal
 * Time: O(V + E) where V = vertices, E = edges
 * Space: O(V) for queue/stack and visited set
 * @param {Map<number, number[]>} graph - Adjacency list representation
 * @param {number} start - Starting vertex
 * @return {number[]} - Traversal order
 */
function traverse(graph, start) {
  const visited = new Set();
  const result = [];
  const queue = [start]; // BFS; use stack for DFS
  
  while (queue.length > 0) {
    const node = queue.shift(); // Use pop() for DFS
    if (visited.has(node)) continue;
    visited.add(node);
    result.push(node);
    
    const neighbors = graph.get(node) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        queue.push(neighbor);
      }
    }
  }
  
  return result;
}

// Test case
const graph = new Map([
  [1, [2, 3]],
  [2, [1, 4]],
  [3, [1, 5]],
  [4, [2]],
  [5, [3]]
]);
console.log(traverse(graph, 1)); // [1, 2, 3, 4, 5] for BFS
```

### Dynamic Programming Template

```js
/**
 * [Problem] using dynamic programming
 * Time: O(n) or O(n²) depending on problem
 * Space: O(n) for DP table
 * @param {number} n - Problem size
 * @return {number} - Result
 */
function solveDynamicProgramming(n) {
  // Base cases
  if (n <= 1) return n;
  
  // Create DP table: dp[i] represents solution for size i
  const dp = new Array(n + 1);
  dp[0] = 0;
  dp[1] = 1;
  
  // Fill DP table bottom-up
  for (let i = 2; i <= n; i++) {
    dp[i] = dp[i - 1] + dp[i - 2]; // Recurrence relation
  }
  
  return dp[n];
}

// Space-optimized version (if only last few values needed)
function solveDynamicProgrammingOptimized(n) {
  if (n <= 1) return n;
  let prev2 = 0, prev1 = 1;
  for (let i = 2; i <= n; i++) {
    const curr = prev1 + prev2;
    prev2 = prev1;
    prev1 = curr;
  }
  return prev1;
}

// Test cases
console.assert(solveDynamicProgramming(10) === 55);
console.assert(solveDynamicProgrammingOptimized(10) === 55);
```

### Tree Algorithm Template

```js
class TreeNode {
  constructor(val = 0, left = null, right = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

/**
 * Tree traversal/operation
 * Time: O(n) to visit all nodes
 * Space: O(h) for recursion stack, h = height
 * @param {TreeNode} root - Root of binary tree
 * @return {number[]} - Result of operation
 */
function treeOperation(root) {
  if (!root) return [];
  
  const result = [];
  
  // In-order: left, root, right
  function inOrder(node) {
    if (!node) return;
    inOrder(node.left);
    result.push(node.val);
    inOrder(node.right);
  }
  
  inOrder(root);
  return result;
}

// Test case
const root = new TreeNode(1, new TreeNode(2), new TreeNode(3));
console.log(treeOperation(root)); // [2, 1, 3]
```

### Hash Map Algorithm Template

```js
/**
 * Hash map based solution (frequency counting, deduplication, etc.)
 * Time: O(n)
 * Space: O(n) for hash map
 * @param {any[]} arr - Input array
 * @return {any} - Result
 */
function solveWithHashMap(arr) {
  const map = new Map();
  
  // Build frequency/lookup map
  for (const item of arr) {
    map.set(item, (map.get(item) || 0) + 1);
  }
  
  // Process or query map
  const result = [];
  for (const [key, count] of map) {
    if (count > 1) {
      result.push(key);
    }
  }
  
  return result;
}

// Test cases
console.assert(JSON.stringify(solveWithHashMap([1, 2, 2, 3, 3, 3])) === JSON.stringify([2, 3]));
console.assert(JSON.stringify(solveWithHashMap([1, 2, 3])) === JSON.stringify([]));
```

## Complexity Analysis Checklists

### Time Complexity Analysis
- [ ] Count loops and their nesting depth
- [ ] Identify problem size reduction (divide by 2 = log n, divide by constant = linear)
- [ ] Account for built-in operations: .sort() = O(n log n), .find() = O(n)
- [ ] Recognize patterns: single loop = O(n), nested loops = O(n²), binary search = O(log n)
- [ ] Consider recurrence relations (T(n) = 2T(n/2) + n = O(n log n))
- [ ] Verify with small examples: count actual operations
- [ ] Document average, best, and worst cases

### Space Complexity Analysis
- [ ] Count auxiliary data structures (arrays, maps, sets)
- [ ] Measure recursion depth for stack space
- [ ] Distinguish between input space and working space
- [ ] Account for output space if needed
- [ ] Identify optimization opportunities (in-place modification, space-time tradeoffs)

## Implementation Checklist

### Before Coding
- [ ] Write clear problem statement with examples
- [ ] Identify algorithm category and approach
- [ ] Sketch pseudocode on paper or in comments
- [ ] Estimate time and space complexity
- [ ] List edge cases to test

### During Coding
- [ ] Use meaningful variable and function names
- [ ] Add JSDoc comments with complexity analysis
- [ ] Handle empty/null inputs explicitly
- [ ] Avoid off-by-one errors in loops and indices
- [ ] Test incrementally as you code

### After Coding
- [ ] Run all test cases including edge cases
- [ ] Verify complexity matches expectations
- [ ] Check for memory leaks or inefficiencies
- [ ] Consider refactoring for readability
- [ ] Document any non-obvious logic
- [ ] Optimize if performance is critical

## Common Pitfalls to Avoid

1. **Complexity Mistakes**: Confusing O(n) array.indexOf() with O(1) hash map lookup
2. **Off-by-One Errors**: Wrong loop bounds, especially in array slicing and recursion
3. **Mutating Input**: Modifying input arrays unintentionally; clarify if in-place is required
4. **Forgetting Edge Cases**: Empty arrays, single elements, duplicates, negative numbers
5. **Inefficient Sorting**: Using bubble sort (O(n²)) when quicksort (O(n log n)) is available
6. **Stack Overflow**: Recursion depth exceeding limits; use iteration or tail call optimization
7. **Incorrect Graph Representation**: Confusing adjacency list with adjacency matrix impacts complexity
8. **DP State Mismatch**: Defining dp[i] incorrectly or missing base cases
9. **Unbalanced Trees**: Not accounting for degenerate trees becoming linked lists (O(n) height)
10. **Inefficient Lookups**: Using linear search in a loop when hash map would be O(1)

## Testing Strategy

### Unit Test Template
```js
function runTests() {
  const tests = [
    { input: [3, 1, 4, 1, 5], expected: [1, 1, 3, 4, 5], name: 'normal array' },
    { input: [], expected: [], name: 'empty array' },
    { input: [1], expected: [1], name: 'single element' },
    { input: [5, 4, 3, 2, 1], expected: [1, 2, 3, 4, 5], name: 'reverse sorted' },
  ];
  
  for (const test of tests) {
    const result = sort(test.input);
    const passed = JSON.stringify(result) === JSON.stringify(test.expected);
    console.log(`${test.name}: ${passed ? '✓ PASS' : '✗ FAIL'}`);
    if (!passed) console.log(`  Expected: ${JSON.stringify(test.expected)}, Got: ${JSON.stringify(result)}`);
  }
}

runTests();
```

## Real-World Applications

- **Sorting**: Database query optimization, data aggregation, UI list rendering
- **Searching**: Database indexing, autocomplete, search functionality
- **Graphs**: Social networks, routing algorithms, dependency resolution
- **Dynamic Programming**: Optimization problems (knapsack, longest sequence), caching strategies
- **Trees**: File systems, DOM structures, B-trees for databases
- **Hash Maps**: Caching, deduplication, frequency analysis, memoization

## Resources for Further Learning

- Complexity analysis: Big O notation, amortized analysis
- Algorithm repositories: LeetCode patterns, GeeksforGeeks, Algorithm textbooks
- Profiling tools: Node.js `console.time()`, performance measurement
- Visualization: Visualgo.net, Algorithm visualizers for understanding flow
