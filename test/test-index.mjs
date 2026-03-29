import { buildSkillIndex } from '../src/harness/agent-loop.js';
import { createVFS } from '../src/core/agent-core.js';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const vfs = createVFS();
function loadDirToVFS(baseDir, vfsPrefix, vfs) {
  if (!existsSync(baseDir)) return;
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    const diskPath = join(baseDir, entry.name);
    const vfsPath = vfsPrefix + entry.name;
    if (entry.isDirectory()) {
      loadDirToVFS(diskPath, vfsPath + '/', vfs);
    } else {
      try {
        vfs.write(vfsPath, readFileSync(diskPath, 'utf8'));
        vfs.markClean(vfsPath);
      } catch {}
    }
  }
}
loadDirToVFS('skills', '/skills/', vfs);
console.log(buildSkillIndex(vfs));
