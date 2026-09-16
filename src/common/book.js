'use strict';

/**
 * 纯文本书籍处理：编码解码、章节识别、确定性分页。
 * 不依赖 Electron，主进程与单元测试（node tests/）直接复用。
 *
 * 分页模型：
 *  - 全文在打开时解码并缓存，翻页不再触碰磁盘（原版每次翻页 readFileSync 整本书）。
 *  - 每页 = { start, end, lines[] }，页界从「章节起点」贪心推导，确定性可复现。
 *  - 进度以页起点字符位置（charIndex）记忆，改字号/宽度后仍能对齐回原位置。
 */

// ---------------------------------------------------------------------------
// 编码
// ---------------------------------------------------------------------------

function tryDecode(buf, label) {
  try {
    return new TextDecoder(label, { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

// GB18030 与 Big5 的字节流几乎总能互相“合法”地解码成乱码，try/catch 无法区分，
// 用常用汉字命中率打分择优：真实文本命中率 25%+，跨编码乱码约 1%。
const COMMON_HAN = new Set((
  '的一是了我不人在他有这上们来到时大地为子中你说生国年着就那和要她出也得里后自以' +
  '会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开' +
  '美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间' +
  '知世什两次使身者被高已亲其进此话常与活正感明白力问几等觉从' +
  '這裡說過來對沒後著與會國時間們東車馬鳥語書長門問開學體點誰讓' +
  '話麼為還發動電見覺經認實兒飛愛買賣讀萬個兩關環處寫無樣'
));

function commonHanRatio(text) {
  let total = 0;
  let hits = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    if ((cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)) {
      total++;
      if (COMMON_HAN.has(text[i])) hits++;
    }
  }
  return total ? hits / total : 0;
}

/**
 * 自动识别并解码：BOM(UTF-8/UTF-16) → UTF-8 → GB18030/Big5（双解码打分）→ UTF-8 宽松。
 * @param {Buffer} buf
 * @returns {{ text: string, encoding: string }}
 */
function decodeBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  }

  const utf8 = tryDecode(buf, 'utf-8');
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8' };

  const gb = tryDecode(buf, 'gb18030');
  const big5 = tryDecode(buf, 'big5');
  if (gb !== null && big5 !== null) {
    return commonHanRatio(big5) > commonHanRatio(gb)
      ? { text: big5, encoding: 'big5' }
      : { text: gb, encoding: 'gb18030' };
  }
  if (gb !== null) return { text: gb, encoding: 'gb18030' };
  if (big5 !== null) return { text: big5, encoding: 'big5' };

  return { text: new TextDecoder('utf-8').decode(buf), encoding: 'utf-8(lossy)' };
}

/** 归一化：统一换行符，去 BOM 残留，去文末空白（否则会产生空白尾页、丢失“（完）”标记）。 */
function normalizeText(text) {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t　\n\r]+$/, '');
}

// ---------------------------------------------------------------------------
// 章节识别
// ---------------------------------------------------------------------------

const CHAPTER_HEAD_RES = [
  /^第[0-9０-９零一二两三四五六七八九十百千万]+[章节回卷集部篇][　\s:：、.．\-—·]?/u,
  /^(序章|序言|楔子|引子|尾声|终章|后记|番外篇|番外)[　\s:：、.．\-—·]?/u,
  /^Chapter\s+\d+[　\s:：、.．\-—·]?/i,
];

/** 单行是否是章节标题行；返回净化标题或 null。 */
function matchChapterLine(line) {
  const t = line.trim();
  if (!t || t.length > 40) return null;
  for (const re of CHAPTER_HEAD_RES) {
    if (re.test(t)) {
      const title = t.replace(/[　\s]+/g, ' ').trim();
      return title.length <= 42 ? title : null;
    }
  }
  return null;
}

/**
 * 扫描全文章节。过滤开头的目录页（连续密集的标题行）。
 * @returns {Array<{title: string, charIndex: number}>} 少于 2 个视为无章节，返回 []
 */
