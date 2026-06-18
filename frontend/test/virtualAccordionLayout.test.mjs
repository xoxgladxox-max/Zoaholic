import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 修改原因：虚拟模型列表从独立行改为手风琴后，页面结构很容易在后续重构中退回到混入主列表。
// 修改方式：读取 Channels.tsx 源码，断言虚拟模型使用独立 entries、独立筛选和手风琴渲染函数。
// 目的：在不新增浏览器测试依赖的前提下，覆盖本次 UI 重构的关键结构约束。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const channelsSource = readFileSync(path.resolve(__dirname, '../src/pages/Channels.tsx'), 'utf8');
const virtualModelsSource = readFileSync(path.resolve(__dirname, '../src/lib/virtualModels.ts'), 'utf8');

assert.match(channelsSource, /buildVirtualProviderEntries/, '渠道页应该单独生成虚拟模型 entries');
assert.match(channelsSource, /filteredVirtualProviderEntries/, '渠道页应该单独筛选虚拟模型 entries');
assert.match(channelsSource, /renderDesktopVirtualRoutesAccordionRows/, '桌面端应该通过独立手风琴行渲染虚拟模型');
assert.match(channelsSource, /renderMobileVirtualRoutesAccordion/, '移动端应该通过独立手风琴卡片渲染虚拟模型');
assert.match(channelsSource, /openVirtualRouteTestDialog/, '虚拟路由手风琴应该有统一测试入口');
assert.match(channelsSource, /buildVirtualRouteTestProvider/, '测试弹窗应该使用虚拟路由测试 provider 快照');
assert.doesNotMatch(channelsSource, /if \(isVirtualProviderEntry\(p\)\)/, '虚拟模型不应该再作为普通卡片或表格行分支混入主列表');
assert.doesNotMatch(channelsSource, /isVirtualProviderEntry,/, 'Channels.tsx 不应该再导入虚拟行类型判断');

assert.match(virtualModelsSource, /export function buildVirtualRouteTestProvider/, '虚拟模型工具应该导出测试弹窗 provider 构造函数');
assert.match(virtualModelsSource, /_virtual_route_test: true/, '虚拟路由测试 provider 应该带后端可识别的测试标记');
assert.match(virtualModelsSource, /return realItems;/, '主 providerListItems 应该只返回真实渠道');

console.log('virtual routes accordion layout passed');
// 修改原因：当前部署环境的 Node 18 在部分 ESM 脚本自然结束后会触发 Aborted。
// 修改方式：断言全部通过后显式以 0 退出，断言失败时仍会在这里之前抛出错误。
// 目的：让测试退出码只反映本文件断言是否通过。
process.exit(0);
