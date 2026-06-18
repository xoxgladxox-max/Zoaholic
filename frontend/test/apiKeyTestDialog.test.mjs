import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 修改原因：API Key 测试弹窗曾在自动单 Key 测试时复用上一个渠道的模型状态。
// 修改方式：先编译纯 helper，再断言模型列表归一化和首个当前渠道模型选择逻辑。
// 目的：防止弹窗重新打开后继续使用旧渠道缓存模型发起测试请求。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, '..');
const tempDir = mkdtempSync(path.join(os.tmpdir(), 'zoaholic-api-key-test-dialog-'));
writeFileSync(path.join(tempDir, 'package.json'), '{"type":"module"}\n');

execFileSync('npx', [
  'tsc',
  '--target', 'ES2020',
  '--module', 'ES2020',
  '--moduleResolution', 'Bundler',
  '--rootDir', path.join(frontendRoot, 'src'),
  '--outDir', tempDir,
  '--noEmit', 'false',
  '--skipLibCheck', 'true',
  path.join(frontendRoot, 'src/lib/apiKeyTestDialog.ts'),
], { cwd: frontendRoot, stdio: 'pipe' });

const helpers = await import(pathToFileURL(path.join(tempDir, 'lib/apiKeyTestDialog.js')).href);
const { normalizeApiKeyTestModels, getInitialApiKeyTestModel, formatApiKeyTestError } = helpers;

assert.equal(typeof normalizeApiKeyTestModels, 'function', '应该导出模型列表归一化 helper');
assert.equal(typeof getInitialApiKeyTestModel, 'function', '应该导出初始模型选择 helper');
assert.equal(typeof formatApiKeyTestError, 'function', '应该导出错误格式化 helper');
assert.deepEqual(normalizeApiKeyTestModels([' current-a ', '', 'current-a', 'current-b']), ['current-a', 'current-b']);
assert.equal(getInitialApiKeyTestModel([' current-model ']), 'current-model');
assert.equal(getInitialApiKeyTestModel([]), '');

// 修改原因：后端错误 detail/error 可能是对象，直接 String(object) 会显示为 [object Object]。
// 修改方式：断言对象错误被 JSON 序列化，Error 实例仍保留 message。
// 目的：让用户能在测试面板看到实际错误详情。
const objectError = formatApiKeyTestError({ detail: { message: 'invalid key', code: 'auth_failed' } }, 401);
assert.match(objectError, /invalid key/);
assert.match(objectError, /auth_failed/);
assert.doesNotMatch(objectError, /\[object Object\]/);
assert.equal(formatApiKeyTestError(new Error('network down'), 500), 'network down');
assert.equal(formatApiKeyTestError({}, 502), '502');

// 修改原因：React setState 不能保证同一个 effect 闭包立即读到新 model。
// 修改方式：读取组件源码，确认自动单 Key 测试显式传入 firstModel，并且请求体使用本次解析出的 requestModel。
// 目的：避免自动测试请求落回旧闭包中的 model 状态。
const dialogSource = readFileSync(path.resolve(frontendRoot, 'src/components/ApiKeyTestDialog.tsx'), 'utf8');
assert.match(dialogSource, /testSingleKey\(initialKeyIndex, firstModel\)/, '自动单 Key 测试应该显式使用当前渠道首个模型');
assert.match(dialogSource, /const requestModel = \(modelOverride \?\? model\)\.trim\(\);/, '单 Key 测试应该支持本次调用的模型覆盖值');
assert.match(dialogSource, /model: requestModel,/, '请求体应该发送解析后的 requestModel');
assert.doesNotMatch(dialogSource, /error: String\(errMsg\)/, '错误对象不应再被直接 String 化');

console.log('api key test dialog regression passed');
// 修改原因：当前部署环境的 Node 18 在部分 ESM 脚本自然结束后会触发 Aborted。
// 修改方式：断言全部通过后显式以 0 退出，断言失败时仍会在这里之前抛出错误。
// 目的：让测试退出码只反映本文件断言是否通过。
process.exit(0);
