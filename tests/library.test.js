'use strict';

/** src/main/library.js：书籍会话——打开/翻页/章节/跳转/进度（不依赖 Electron）。 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Library } = require('../src/main/library');
const { DEFAULT_SETTINGS } = require('../src/common/store');

const GBK_HEX = 'b5dad2bbd5c220c6f0b5e30ad5e2cac7bcf2cce5d6d0cec4d5fdcec4a3acb2e2cad4b1e0c2ebd7d4b6afcab6b1f0a1a3';
const BIG5_HEX = 'b36fac4fc163c5e9a4a4a4e5b4fab8d5a143c163c5e9a470bba1aabaa4baae65a662b36fb8cca141a54cadccbba1b94caabab8dca143';

function fakeStore(overrides = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  const books = {};
  const saved = [];
  return {
    settings,
    bookProgress: (p) => (books[p] ? { ...books[p] } : null),
    saveProgress: (e) => { books[e.path] = { ...e }; saved.push({ ...e }); },
    lastBookPath: null,
    _books: books,
    _saved: saved,
  };
}

function writeTxt(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thief-book-lib-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

function sampleText(chapters = 6, linesPerChapter = 40) {
  const parts = [];
  for (let c = 1; c <= chapters; c++) {
    parts.push(`第${c}章 风起`);
    for (let l = 1; l <= linesPerChapter; l++) {
      parts.push(`这是${c}卷${l}节，${'内容'.repeat(15)}`);
    }
  }
  return parts.join('\n');
}

// 默认设置下：width 620 → unitsPerLine 38、每页 2 行，每行内容 ≈ 36 单位折 1 行
test('open: UTF-8 书籍打开并显示首页', () => {
  const lib = new Library(fakeStore());
  const file = writeTxt('样本.txt', sampleText());
  const r = lib.open(file);
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

test('open: 恢复历史进度并对齐页界', () => {
  const file = writeTxt('进度.txt', sampleText());
  const store = fakeStore();
  store._books[file] = { path: file, name: '进度', charIndex: Math.floor(sampleText().length / 2), percent: 0.5, updatedAt: 1, addedAt: 1 };
  const lib = new Library(store);
  const r = lib.open(file);
  assert.strictEqual(r.ok, true);
  const st = lib.pageState();
  assert.ok(st.percent > 0.02 && st.percent < 0.98, `恢复位置异常: ${st.percent}`);
  assert.ok(st.lines.length > 0);
});

test('open: GBK / Big5 文件解码', () => {
  const gbkFile = writeTxt('gbk书.txt', Buffer.from(GBK_HEX, 'hex'));
  const lib1 = new Library(fakeStore());
  assert.strictEqual(lib1.open(gbkFile).ok, true);
  assert.ok(lib1.pageState().lines.join('\n').includes('这是简体中文正文'));

  const big5File = writeTxt('big5书.txt', Buffer.from(BIG5_HEX, 'hex'));
  const lib2 = new Library(fakeStore());
  assert.strictEqual(lib2.open(big5File).ok, true);
  assert.ok(lib2.pageState().lines.join('\n').includes('繁體小說的內容在這裡'));
});

test('open: 错误处理（不存在/空文件/超大文件）', () => {
  const lib = new Library(fakeStore());

  const miss = lib.open('/nonexistent/没有这本书.txt');
  assert.strictEqual(miss.ok, false);
  assert.ok(miss.message.includes('无法读取'));

  const empty = lib.open(writeTxt('空.txt', ''));
  assert.strictEqual(empty.ok, false);
  assert.ok(empty.message.includes('内容为空'));

  const blank = lib.open(writeTxt('空白.txt', '\n\n \n\t\n'));
  assert.strictEqual(blank.ok, false);
  assert.ok(blank.message.includes('内容为空'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thief-book-lib-'));
  const big = path.join(dir, 'big.txt');
  const fh = fs.openSync(big, 'w');
  fs.ftruncateSync(fh, 64 * 1024 * 1024 + 1); // 稀疏文件，不占磁盘
  fs.closeSync(fh);
  const tooBig = lib.open(big);
  assert.strictEqual(tooBig.ok, false);
  assert.ok(tooBig.message.includes('64MB'));
});

test('turn: 翻到末页显示（完）且不再前进，向前翻到头不动', () => {
  const lib = new Library(fakeStore());
  lib.open(writeTxt('翻页.txt', sampleText(3, 10)));

  let st = lib.pageState();
  let guard = 0;
  while (!st.isEnd && guard++ < 10000) st = lib.turn(1);
  assert.ok(st.isEnd, '必须在有限步内到达末页');
  assert.strictEqual(st.hasNext, false);
  assert.ok(st.lines[st.lines.length - 1].includes('（完）'), '末页最后一行应有（完）');
  const endPercent = st.percent;
  const endLines = st.lines;

  st = lib.turn(1); // 末页再向后翻：停在原页
  assert.strictEqual(st.percent, endPercent);
  assert.deepStrictEqual(st.lines, endLines);

  while (guard++ < 20000 && st.percent > 0) st = lib.turn(-1); // 翻回开头
  assert.strictEqual(st.percent, 0);
  assert.strictEqual(st.hasPrev, false);
  st = lib.turn(-1); // 首页再向前翻：停在原页
  assert.strictEqual(st.percent, 0);
  assert.strictEqual(st.hasPrev, false);
});

test('turn: 文末多个换行不产生空尾页（回归）', () => {
  const lib = new Library(fakeStore());
  lib.open(writeTxt('尾行.txt', '短短的一页内容\n结束了\n\n\n'));
  const st = lib.pageState();
  assert.strictEqual(st.isEnd, true);
  assert.ok(st.lines[st.lines.length - 1].endsWith('（完）'));
  const again = lib.turn(1);
  assert.strictEqual(again.isEnd, true);
  assert.deepStrictEqual(again.lines, st.lines);
});

test('chapter: 下一章 / 章中回章头 / 跨章回退', () => {
  const lib = new Library(fakeStore());
  lib.open(writeTxt('章节.txt', sampleText(4, 15)));

  let st = lib.chapter(1); // 第1章 → 第2章
  assert.strictEqual(st.chapterTitle, '第2章 风起');
  st = lib.chapter(-1); // 第2章开头 → 第1章
  assert.strictEqual(st.chapterTitle, '第1章 风起');

  // 先翻进第1章中间，-1 应回本章开头，再 -1 回退到无章节区起点（第1章是文件开头 → 停住）
  lib.turn(1);
  st = lib.chapter(-1);
  assert.strictEqual(st.chapterTitle, '第1章 风起');
  assert.strictEqual(st.percent, 0, '第1章开头即文件开头');
  st = lib.chapter(-1);
  assert.strictEqual(st.percent, 0, '没有更前面的章节，原地不动');

  // 最后一章再向后：停在末页
  lib.chapter(1);
  lib.chapter(1);
  lib.chapter(1); // 第4章
  st = lib.chapter(1);
  assert.strictEqual(st.chapterTitle, '第4章 风起');
});

test('jumpPercent: 百分比跳转对齐页界', () => {
  const lib = new Library(fakeStore());
  lib.open(writeTxt('跳转.txt', sampleText()));
  const st = lib.jumpPercent(50);
  assert.ok(st.percent >= 0.45 && st.percent <= 0.55, `跳转落点 ${st.percent}`);
  assert.ok(st.lines.length > 0);

  assert.ok(lib.jumpPercent(-10).percent === 0);
  assert.ok(lib.jumpPercent(1000).isEnd);
});

test('reapplyMetrics: 改字号后仍对齐原阅读位置', () => {
  const store = fakeStore();
  const lib = new Library(store);
  lib.open(writeTxt('度量.txt', sampleText()));
  lib.jumpPercent(40);
  const before = lib.book.charIndex;

  store.settings.fontSize = 24; // 模拟设置变化
  store.settings.lines = 4;
  const st = lib.reapplyMetrics();
  assert.ok(st.lines.length > 0 && st.lines.length <= 4);
  assert.ok(
    Math.abs(lib.book.charIndex - before) <= 300,
    `改度量后位置漂移过大: ${before} → ${lib.book.charIndex}`
  );
});

test('flushSave: 进度防抖落盘', () => {
  const store = fakeStore();
  const lib = new Library(store);
  const file = writeTxt('落盘.txt', sampleText());
  lib.open(file);
  lib.turn(1);
  assert.strictEqual(store._saved.length, 0, '防抖期内不应立即写');
  lib.flushSave();
  assert.strictEqual(store._saved.length, 1);
  const b = store._books[file];
  assert.strictEqual(b.name, '落盘');
  assert.ok(b.charIndex > 0 && b.percent > 0);
});

test('appearance: 外观子集字段齐全', () => {
  const lib = new Library(fakeStore({ fontSize: 18, theme: 'light' }));
  lib.open(writeTxt('外观.txt', sampleText(1, 3)));
  const a = lib.appearance();
  assert.deepStrictEqual(
    Object.keys(a).sort(),
    ['bgColor', 'fgColor', 'fontSize', 'hoverMode', 'lines', 'showChapter', 'showProgress', 'theme', 'width'].sort()
  );
  assert.strictEqual(a.fontSize, 18);
  assert.strictEqual(a.theme, 'light');
});

test('无书状态: 所有操作安全返回', () => {
  const lib = new Library(fakeStore());
  assert.strictEqual(lib.hasBook, false);
  assert.strictEqual(lib.pageState(), null);
  assert.strictEqual(lib.turn(1), null);
  assert.strictEqual(lib.chapter(1), null);
  assert.strictEqual(lib.jumpPercent(50), null);
  lib.flushSave(); // 不应抛异常
});
