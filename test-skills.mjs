import { createVFS } from './agent-core.js';
import { buildSkillIndex, parseSkillFrontmatter } from './agent-loop.js';
import { readFileSync } from 'fs';

// ═══ parseSkillFrontmatter ═══

const content = readFileSync('skills/component-builder/SKILL.md', 'utf8');
const meta = parseSkillFrontmatter(content);
console.assert(meta.name === 'component-builder', 'name matches');
console.assert(meta.description.includes('isomorphic'), 'description matches');
console.log('PASS: parseSkillFrontmatter');

// ═══ buildSkillIndex ═══

const vfs = createVFS();
vfs.write('/skills/component-builder/SKILL.md', content);
const index = buildSkillIndex(vfs);
console.assert(index.includes('component-builder'), 'index has skill name');
console.assert(index.includes('context.vfs.read'), 'index has VFS path');
console.log('PASS: buildSkillIndex');

// ═══ empty VFS ═══

const emptyVfs = createVFS();
console.assert(buildSkillIndex(emptyVfs) === '', 'empty VFS returns empty string');
console.log('PASS: empty buildSkillIndex');

// ═══ edge cases ═══

console.assert(parseSkillFrontmatter('no frontmatter here') === null, 'no frontmatter');
console.assert(parseSkillFrontmatter('---\nname: foo\n---') === null, 'missing description');
console.log('PASS: edge cases');

// ═══ validateSkill via import ═══
// validateSkill is not exported, but we can test skill RSI imports work

import { runSkillRSI, runSkillExperiment } from './agent-rsi.js';
console.assert(typeof runSkillRSI === 'function', 'runSkillRSI is exported');
console.assert(typeof runSkillExperiment === 'function', 'runSkillExperiment is exported');
console.log('PASS: skill RSI exports');

// ═══ skill index rebuild after VFS mutation ═══

const vfs2 = createVFS();
console.assert(buildSkillIndex(vfs2) === '', 'no skills initially');
vfs2.write('/skills/test-skill/SKILL.md', '---\nname: test-skill\ndescription: A test skill\n---\n\n# Test\n\nSome instructions here.');
const idx2 = buildSkillIndex(vfs2);
console.assert(idx2.includes('test-skill'), 'new skill appears in index');
console.assert(idx2.includes('A test skill'), 'new skill description in index');
console.log('PASS: dynamic skill index rebuild');

console.log('\nAll tests passed');