function detectChapters(text) {
  const out = [];
  const total = text.length;
  let pos = 0;
  while (pos <= total && out.length < 5000) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? total : nl;
    if (lineEnd - pos <= 48) {
      const title = matchChapterLine(text.slice(pos, lineEnd));
      if (title) out.push({ title, charIndex: pos });
    }
    if (nl === -1) break;
    pos = nl + 1;
  }

  // 目录页剔除：开头一段连续紧邻(<80 字符)的标题行是目录而非正文。
  // 游走停在第一个大间距处；目录若紧贴正文第一章，切点恰落在第一章标题上——
  // 它与目录末行同属紧邻链，但它是真章节，因此只删到 cut（不含切点）。
  // 代价：目录与正文之间隔了大段前文时，目录末行会残留成一个幻影章节标题。
  let cut = 0;
  while (cut + 1 < out.length && out[cut + 1].charIndex - out[cut].charIndex < 80) cut++;
  if (cut >= 4) out.splice(0, cut);

  // 去除连续重复标题
  const deduped = out.filter((c, i) => i === 0 || c.title !== out[i - 1].title || c.charIndex - out[i - 1].charIndex > 80);

  return deduped.length >= 2 ? deduped : [];
}

// ---------------------------------------------------------------------------
// 宽度加权（全角 1 / 半角 0.5，单位 = 字号 px）
// ---------------------------------------------------------------------------

function isWideCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 谚文字母
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首与符号（。，、《》等）
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名 / 注音 / CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // 基本区
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)  // 扩展 B 及以后
  );
}

function rtrim(s) {
  return s.replace(/[ \t　]+$/, '');
}

/**
 * 从 from（<= lineEnd）沿一行前进，最多消耗 budget 个宽度单位，返回切割点。
 * 保证至少前进一个码点，避免极窄宽度下死循环。
 */
function wrapAdvance(text, from, lineEnd, budget) {
  let units = 0;
  let i = from;
  while (i < lineEnd) {
    const cp = text.codePointAt(i);
    const w = isWideCodePoint(cp) ? 1 : 0.5;
    if (units + w > budget) break;
    units += w;
    i += cp > 0xffff ? 2 : 1;
  }
  if (i === from && from < lineEnd) {
    i += text.codePointAt(from) > 0xffff ? 2 : 1;
  }
  return i;
}

// ---------------------------------------------------------------------------
// 分页器
// ---------------------------------------------------------------------------

class Paginator {
  /**
   * @param {string} text 已归一化的全文
   * @param {Array<{title,charIndex}>} chapters detectChapters 的结果（可空数组）
   */
  constructor(text, chapters = []) {
    this.text = text;
    this.chapters = chapters;
    this._metrics = null;
    /** 页起点 -> 上一页起点（确定性分页下可复用，避免每次向前整章回溯） */
    this._prevStart = new Map();
  }

  get length() {
    return this.text.length;
  }

  /**
   * 设置排版度量。度量变化会清空页界缓存（页界随之重排，进度仍按 charIndex 对齐）。
   * @param {{unitsPerLine:number, maxLines:number}} m
   */
  setMetrics(m) {
    const next = {
      unitsPerLine: Math.max(4, Math.floor(m.unitsPerLine)),
      maxLines: Math.max(1, Math.floor(m.maxLines)),
    };
    if (this._metrics &&
        next.unitsPerLine === this._metrics.unitsPerLine &&
        next.maxLines === this._metrics.maxLines) return;
    this._metrics = next;
    this._prevStart.clear();
  }

