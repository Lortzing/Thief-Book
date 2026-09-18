'use strict';

/** src/common/session.mjs:书籍会话(注入 backend,不依赖 Tauri/Node 专属 API)。 */

const assert = require('assert');
const { Library } = require('../src/common/session.mjs');
const { DEFAULT_SETTINGS } = require('../src/common/settings.mjs');

const GBK_HEX = 'b5dad2bbd5c220c6f0b5e30ad5e2cac7bcf2cce5d6d0cec4d5fdcec4a3acb2e2cad4b1e0c2ebd7d4b6afcab6b1f0a1a3';
const BIG5_HEX = 'b36fac4fc163c5e9a4a4a4e5b4fab8d5a143c163c5e9a470bba1aabaa4baae65a662b36fb8cca141a54cadccbba1b94caabab8dca143';

function makeBackend({ files = {}, progress = {}, overrides = {} } = {}) {
  const backend = {
    settings: { ...DEFAULT_SETTINGS, ...overrides },
    saved: [],
    getProgress: (p) => (progress[p] !== undefined ? { charIndex: progress[p] } : null),
    readBook: async (p) => {
      const buf = files[p];
      if (buf === undefined) throw new Error(`无法读取文件:${p}`);
      return buf;
    },
    saveProgress: (e) => backend.saved.push({ ...e }),
  };
  return backend;
}

function writeTextFile(name, content) {
  return { [`/books/${name}`]: Buffer.from(content, 'utf8') };
}

function sampleText(chapters = 6, linesPerChapter = 40) {
  const parts = [];
  for (let c = 1; c <= chapters; c++) {
    parts.push(`第${c}章 风起`);
    for (let l = 1; l <= linesPerChapter; l++) {
      parts.push(`这是${c}卷${l}节,${'内容'.repeat(15)}`);
    }
  }
  return parts.join('\n');
}

// 默认设置下:width 620 → unitsPerLine 38、每页 2 行,每行内容 ≈ 36 单位折 1 行

test('open: UTF-8 书籍打开并显示首页', async () => {
  const backend = makeBackend({ files: writeTextFile('样本.txt', sampleText()) });
  const lib = new Library(backend);
  const r = await lib.open('/books/样本.txt');
  assert.strictEqual(r.ok, true);
  const st = lib.pageState();
  assert.strictEqual(st.bookName, '样本');
  assert.strictEqual(st.chapterTitle, '第1章 风起');
  assert.strictEqual(st.hasPrev, false);
  assert.strictEqual(st.hasNext, true);
  assert.strictEqual(st.isEnd, false);
  assert.ok(st.lines.length > 0 && st.lines.length <= 2);
  assert.ok(st.percent === 0);
});

test('open: 恢复历史进度并对齐页界', async () => {
  const text = sampleText();
  const backend = makeBackend({
    files: writeTextFile('进度.txt', text),
    progress: { '/books/进度.txt': Math.floor(text.length / 2) },
  });
  const lib = new Library(backend);
  const r = await lib.open('/books/进度.txt');
  assert.strictEqual(r.ok, true);
  const st = lib.pageState();
  assert.ok(st.percent > 0.02 && st.percent < 0.98, `恢复位置异常: ${st.percent}`);
  assert.ok(st.lines.length > 0);
});

test('open: GBK / Big5 文件解码', async () => {
  const lib1 = new Library(
    makeBackend({ files: { '/books/gbk书.txt': Buffer.from(GBK_HEX, 'hex') } })
  );
  assert.strictEqual((await lib1.open('/books/gbk书.txt')).ok, true);
  assert.ok(lib1.pageState().lines.join('\n').includes('这是简体中文正文'));

  const lib2 = new Library(
    makeBackend({ files: { '/books/big5书.txt': Buffer.from(BIG5_HEX, 'hex') } })
  );
  assert.strictEqual((await lib2.open('/books/big5书.txt')).ok, true);
  assert.ok(lib2.pageState().lines.join('\n').includes('繁體小說的內容在這裡'));
});

test('open: 读取失败 / 空文件 / 全空白', async () => {
  const lib = new Library(makeBackend()); // 没有文件 → readBook 抛错
  const miss = await lib.open('/books/没有这本书.txt');
  assert.strictEqual(miss.ok, false);
  assert.ok(miss.message.includes('无法读取'));

  const empty = new Library(makeBackend({ files: { '/books/空.txt': Buffer.alloc(0) } }));
  const r1 = await empty.open('/books/空.txt');
  assert.strictEqual(r1.ok, false);
  assert.ok(r1.message.includes('内容为空'));

  const blank = new Library(
    makeBackend({ files: { '/books/空白.txt': Buffer.from('\n\n \n\t\n') } })
  );
  const r2 = await blank.open('/books/空白.txt');
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.message.includes('内容为空'));
});

