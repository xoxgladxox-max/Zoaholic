import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 修改原因：子渠道启用、删除和编辑保存曾通过 /v1/api_config/update 提交完整 providers，容易覆盖其他会话的改动。
// 修改方式：直接读取 Channels.tsx，断言三处子渠道保存逻辑都只 PUT 所属主渠道，并在成功后刷新后端最新配置。
// 目的：在不引入浏览器测试框架的前提下，防止子渠道操作回退为全量覆盖。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, '..');
const source = readFileSync(path.resolve(frontendRoot, 'src/pages/Channels.tsx'), 'utf8');

function sliceBetween(startMarker, endMarker, fromIndex = 0) {
  const start = source.indexOf(startMarker, fromIndex);
  assert.notEqual(start, -1, `找不到起始片段：${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `找不到结束片段：${endMarker}`);
  return source.slice(start, end);
}

const toggleSubChannel = sliceBetween('const handleToggleSubChannel', 'const handleDeleteSubChannel');
assert.match(toggleSubChannel, /const updatedParent = \{ \.\.\.parent, sub_channels: subs \};/, '子渠道启用开关应该构造更新后的主渠道对象');
assert.match(toggleSubChannel, /const providerId = String\(parent\.provider \|\| ''\)\.trim\(\);/, '子渠道启用开关应该使用所属主渠道 provider id');
assert.match(toggleSubChannel, /apiFetch\(buildProviderApiPath\(providerId\)/, '子渠道启用开关应该 PUT 单个主渠道路径');
assert.match(toggleSubChannel, /method: 'PUT'/, '子渠道启用开关应该使用 PUT');
assert.match(toggleSubChannel, /body: JSON\.stringify\(updatedParent\)/, '子渠道启用开关应该提交更新后的主渠道对象');
assert.match(toggleSubChannel, /await refreshProviders\(\)/, '子渠道启用开关成功后应该刷新后端最新列表');
assert.doesNotMatch(toggleSubChannel, /\/v1\/api_config\/update/, '子渠道启用开关不应再提交全量配置');
assert.doesNotMatch(toggleSubChannel, /setProviders/, '子渠道启用开关不应使用本地数组替代后端刷新');

const deleteSubChannel = sliceBetween('const handleDeleteSubChannel', 'const openSubChannelEdit');
assert.match(deleteSubChannel, /const updatedParent = \{ \.\.\.parent, sub_channels: subs\.length > 0 \? subs : undefined \};/, '子渠道删除应该构造更新后的主渠道对象');
assert.match(deleteSubChannel, /const providerId = String\(parent\.provider \|\| ''\)\.trim\(\);/, '子渠道删除应该使用所属主渠道 provider id');
assert.match(deleteSubChannel, /apiFetch\(buildProviderApiPath\(providerId\)/, '子渠道删除应该 PUT 单个主渠道路径');
assert.match(deleteSubChannel, /method: 'PUT'/, '子渠道删除应该使用 PUT');
assert.match(deleteSubChannel, /body: JSON\.stringify\(updatedParent\)/, '子渠道删除应该提交更新后的主渠道对象');
assert.match(deleteSubChannel, /await refreshProviders\(\)/, '子渠道删除成功后应该刷新后端最新列表');
assert.doesNotMatch(deleteSubChannel, /\/v1\/api_config\/update/, '子渠道删除不应再提交全量配置');
assert.doesNotMatch(deleteSubChannel, /setProviders/, '子渠道删除不应使用本地数组替代后端刷新');

const subChannelSaveSetup = sliceBetween('if (editingSubChannel) {', '} else if (originalIndex !== null) {');
assert.match(subChannelSaveSetup, /subChannelParentProviderId = String\(parent\.provider \|\| ''\)\.trim\(\);/, '子渠道编辑保存应该记录所属主渠道 provider id');
assert.match(subChannelSaveSetup, /newProviders\[parentIdx\] = \{ \.\.\.parent, sub_channels: subs \};/, '子渠道编辑保存应该把子渠道写回所属主渠道对象');

const saveRequestStart = source.indexOf('const res = editingSubChannel');
assert.notEqual(saveRequestStart, -1, '找不到保存请求分支');
const saveRequest = sliceBetween('const res = editingSubChannel', 'if (res.ok)', saveRequestStart);
assert.match(saveRequest, /apiFetch\(buildProviderApiPath\(subChannelParentProviderId\)/, '子渠道编辑保存应该 PUT 单个主渠道路径');
assert.match(saveRequest, /method: 'PUT'/, '子渠道编辑保存应该使用 PUT');
assert.match(saveRequest, /body: JSON\.stringify\(newProviders!\[editingSubChannel\.parentIdx\]\)/, '子渠道编辑保存应该提交更新后的主渠道对象');
assert.doesNotMatch(saveRequest, /\/v1\/api_config\/update/, '子渠道编辑保存不应再提交全量配置');
assert.doesNotMatch(saveRequest, /JSON\.stringify\(\{ providers: newProviders \}\)/, '子渠道编辑保存不应发送 providers 全量数组');

const saveSuccess = sliceBetween('if (res.ok) {', '} else {\n        const err = await res.json().catch(() => ({}));\n        toastError(fmtErr(err, res.status), "保存失败");', saveRequestStart);
assert.match(saveSuccess, /await refreshProviders\(\)/, '子渠道编辑保存成功后应该刷新后端最新列表');
assert.doesNotMatch(saveSuccess, /setProviders\(sortByWeight\(newProviders\)\)/, '子渠道编辑保存成功后不应使用本地数组替代后端刷新');

console.log('sub-channel provider PUT regression passed');
process.exit(0);
