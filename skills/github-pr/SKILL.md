---
name: github-pr
description: Create a GitHub branch, commit changes to it, and open a pull request
---

# github-pr

Create a feature branch, push changes to it, and open a pull request — using `context.github`.

## Prerequisites

`context.github` must be non-null. Check first:

```js
if (!context.github) {
  context.emit({ type: 'done', message: 'No GitHub connection — set GITHUB_TOKEN and GITHUB_REPO' });
  return;
}
```

## Workflow

### 1. Choose a branch name

Use kebab-case, prefixed by type: `feat/`, `fix/`, `chore/`, `docs/`.

```js
const branchName = 'feat/add-notification-service';
```

### 2. Create the branch

```js
context.emit({ type: 'progress', message: `Creating branch ${branchName}...` });
await context.github.createBranch(branchName);
// createBranch(name, fromRef?) — fromRef defaults to context.github.ref
```

### 3. Write files to /src/

All files under `/src/` are committed to GitHub when you call `context.commit(msg, branch)`.

```js
context.vfs.write('/src/services/notifications.js', '// ...content...');
context.emit({ type: 'file_write', path: '/src/services/notifications.js' });
```

### 4. Commit to the feature branch

```js
context.emit({ type: 'progress', message: 'Committing to branch...' });
await context.commit('feat: add notification service', branchName);
```

### 5. Open the pull request

```js
context.emit({ type: 'progress', message: 'Opening pull request...' });
const pr = await context.github.createPR({
  title: 'feat: add notification service',
  body: [
    '## Summary',
    '- Adds EmailNotificationService and SMSNotificationService',
    '- Follows existing INotificationService interface',
    '',
    '## Test plan',
    '- [ ] Unit tests pass',
    '- [ ] Integration test with real SMTP',
  ].join('\n'),
  head: branchName,
  base: 'main',   // or context.github.ref
});

context.emit({ type: 'result', value: { pr_url: pr.html_url, pr_number: pr.number } });
```

### 6. Done

```js
context.emit({ type: 'done', message: `PR #${pr.number} opened: ${pr.html_url}` });
```

## Error handling

- `createBranch` throws if the branch already exists (422) — check with `context.github.getLatestSha(branchName)` first, catch and continue if it exists
- `createPR` throws 404 if the branch has no commits — ensure `context.commit` pushed at least one file
- Token permissions: needs `repo` or `public_repo` scope for PR creation

## Checking existing PRs

```js
const openPRs = await context.github.listPRs('open');
const existing = openPRs.find(pr => pr.head === branchName);
if (existing) {
  context.emit({ type: 'result', value: { pr_url: existing.html_url, pr_number: existing.number } });
  context.emit({ type: 'done', message: `PR already exists: #${existing.number}` });
  return;
}
```
