'use strict';

// These tests intentionally require the developer's own authorized local pack.
// Never download, substitute a derived fixture, or silently skip asset failures.
const { statSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const assetRoot = path.join(root, 'wallpaper/assets/models/aemeath-pmx');
const required = [
  ['aemeath.pmx', 'file'],
  ['tex', 'directory'],
  ['AONMPB', 'directory'],
];
const missing = required.filter(([name, kind]) => {
  try {
    const entry = statSync(path.join(assetRoot, name));
    return kind === 'file' ? !entry.isFile() : !entry.isDirectory();
  } catch { return true; }
});

if (missing.length) {
  console.error('[avatar assets] 缺少本机角色资源，真实模型测试未执行：');
  for (const [name] of missing) console.error(`  ${path.join(assetRoot, name)}`);
  console.error('GitHub 源码不包含禁止二次配布的角色模型和贴图。请自行取得作者授权及相应资源，按 docs/LOCAL-ASSETS.md 保留目录结构安装到本机。');
  console.error('无需角色资源的检查可运行 npm run test:avatar:core；安装后再运行 npm run test:avatar:assets。');
  process.exitCode = 1;
} else {
  for (const script of ['test-pmx-performance.mjs', 'test-character-materials.mjs', 'test-character-shadows.mjs']) {
    console.log(`[avatar assets] ${script}`);
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', script)], { cwd: root, stdio: 'inherit' });
    if (result.error) console.error(`[avatar assets] 无法启动测试：${result.error.message}`);
    if (result.error || result.signal || result.status !== 0) {
      if (result.signal) console.error(`[avatar assets] 测试被信号 ${result.signal} 中断。`);
      process.exitCode = Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
      break;
    }
  }
}
