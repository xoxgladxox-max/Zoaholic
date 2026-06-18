import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 修改原因：虚拟模型编辑抽屉在移动端需要重新显示渠道列表，但不能再把链条编辑区挤出视野。
// 修改方式：直接读取 Channels.tsx 中抽屉布局相关代码，断言移动端使用可折叠渠道面板，桌面端保留左右两栏。
// 目的：在不新增前端测试依赖的前提下，为移动端渠道面板回归建立检查。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const channelsSource = readFileSync(path.resolve(__dirname, '../src/pages/Channels.tsx'), 'utf8');
const drawerStart = channelsSource.indexOf('虚拟模型编辑从顶部内联画布迁移到抽屉');

assert.notEqual(drawerStart, -1, '应该能定位到虚拟模型编辑抽屉代码段');

const drawerSource = channelsSource.slice(drawerStart, drawerStart + 16000);
const gridLine = drawerSource
  .split('\n')
  .find(line => line.includes('flex-1 min-h-0 grid grid-cols-1') && line.includes('isVirtualProviderPanelCollapsed'));
const asideLine = drawerSource
  .split('\n')
  .find(line => line.includes('<aside className') && line.includes('bg-muted/10'));

assert.ok(gridLine, '抽屉主体应该使用响应式 grid 布局');
assert.match(gridLine, /grid-rows-\[auto_minmax\(0,1fr\)\]/, '移动端应该让渠道面板在上、链条编辑区在下');
assert.match(gridLine, /xl:grid-cols-\[76px_1fr\]/, '桌面折叠态应该保留窄渠道栏和链条编辑区');
assert.match(gridLine, /xl:grid-cols-\[300px_1fr\]/, '桌面展开态应该保留宽渠道栏和链条编辑区');
assert.match(gridLine, /xl:grid-rows-\[minmax\(0,1fr\)\]/, '桌面端应该恢复单行左右两栏布局');
assert.match(gridLine, /\bxl:divide-x\b/, '桌面端仍需要左右栏分隔线');

assert.ok(asideLine, '抽屉应该保留渠道面板 aside');
assert.doesNotMatch(asideLine, /\bhidden xl:block\b/, 'aside 本身不能再在移动端完全隐藏');
assert.match(drawerSource, /📦 渠道面板 \(\{virtualProviderPanelItems\.length\}个渠道\)/, '移动端折叠态应该显示渠道数量');
assert.match(drawerSource, /max-h-\[50vh\]/, '移动端展开渠道面板应该限制最大高度');
assert.match(drawerSource, /isVirtualMobileProviderPanelOpen/, '移动端渠道面板应该使用独立折叠状态');
assert.match(drawerSource, /hidden xl:block/, '桌面专用渠道栏内容应该只在 xl 以上显示');

console.log('virtual drawer responsive layout passed');
// 修改原因：当前部署环境的 Node 18 在脚本自然结束后会触发 Aborted，导致已经通过的断言被错误标记为失败。
// 修改方式：所有断言完成后显式以 0 退出；如果前面的断言失败，异常会在这里之前抛出并保留失败退出码。
// 目的：让这个轻量回归测试只反映布局断言结果，而不受运行时自然退出异常影响。
process.exit(0);