test('turn: 翻到末页显示(完)且不再前进,向前翻到头不动', async () => {
  const lib = new Library(
    makeBackend({ files: writeTextFile('翻页.txt', sampleText(3, 10)) })
  );
  await lib.open('/books/翻页.txt');

  let st = lib.pageState();
  let guard = 0;
  while (!st.isEnd && guard++ < 10000) st = lib.turn(1);
  assert.ok(st.isEnd, '必须在有限步内到达末页');
  assert.strictEqual(st.hasNext, false);
  assert.ok(st.lines[st.lines.length - 1].includes('（完）'), '末页最后一行应有（完）');
  const endPercent = st.percent;
  const endLines = st.lines;

  st = lib.turn(1); // 末页再向后翻:停在原页
  assert.strictEqual(st.percent, endPercent);
  assert.deepStrictEqual(st.lines, endLines);

  while (guard++ < 20000 && st.percent > 0) st = lib.turn(-1); // 翻回开头
  assert.strictEqual(st.percent, 0);
  assert.strictEqual(st.hasPrev, false);
  st = lib.turn(-1); // 首页再向前翻:停在原页
  assert.strictEqual(st.percent, 0);
  assert.strictEqual(st.hasPrev, false);
});

test('turn: 文末多个换行不产生空尾页(回归)', async () => {
  const lib = new Library(
    makeBackend({ files: writeTextFile('尾行.txt', '短短的一页内容\n结束了\n\n\n') })
  );
  await lib.open('/books/尾行.txt');
  const st = lib.pageState();
  assert.strictEqual(st.isEnd, true);
  assert.ok(st.lines[st.lines.length - 1].endsWith('（完）'));
  const again = lib.turn(1);
  assert.strictEqual(again.isEnd, true);
  assert.deepStrictEqual(again.lines, st.lines);
});

test('chapter: 下一章 / 章中回章头 / 跨章回退', async () => {
  const lib = new Library(
    makeBackend({ files: writeTextFile('章节.txt', sampleText(4, 15)) })
  );
  await lib.open('/books/章节.txt');

  let st = lib.chapter(1); // 第1章 → 第2章
  assert.strictEqual(st.chapterTitle, '第2章 风起');
  st = lib.chapter(-1); // 第2章开头 → 第1章
  assert.strictEqual(st.chapterTitle, '第1章 风起');

  lib.turn(1);
  st = lib.chapter(-1);
  assert.strictEqual(st.chapterTitle, '第1章 风起');
  assert.strictEqual(st.percent, 0, '第1章开头即文件开头');
  st = lib.chapter(-1);
  assert.strictEqual(st.percent, 0, '没有更前面的章节,原地不动');

  lib.chapter(1);
  lib.chapter(1);
  lib.chapter(1); // 第4章
  st = lib.chapter(1);
  assert.strictEqual(st.chapterTitle, '第4章 风起');
});

test('jumpPercent: 百分比跳转对齐页界', async () => {
  const lib = new Library(makeBackend({ files: writeTextFile('跳转.txt', sampleText()) }));
  await lib.open('/books/跳转.txt');
  const st = lib.jumpPercent(50);
  assert.ok(st.percent >= 0.45 && st.percent <= 0.55, `跳转落点 ${st.percent}`);
  assert.ok(st.lines.length > 0);

  assert.ok(lib.jumpPercent(-10).percent === 0);
  assert.ok(lib.jumpPercent(1000).isEnd);
});

test('reapplyMetrics: 改字号后仍对齐原阅读位置', async () => {
  const backend = makeBackend({ files: writeTextFile('度量.txt', sampleText()) });
  const lib = new Library(backend);
  await lib.open('/books/度量.txt');
  lib.jumpPercent(40);
  const before = lib.book.charIndex;

  backend.settings.fontSize = 24; // 模拟设置变化
  backend.settings.lines = 4;
  const st = lib.reapplyMetrics();
  assert.ok(st.lines.length > 0 && st.lines.length <= 4);
  assert.ok(
    Math.abs(lib.book.charIndex - before) <= 300,
    `改度量后位置漂移过大: ${before} → ${lib.book.charIndex}`
  );
});

test('进度保存:防抖 500ms 后落盘,flushSave 立即', async () => {
  const backend = makeBackend({ files: writeTextFile('落盘.txt', sampleText()) });
  const lib = new Library(backend);
  await lib.open('/books/落盘.txt');
  lib.turn(1);
  assert.strictEqual(backend.saved.length, 0, '防抖期内不应立即写');
  lib.flushSave();
  assert.strictEqual(backend.saved.length, 1);
  const e = backend.saved[0];
  assert.strictEqual(e.name, '落盘');
  assert.ok(e.charIndex > 0 && e.percent > 0 && e.percent <= 1);
});

test('无书状态: 所有操作安全返回', async () => {
  const lib = new Library(makeBackend());
  assert.strictEqual(lib.hasBook, false);
  assert.strictEqual(lib.currentPath, null);
  assert.strictEqual(lib.pageState(), null);
  assert.strictEqual(lib.turn(1), null);
  assert.strictEqual(lib.chapter(1), null);
  assert.strictEqual(lib.jumpPercent(50), null);
  lib.flushSave(); // 不应抛异常
});
