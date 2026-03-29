import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from 'node:process';

// Load .env
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim();
    if (!env[key]) env[key] = val;
  }
}

const token = env.GITHUB_TOKEN;
console.log('Token prefix:', token?.slice(0, 10) + '...');
console.log('Token length:', token?.length);

// Raw fetch test
const res = await fetch('https://api.github.com/repos/weolopez/aaron', {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
  }
});
if (res.status === 200) {
  const data = await res.json();
  console.log('Repo:', data.full_name, '| Private:', data.private);
} else {
  console.log('HTTP', res.status, await res.text());
  process.exit(1);
}

// Full client test
import { createGitHubClient } from '../src/runtime/github.js';
const client = createGitHubClient({ token });
const branch = await client.getBranch('weolopez', 'aaron', 'main');
console.log('Branch SHA:', branch?.sha?.slice(0, 8));
const tree = await client.getTree('weolopez', 'aaron', 'main');
console.log('Files in repo:', tree.length);
tree.slice(0, 10).forEach(f => console.log(' ', f.path));
if (tree.length > 10) console.log('  ...and', tree.length - 10, 'more');
