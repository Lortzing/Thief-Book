'use strict';

/** src/common/book.js：编码解码、章节识别、确定性分页。 */

const assert = require('assert');
const {
  decodeBuffer,
  normalizeText,
  detectChapters,
  matchChapterLine,
  isWideCodePoint,
  Paginator,
} = require('../src/common/book.mjs');

// iconv 生成的真实编码字节（测试零依赖，不再依赖外部工具）
const GBK_TEXT = '第一章 起点\n这是简体中文正文，测试编码自动识别。';
const GBK_HEX = 'b5dad2bbd5c220c6f0b5e30ad5e2cac7bcf2cce5d6d0cec4d5fdcec4a3acb2e2cad4b1e0c2ebd7d4b6afcab6b1f0a1a3';
const BIG5_TEXT = '這是繁體中文測試。繁體小說的內容在這裡，他們說過的話。';
const BIG5_HEX = 'b36fac4fc163c5e9a4a4a4e5b4fab8d5a143c163c5e9a470bba1aabaa4baae65a662b36fb8cca141a54cadccbba1b94caabab8dca143';
// GBK 也能表示繁体字（GBK 内含繁体映射），此时应按 GB18030 解出正确文本
const GBK_TRAD_TEXT = '第一章 起点\n這是繁體中文的段落，他們說的話在這裡。';
const GBK_TRAD_HEX = 'b5dad2bbd5c220c6f0b5e30adf40cac7b7b1f377d6d0cec4b5c4b6cec2e4a3accbfb8283d566b5c4d492d4dadf40d165a1a3';

// ---------------------------------------------------------------------------
// 编码
// ---------------------------------------------------------------------------

test('decodeBuffer: UTF-8 BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文abc', 'utf8')]);
  const r = decodeBuffer(buf);
  assert.strictEqual(r.encoding, 'utf-8');
  assert.strictEqual(r.text, '中文abc');
});

test('decodeBuffer: UTF-16LE BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文', 'utf16le')]);
  const r = decodeBuffer(buf);
  assert.strictEqual(r.encoding, 'utf-16le');
  assert.strictEqual(r.text, '中文');
});

test('decodeBuffer: UTF-16BE BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('中文', 'utf16le').swap16()]);
  const r = decodeBuffer(buf);
  assert.strictEqual(r.encoding, 'utf-16be');
  assert.strictEqual(r.text, '中文');
});

test('decodeBuffer: 无 BOM 的 UTF-8', () => {
  const r = decodeBuffer(Buffer.from('普通utf8文本，混合English。', 'utf8'));
  assert.strictEqual(r.encoding, 'utf-8');
  assert.strictEqual(r.text, '普通utf8文本，混合English。');
});

test('decodeBuffer: GBK 简体中文', () => {
  const r = decodeBuffer(Buffer.from(GBK_HEX, 'hex'));
  assert.strictEqual(r.encoding, 'gb18030');
  assert.strictEqual(r.text, GBK_TEXT);
});

test('decodeBuffer: Big5 繁体中文（不落进 GB18030 乱码陷阱）', () => {
  const r = decodeBuffer(Buffer.from(BIG5_HEX, 'hex'));
  assert.strictEqual(r.encoding, 'big5');
  assert.strictEqual(r.text, BIG5_TEXT);
});

test('decodeBuffer: GBK 编码的繁体文本仍按 GB18030 正确解出', () => {
  const r = decodeBuffer(Buffer.from(GBK_TRAD_HEX, 'hex'));
  assert.strictEqual(r.encoding, 'gb18030');
  assert.strictEqual(r.text, GBK_TRAD_TEXT);
});

test('decodeBuffer: 无法识别的字节回退为宽松 UTF-8', () => {
  const r = decodeBuffer(Buffer.from([0xc0, 0xff, 0x81]));
  assert.strictEqual(r.encoding, 'utf-8(lossy)');
  assert.ok(r.text.includes('�'));
});

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

