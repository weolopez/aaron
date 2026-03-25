#!/usr/bin/env node
/**
 * gen-manifest.mjs — Regenerate vfs-manifest.json from disk
 *
 * Scans skills/, memory/, and artifacts/ (excluding _legacy/)
 * and writes vfs-manifest.json at the project root.
 *
 * Usage: node scripts/gen-manifest.mjs
 */
import { readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function scanDir(dir, prefix = '') {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...scanDir(join(dir, entry.name), rel));
    } else {
      results.push(rel);
    }
  }
  return results.sort();
}

// Skills: all files under skills/
const skills = scanDir(join(ROOT, 'skills'));

// Memory: top-level files only
const memory = readdirSync(join(ROOT, 'memory'), { withFileTypes: true })
  .filter(e => e.isFile())
  .map(e => e.name)
  .sort();

// Artifacts: top-level files only, skip _legacy/
const artifactsDir = join(ROOT, 'artifacts');
const artifacts = existsSync(artifactsDir)
  ? readdirSync(artifactsDir, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => e.name)
      .sort()
  : [];

const manifest = { artifacts, memory, skills };
const outPath = join(ROOT, 'vfs-manifest.json');
writeFileSync(outPath, JSON.stringify(manifest) + '\n');

console.log(`vfs-manifest.json written:`);
console.log(`  skills:    ${skills.length} files`);
console.log(`  memory:    ${memory.length} files`);
console.log(`  artifacts: ${artifacts.length} files`);