  /** 排版一页：从 start 开始（跳过前导空行），填满 maxLines 行。 */
  build(start) {
    const { text } = this;
    const len = text.length;
    const { unitsPerLine, maxLines } = this._metrics;
    if (!this._metrics) throw new Error('setMetrics() first');

    let i = start;
    while (i < len && text[i] === '\n') i++;
    const pageStart = i;
    if (i >= len) return { start: pageStart, end: len, lines: [] };

    const lines = [];
    while (lines.length < maxLines && i < len) {
      const nl = text.indexOf('\n', i);
      const lineEnd = nl === -1 ? len : nl;
      if (lineEnd > i) {
        let p = i;
        while (p < lineEnd && lines.length < maxLines) {
          const cut = wrapAdvance(text, p, lineEnd, unitsPerLine);
          lines.push(rtrim(text.slice(p, cut)));
          p = cut;
        }
        if (p < lineEnd) { // 行数用尽，停在本行中间
          i = p;
          break;
        }
        i = nl === -1 ? len : nl + 1;
      } else {
        i = nl + 1; // 空行：直接跳过（阅读条上不留白行）
      }
    }
    if (!lines.length) return { start: pageStart, end: len, lines: [] };
    return { start: pageStart, end: i, lines };
  }

  /** idx 落在第几个章节（-1 = 第一个章节之前）。 */
  chapterIndexFor(idx) {
    const cs = this.chapters;
    if (!cs.length) return -1;
    let lo = 0;
    let hi = cs.length - 1;
    let res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cs[mid].charIndex <= idx) {
        res = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return res;
  }

  chapterOriginFor(idx) {
    const c = this.chapterIndexFor(idx);
    return c === -1 ? 0 : this.chapters[c].charIndex;
  }

  chapterTitleFor(idx) {
    const c = this.chapterIndexFor(idx);
    return c === -1 ? null : this.chapters[c].title;
  }

  /** 下一章起点字符位置；无则 null。 */
  nextChapterStart(idx) {
    const c = this.chapterIndexFor(idx);
    if (c + 1 >= this.chapters.length) return null;
    return this.chapters[c + 1].charIndex;
  }

  /** 上一处章节起点：章中返回本章开头，章首返回上一章开头；无则 null。 */
  prevChapterStart(idx) {
    const c = this.chapterIndexFor(idx);
    if (c === -1) return null;
    const cs = this.chapters[c].charIndex;
    if (idx > cs) return cs;
    return c > 0 ? this.chapters[c - 1].charIndex : null;
  }

  /**
   * 包含 idx 的页（从 idx 所在章节的起点确定性推导，顺带填充回退缓存）。
   */
  pageAt(idx) {
    const len = this.text.length;
    if (len === 0) return { start: 0, end: 0, lines: [] };
    const clamped = Math.max(0, Math.min(idx, len - 1));
    let p = this.build(this.chapterOriginFor(clamped));
    while (p.end <= clamped && p.end < len) {
      this._prevStart.set(p.end, p.start);
      p = this.build(p.end);
    }
    this._prevStart.set(p.end, p.start);
    return p;
  }

  /** start 页的下一页；已是最后一页返回 null。 */
  nextPage(start) {
    const len = this.text.length;
    const cur = this.build(start);
    if (cur.end >= len) return null;
    const n = this.build(cur.end);
    this._prevStart.set(n.start, cur.start);
    return n;
  }

  /** start 页的上一页；到头返回 null。 */
  prevPage(start) {
    if (start <= 0) return null;
    const cached = this._prevStart.get(start);
    if (cached !== undefined) return this.build(cached);
    const p = this.pageBefore(start);
    return p || null;
  }

  /** end <= target 的最后一页（跨章回退用）。 */
  pageBefore(target) {
    const len = this.text.length;
    if (target <= 0) return null;
    const origin = this.chapterOriginFor(target - 1);
    let p = this.build(origin);
    let last = null;
    while (p.end <= target && p.end < len) {
      this._prevStart.set(p.end, p.start);
      last = p;
      p = this.build(p.end);
    }
    return last;
  }
}

module.exports = {
  decodeBuffer,
  normalizeText,
  detectChapters,
  matchChapterLine,
  isWideCodePoint,
  Paginator,
};
