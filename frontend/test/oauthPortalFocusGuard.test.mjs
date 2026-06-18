import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 修改原因：OAuth 弹窗已经移动到 document.body portal，但仍可能被编辑抽屉的 Radix Dialog 焦点锁拉回。
// 修改方式：通过源码回归测试锁定编辑抽屉的外部焦点处理、外部交互处理和 portal 容器可聚焦属性。
// 目的：防止后续维护时再次让 OAuth 导入和手动粘贴输入框无法获得焦点。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const channelsSource = readFileSync(path.resolve(__dirname, '../src/pages/Channels.tsx'), 'utf8');

function sliceBetween(startMarker, endMarker, fromIndex = 0) {
  const start = channelsSource.indexOf(startMarker, fromIndex);
  assert.notEqual(start, -1, `找不到起始片段：${startMarker}`);
  const end = channelsSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `找不到结束片段：${endMarker}`);
  return channelsSource.slice(start, end);
}

const editorSheet = sliceBetween('{/* Editor Side Sheet - Responsive */}', '<ChannelTestDialog');
const importPortal = sliceBetween('{importModalIdx !== null && createPortal(', 'document.body');
const manualPortal = sliceBetween('{oauthManualState !== null && createPortal(', 'document.body', channelsSource.indexOf('{oauthManualState !== null && createPortal('));

assert.match(
  channelsSource,
  /const isOAuthOverlayOpen = importModalIdx !== null \|\| oauthManualState !== null;/,
  '应该把两个 OAuth portal 弹窗状态合并为编辑抽屉可复用的布尔值',
);
assert.match(
  editorSheet,
  /if \(!open && isOAuthOverlayOpen\) return;/,
  'OAuth portal 弹窗打开时，底层编辑抽屉不应该被外部交互关闭',
);
assert.match(
  editorSheet,
  /onFocusOutside=\{\(e\) => \{[\s\S]*if \(isOAuthOverlayOpen\) \{[\s\S]*e\.preventDefault\(\);[\s\S]*\}[\s\S]*\}\}/,
  'OAuth portal 弹窗打开时，编辑抽屉应该阻止 Radix 对外部焦点事件执行默认处理',
);
assert.match(
  editorSheet,
  /onInteractOutside=\{\(e\) => \{[\s\S]*if \(isOAuthOverlayOpen\) \{[\s\S]*e\.preventDefault\(\);[\s\S]*\}[\s\S]*\}\}/,
  'OAuth portal 弹窗打开时，编辑抽屉应该阻止 Radix 对外部交互事件执行默认处理',
);
assert.doesNotMatch(
  editorSheet,
  /modal=\{false\}|modal="false"/,
  '编辑抽屉不能通过彻底关闭 Dialog modal 模式来绕过焦点问题',
);
assert.match(importPortal, /<div\s+tabIndex=\{-1\}[\s\S]*导入 Refresh Token/, '导入弹窗的 portal 遮罩容器应该可作为焦点回退目标');
assert.match(importPortal, /<textarea[\s\S]*autoFocus/, '导入弹窗的 textarea 应该保持自动聚焦');
assert.match(manualPortal, /<div\s+tabIndex=\{-1\}[\s\S]*完成 OAuth 登录/, '手动粘贴弹窗的 portal 遮罩容器应该可作为焦点回退目标');
assert.match(manualPortal, /<input[\s\S]*autoFocus/, '手动粘贴弹窗的 input 应该保持自动聚焦');

console.log('oauth portal focus guard regression passed');
// 修改原因：当前部署环境的 Node 18 在部分 ESM 脚本自然结束后会触发 Aborted。
// 修改方式：断言全部通过后显式以 0 退出，断言失败时仍会在这里之前抛出错误。
// 目的：让测试退出码只反映本文件断言是否通过。
process.exit(0);
