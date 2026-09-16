'use strict';

/**
 * 零依赖单测运行器：node tests/run.js [关键字]
 * 用例在 tests/*.test.js 顶层通过全局 test(name, fn) 注册，fn 可为 async。
 * 关键字按用例名或文件名子串过滤。
 */

const fs = require('fs');
const path = require('path');

const filter = process.argv[2] || '';
const tests = [];

global.test = (name, fn) => {
  if (typeof fn !== 'function') throw new TypeError(`test("${name}") 缺少测试函数`);
  tests.push({ name, fn, file: '' });
};

const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

for (const f of files) {
  const before = tests.length;
  require(path.join(__dirname, f));
  for (let i = before; i < tests.length; i++) tests[i].file = f;
}

(async () => {
  const run = tests.filter((t) => !filter || t.name.includes(filter) || t.file.includes(filter));
  if (!run.length) {
    console.error(`没有匹配「${filter}」的用例（共 ${tests.length} 个）`);
    process.exit(1);
  }
  let failed = 0;
  const t0 = Date.now();
  for (const t of run) {
    try {
      await t.fn();
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL  ${t.name}  (${t.file})`);
      const lines = err && err.stack ? err.stack.split('\n').slice(0, 3) : [String(err)];
      console.error(`      ${lines.join('\n      ')}`);
    }
  }
  const ms = Date.now() - t0;
  if (failed) {
    console.error(`\n${failed}/${run.length} 个用例失败 (${ms}ms)`);
    process.exit(1);
  }
  console.log(`\n${run.length} 个用例全部通过 (${ms}ms)`);
})();
