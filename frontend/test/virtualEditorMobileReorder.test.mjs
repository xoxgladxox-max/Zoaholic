import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 修改原因：手机触摸屏不会触发 HTML5 原生拖拽事件，虚拟模型链条节点必须提供非拖拽排序入口。
// 修改方式：读取 Channels.tsx 源码，断言编辑器节点卡片存在上下移动按钮、相邻交换逻辑，并且原有拖拽入口仍保留。
// 目的：在不新增浏览器测试依赖的前提下，防止后续改动再次让移动端无法调整节点优先级。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const channelsSource = readFileSync(path.resolve(__dirname, '../src/pages/Channels.tsx'), 'utf8');
const editorStart = channelsSource.indexOf('const moveVirtualEditorNode');
const editorCardStart = channelsSource.indexOf('key={`virtual-editor-${idx}-${node.type}-${node.value}`}');

assert.notEqual(editorStart, -1, '应该能定位到虚拟模型编辑器排序逻辑');
assert.notEqual(editorCardStart, -1, '应该能定位到虚拟模型编辑器节点卡片代码段');

const editorLogicSource = channelsSource.slice(editorStart, editorStart + 7000);
const editorCardSource = channelsSource.slice(editorCardStart, editorCardStart + 12000);

assert.match(channelsSource, /ChevronUp/, '应该导入或使用 ChevronUp 图标作为上移按钮');
assert.match(channelsSource, /ChevronDown/, '应该导入或使用 ChevronDown 图标作为下移按钮');
assert.match(editorLogicSource, /const swapVirtualEditorNode/, '应该提供相邻节点交换函数供移动端按钮使用');
assert.match(editorLogicSource, /const targetIdx = idx \+ direction;/, '上下移动应该通过方向计算相邻目标索引');
assert.match(editorLogicSource, /\[next\[idx\], next\[targetIdx\]\] = \[next\[targetIdx\], next\[idx\]\];/, '上下移动应该交换相邻两个节点的位置');
assert.match(editorCardSource, /title="上移节点"/, '节点操作区应该包含上移按钮');
assert.match(editorCardSource, /title="下移节点"/, '节点操作区应该包含下移按钮');
assert.match(editorCardSource, /disabled=\{idx === 0\}/, '第一个节点的上移按钮应该禁用');
assert.match(editorCardSource, /disabled=\{idx === virtualEditorChain\.length - 1\}/, '最后一个节点的下移按钮应该禁用');
assert.match(editorCardSource, /onDragStart=\{e => handleChainNodeDragStart\(e, '__virtual_editor__', idx\)\}/, '桌面端原生拖拽排序必须继续保留');
assert.match(channelsSource, /virtualAddNodeTypes\[virtualDraftName\.trim\(\) \|\| editingVirtualName \|\| '__new_virtual_model__'\]/, '底部添加节点区域应该保留节点类型下拉选择');
assert.match(channelsSource, /onClick=\{appendVirtualEditorNodeByType\}/, '底部添加节点按钮应该继续可用');

console.log('virtual editor mobile reorder controls passed');
// 修改原因：当前部署环境的 Node 18 在部分 ESM 脚本自然结束后会触发 Aborted。
// 修改方式：断言全部通过后显式以 0 退出，断言失败时仍会在这里之前抛出错误。
// 目的：让测试退出码只反映本文件断言是否通过。
process.exit(0);
