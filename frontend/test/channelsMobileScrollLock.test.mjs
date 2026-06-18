import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 修改原因：移动端打开渠道编辑抽屉时，Radix Dialog 的 body overflow:hidden 会让部分浏览器把页面滚动位置重置到顶部。
// 修改方式：通过源码回归测试锁定 Channels 组件内的 body fixed scroll lock、滚动位置 ref 保存和关闭恢复逻辑。
// 目的：防止后续维护时移除移动端滚动锁，或把 scrollY 改成 state 导致关闭时恢复到错误位置。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(__dirname, '../src/pages/Channels.tsx'), 'utf8');

function sliceBetween(startMarker, endMarker, fromIndex = 0) {
  const start = source.indexOf(startMarker, fromIndex);
  assert.notEqual(start, -1, `找不到起始片段：${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `找不到结束片段：${endMarker}`);
  return source.slice(start, end);
}

const componentSetup = sliceBetween('export default function Channels() {', 'const applyApiConfigData');
const editorSheet = sliceBetween('{/* Editor Side Sheet - Responsive */}', '<ChannelTestDialog');

assert.match(
  componentSetup,
  /const channelModalScrollYRef = useRef\(0\);/,
  '渠道编辑抽屉应该用 ref 保存打开前的 scrollY，不能用 state 保存',
);
assert.match(
  componentSetup,
  /const channelModalBodyStyleRef = useRef<\{ position: string; top: string; width: string \} \| null>\(null\);/,
  '渠道编辑抽屉应该用 ref 保存 body 原有内联样式，关闭时才能恢复',
);

const scrollLockEffect = sliceBetween('const restoreChannelModalScrollLock = useCallback', 'const applyApiConfigData');
assert.match(scrollLockEffect, /body\.style\.position = previousStyle\.position;/, '关闭抽屉时应该恢复 body 原有 position');
assert.match(scrollLockEffect, /body\.style\.top = previousStyle\.top;/, '关闭抽屉时应该恢复 body 原有 top');
assert.match(scrollLockEffect, /body\.style\.width = previousStyle\.width;/, '关闭抽屉时应该恢复 body 原有 width');
assert.match(scrollLockEffect, /window\.scrollTo\(0, scrollY\);/, '关闭抽屉或组件卸载时应该回到打开前的滚动位置');
assert.match(scrollLockEffect, /useEffect\(\(\) => \{[\s\S]*if \(!isModalOpen\) \{[\s\S]*restoreChannelModalScrollLock\(\);[\s\S]*return;[\s\S]*\}[\s\S]*const currentScrollY = window\.scrollY \|\| window\.pageYOffset \|\| document\.documentElement\.scrollTop \|\| 0;[\s\S]*channelModalScrollYRef\.current = currentScrollY;[\s\S]*body\.style\.position = 'fixed';[\s\S]*body\.style\.top = `-\$\{currentScrollY\}px`;[\s\S]*body\.style\.width = '100%';[\s\S]*return restoreChannelModalScrollLock;[\s\S]*\}, \[isModalOpen, restoreChannelModalScrollLock\]\);/, '打开抽屉时应该固定 body，并在关闭或清理函数中恢复滚动');

assert.match(
  editorSheet,
  /<Dialog\.Root open=\{isModalOpen\} modal=\{!isOAuthOverlayOpen\}/,
  '修复滚动问题时不能改掉编辑抽屉的 Radix modal 条件，OAuth overlay 依赖这个行为',
);

console.log('channels mobile scroll lock regression passed');
process.exit(0);
