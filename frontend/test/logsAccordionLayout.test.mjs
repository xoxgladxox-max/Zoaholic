import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 修改原因：日志详情原来把客户端和上游的七个 JSON 折叠项平铺展示，后续重构容易退回旧布局。
// 修改方式：直接读取 Logs.tsx 源码，断言详情区存在“客户端”和“上游”两个分组，并且折叠项标题去掉重复前缀。
// 目的：在不引入浏览器测试依赖的前提下，固定本次日志详情分组优化的关键结构。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsSource = readFileSync(path.resolve(__dirname, '../src/pages/Logs.tsx'), 'utf8');

// 修改原因：页面里不止一个 space-y-2 容器，直接取第一个会误判重试路径组件。
// 修改方式：先定位 Expanded Content 注释，再从展开详情内部查找 JSON 折叠项容器。
// 目的：让测试只约束日志详情展开区，不受其他局部组件影响。
const expandedContentStart = logsSource.indexOf('{/* Expanded Content */}');
assert.notEqual(expandedContentStart, -1, '日志详情应该保留展开内容区域');
const detailsStart = logsSource.indexOf('<div className="space-y-2">', expandedContentStart);
assert.notEqual(detailsStart, -1, '日志详情应该保留 JSON 折叠项容器');
const detailsSource = logsSource.slice(detailsStart, logsSource.indexOf('</div>\n          </div>\n        )}', detailsStart));

assert.match(detailsSource, /客户端/, '日志详情应该用小标签分出客户端数据');
assert.match(detailsSource, /上游/, '日志详情应该用小标签分出上游数据');
assert.match(
  detailsSource,
  /客户端[\s\S]*title="请求头" data=\{log\.request_headers\}[\s\S]*title="请求体" data=\{log\.request_body\}[\s\S]*title="响应体" data=\{log\.response_body\}/,
  '客户端分组应该依次展示请求头、请求体、响应体',
);
assert.match(
  detailsSource,
  /上游[\s\S]*title="请求头" data=\{log\.upstream_request_headers\}[\s\S]*title="请求体" data=\{log\.upstream_request_body\}[\s\S]*title="响应头" data=\{log\.upstream_response_headers\}[\s\S]*title="响应体" data=\{log\.upstream_response_body\}/,
  '上游分组应该依次展示请求头、请求体、响应头、响应体',
);
assert.doesNotMatch(detailsSource, /title="用户请求体"|title="用户响应体"|title="上游请求头"|title="上游请求体"|title="上游响应头"|title="上游响应体"/, '分组后折叠项标题不应该重复用户或上游前缀');

console.log('logs accordion grouping layout passed');
// 修改原因：当前部署环境的 Node 18 在部分 ESM 脚本自然结束后会触发 Aborted。
// 修改方式：断言全部通过后显式以 0 退出，断言失败时仍会在这里之前抛出错误。
// 目的：让测试退出码只反映本文件断言是否通过。
process.exit(0);