test('normalizeText: 统一 CRLF / CR 换行', () => {
  assert.strictEqual(normalizeText('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('normalizeText: 去除文末空白（避免空白尾页与丢失“（完）”）', () => {
  assert.strictEqual(normalizeText('正文\n\n\n'), '正文');
  assert.strictEqual(normalizeText('正文 \n\t　'), '正文');
  assert.strictEqual(normalizeText('正文'), '正文');
  assert.strictEqual(normalizeText('   \n  \n'), '');
});

// ---------------------------------------------------------------------------
// 章节识别
// ---------------------------------------------------------------------------

test('matchChapterLine: 常见章节标题', () => {
  assert.strictEqual(matchChapterLine('第1章 风起'), '第1章 风起');
  assert.strictEqual(matchChapterLine('第12章'), '第12章');
  assert.strictEqual(matchChapterLine('第一百二十三章 大结局'), '第一百二十三章 大结局');
  assert.strictEqual(matchChapterLine('Chapter 12 The End'), 'Chapter 12 The End');
  assert.strictEqual(matchChapterLine('楔子'), '楔子');
  assert.strictEqual(matchChapterLine('番外篇 十年后'), '番外篇 十年后');
  assert.strictEqual(matchChapterLine('　第３回　夜话　'), '第３回 夜话'); // 全角空格净化
});

test('matchChapterLine: 非章节行', () => {
  assert.strictEqual(matchChapterLine('第二天他醒来了'), null); // 「天」不在章节字列表
  assert.strictEqual(matchChapterLine('第x章'), null);           // 非中文/阿拉伯数字
  assert.strictEqual(matchChapterLine('a'.repeat(50)), null);    // 超长行
  assert.strictEqual(matchChapterLine(''), null);
  assert.strictEqual(matchChapterLine('普通的一句话'), null);
});

function sampleBook(chapters = 8, linesPerChapter = 30) {
  const parts = [];
  for (let c = 1; c <= chapters; c++) {
    parts.push(`第${c}章 风起`);
    for (let l = 1; l <= linesPerChapter; l++) {
      // 内容行不能以“第X章”开头，否则会被章节正则误识别
      parts.push(`这是${c}卷${l}节，${'内容'.repeat(12)}`);
    }
  }
  return parts.join('\n');
}

test('detectChapters: 识别全部章节', () => {
  const text = sampleBook(8);
  const chs = detectChapters(text);
  assert.strictEqual(chs.length, 8);
  assert.strictEqual(chs[0].title, '第1章 风起');
  assert.strictEqual(chs[0].charIndex, 0);
  assert.strictEqual(chs[7].charIndex, text.indexOf('第8章 风起'));
});

test('detectChapters: 开头目录页被剔除', () => {
  const lines = [];
  for (const t of ['第一章', '第二章', '第三章', '第四章', '第五章']) lines.push(t); // 密集目录
  for (const t of ['第一章', '第二章', '第三章']) {
    lines.push(t);
    for (let i = 0; i < 5; i++) lines.push('正文内容。'.repeat(6));
  }
  const chs = detectChapters(lines.join('\n'));
  assert.strictEqual(chs.length, 3); // 只剩正文章节
  assert.strictEqual(chs[0].charIndex, 20); // 目录块 5 行 × 4 字符之后，即正文第一章
});

test('detectChapters: 相邻重复标题去重', () => {
  assert.deepStrictEqual(detectChapters('第一章 起点\n第一章 起点\n正文内容'), []);
});

test('detectChapters: 无章节返回空数组', () => {
  assert.deepStrictEqual(detectChapters('没有任何章节标记的普通文本\n第二行内容'), []);
});

// ---------------------------------------------------------------------------
// 宽度加权
// ---------------------------------------------------------------------------

test('isWideCodePoint: 全角/半角判定', () => {
  assert.ok(isWideCodePoint('中'.codePointAt(0)));
  assert.ok(isWideCodePoint('，'.codePointAt(0))); // 全角标点
  assert.ok(isWideCodePoint('𠀀'.codePointAt(0))); // 扩展 B 平面外字
  assert.ok(!isWideCodePoint('A'.codePointAt(0)));
  assert.ok(!isWideCodePoint(' '.codePointAt(0)));
});

// ---------------------------------------------------------------------------
// 分页器
// ---------------------------------------------------------------------------

test('分页: 全角/半角按宽度加权折行', () => {
  // 注意 setMetrics 有 unitsPerLine >= 4 的下限，这里全部用 >= 4 的预算
  const full = new Paginator('啊啊啊啊啊啊啊', []);
  full.setMetrics({ unitsPerLine: 5, maxLines: 10 });
  assert.deepStrictEqual(full.build(0).lines, ['啊啊啊啊啊', '啊啊']);

  const half = new Paginator('abcdefghijklmnop', []);
  half.setMetrics({ unitsPerLine: 4, maxLines: 10 });
  assert.deepStrictEqual(half.build(0).lines, ['abcdefgh', 'ijklmnop']);

  const mixed = new Paginator('a啊a啊a啊a啊', []);
  mixed.setMetrics({ unitsPerLine: 4, maxLines: 10 });
  assert.deepStrictEqual(mixed.build(0).lines, ['a啊a啊a', '啊a啊']);
});

test('分页: 行数用尽时页停在行中间，下一页无缝衔接', () => {
  const pg = new Paginator('x'.repeat(26), []); // 单行 26 个半角 = 13 单位
  pg.setMetrics({ unitsPerLine: 4, maxLines: 3 }); // 每页 3 行 × 8 字符
  const p1 = pg.build(0);
  assert.deepStrictEqual(p1.lines, ['xxxxxxxx', 'xxxxxxxx', 'xxxxxxxx']);
  assert.strictEqual(p1.end, 24); // 停在“行”中间
  const p2 = pg.nextPage(0);
  assert.strictEqual(p2.start, 24);
  assert.deepStrictEqual(p2.lines, ['xx']);
  assert.strictEqual(p2.end, 26);
  assert.strictEqual(pg.nextPage(p2.start), null);
});

test('分页: 跳过空行且行尾去空格', () => {
  const pg = new Paginator('ab   \n下一行', []);
  pg.setMetrics({ unitsPerLine: 10, maxLines: 5 });
  assert.deepStrictEqual(pg.build(0).lines, ['ab', '下一行']);

  const gaps = new Paginator('A行内容\n\n\n\nB行内容', []);
  gaps.setMetrics({ unitsPerLine: 10, maxLines: 1 });
  const p1 = gaps.build(0);
  assert.deepStrictEqual(p1.lines, ['A行内容']);
  const p2 = gaps.nextPage(0);
  assert.deepStrictEqual(p2.lines, ['B行内容']);
  assert.strictEqual(p2.start, 8); // 跳过 4 个 \n
  assert.strictEqual(p2.end, 12);
  assert.strictEqual(gaps.nextPage(p2.start), null);
});

test('分页: 整本书平铺不丢字、不重叠、正确收尾', () => {
  const text = sampleBook(8, 30);
  const pg = new Paginator(text, detectChapters(text));
  pg.setMetrics({ unitsPerLine: 20, maxLines: 3 });

  const slices = [];
  let start = 0;
  let guard = 0;
  while (guard++ < 100000) {
    const p = pg.build(start);
    assert.ok(p.lines.length > 0, `位置 ${start} 排出了空页`);
    assert.ok(p.start >= start);
    assert.strictEqual(p.start, start, '无空行文本页界必须无缝衔接');
    slices.push(text.slice(p.start, p.end));
    const n = pg.nextPage(p.start);
    if (!n) break;
    assert.ok(n.start >= p.end, '页不得回退重叠');
    start = n.start;
  }
  const last = pg.build(start);
  assert.strictEqual(last.end, text.length, '最后一页必须吃到文末');
  assert.strictEqual(
    slices.join('').replace(/\n/g, ''),
    text.replace(/\n/g, ''),
    '所有页切片拼回必须等于全文'
  );
});

test('分页: pageAt 返回包含目标字符的页（含开头/末尾）', () => {
  const text = sampleBook(4, 20);
  const pg = new Paginator(text, detectChapters(text));
  pg.setMetrics({ unitsPerLine: 20, maxLines: 2 });
  for (const idx of [0, 1, 37, Math.floor(text.length / 2), text.length - 1]) {
    const p = pg.pageAt(idx);
    assert.ok(
      p.start <= idx && idx < p.end,
      `pageAt(${idx}) => [${p.start}, ${p.end}) 未包含目标`
    );
  }
});

test('分页: 更改度量后按字符位置对齐，且度量还原后页界完全复现', () => {
  const text = sampleBook(6, 25);
  const pg = new Paginator(text, detectChapters(text));
  pg.setMetrics({ unitsPerLine: 20, maxLines: 3 });
  const mid = pg.pageAt(500);
  const probe = Math.min(mid.start + 3, mid.end - 1); // 页内一个具体字符

  pg.setMetrics({ unitsPerLine: 34, maxLines: 5 });
  const after = pg.pageAt(probe);
  assert.ok(after.start <= probe && probe < after.end, '新度量下仍对齐到原字符所在页');

  pg.setMetrics({ unitsPerLine: 20, maxLines: 3 });
  const back = pg.pageAt(mid.start);
  assert.strictEqual(back.start, mid.start);
  assert.strictEqual(back.end, mid.end);
  assert.deepStrictEqual(back.lines, mid.lines);
});

test('分页: next/prev 往返一致（含缓存与无缓存两条路径）', () => {
  const text = sampleBook(5, 25);
  const chs = detectChapters(text);
  const pg = new Paginator(text, chs);
  pg.setMetrics({ unitsPerLine: 20, maxLines: 3 });

  const s = pg.pageAt(300).start;
  const n = pg.nextPage(s);
  assert.ok(n, '300 处应存在下一页');
  assert.strictEqual(pg.prevPage(n.start).start, s, '缓存路径往返一致');

  const fresh = new Paginator(text, chs); // 无 _prevStart 缓存，走跨页回溯
  fresh.setMetrics({ unitsPerLine: 20, maxLines: 3 });
  assert.strictEqual(fresh.prevPage(n.start).start, s, '无缓存路径往返一致');
});

test('章节: 标题/导航边界（含正文序言区）', () => {
  const text = `这是第一章之前的故事，没有标题。\n${sampleBook(3, 5)}`;
  const chs = detectChapters(text);
  assert.strictEqual(chs.length, 3);

  const pg = new Paginator(text, chs);
  assert.strictEqual(pg.chapterTitleFor(0), null); // 序言区无章节
  assert.strictEqual(pg.chapterOriginFor(0), 0);
  assert.strictEqual(pg.chapterTitleFor(chs[0].charIndex), '第1章 风起');
  assert.strictEqual(pg.nextChapterStart(0), chs[0].charIndex);

  const inCh1 = chs[0].charIndex + 10;
  assert.strictEqual(pg.nextChapterStart(inCh1), chs[1].charIndex);
  assert.strictEqual(pg.prevChapterStart(inCh1), chs[0].charIndex); // 章中 → 回章头
  assert.strictEqual(pg.prevChapterStart(chs[1].charIndex), chs[0].charIndex); // 章首 → 上一章
  assert.strictEqual(pg.nextChapterStart(chs[2].charIndex + 5), null); // 最后一章无下一章
});

test('章节: 无章节文本的导航退化为整本分页', () => {
  const text = '就是一段没有章节的普通长文本。\n'.repeat(50).trimEnd();
  const pg = new Paginator(text, detectChapters(text));
  assert.deepStrictEqual(pg.chapters, []);
  pg.setMetrics({ unitsPerLine: 20, maxLines: 2 });
  assert.strictEqual(pg.chapterTitleFor(10), null);
  assert.strictEqual(pg.nextChapterStart(10), null);
  assert.ok(pg.pageAt(10).lines.length > 0);
});
