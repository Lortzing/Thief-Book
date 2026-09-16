'use strict';

/**
 * 当前书籍会话：打开/翻页/章节跳转/进度保存。
 * 全文常驻内存，翻页零磁盘 IO；进度以页起点 charIndex 防抖落盘。
 */

const fs = require('fs');
const path = require('path');
const { decodeBuffer, normalizeText, detectChapters, Paginator } = require('../common/book');

// 与渲染端 reader.css 保持一致的度量常量
const METRICS = {
  gripW: 22,
  padLeft: 6,
  padRight: 14,
};

const PROGRESS_SAVE_DELAY = 500;

class Library {
  /** @param {import('../common/store').Store} store */
  constructor(store) {
    this.store = store;
    /** @type {{path,name,text,chapters,paginator,charIndex,page}|null} */
    this.book = null;
    this._saveTimer = null;
  }

  get hasBook() {
    return !!this.book;
  }

  /** 由当前设置推导排版度量。 */
  metrics() {
    const s = this.store.settings;
    const usable = s.width - METRICS.gripW - METRICS.padLeft - METRICS.padRight;
    return {
      unitsPerLine: Math.max(8, Math.floor(usable / s.fontSize)),
      maxLines: s.lines,
    };
  }

  /**
   * 打开书籍；有历史进度则恢复并对齐到新页界。
   * @returns {{ok: boolean, message?: string, page?: object}}
   */
  open(filePath) {
    let buf;
    try {
      buf = fs.readFileSync(filePath);
    } catch {
      return { ok: false, message: `无法读取文件：${filePath}` };
    }
    if (buf.length > 64 * 1024 * 1024) {
      return { ok: false, message: '文件超过 64MB，不支持' };
    }

    const { text: decoded } = decodeBuffer(buf);
    const text = normalizeText(decoded);
    if (!text.trim()) {
      return { ok: false, message: '文件内容为空' };
    }

    const name = path.basename(filePath).replace(/\.txt$/i, '');
    const paginator = new Paginator(text, detectChapters(text));

    this.flushSave();
    this.book = { path: filePath, name, text, paginator, charIndex: 0, page: null };
    paginator.setMetrics(this.metrics());

    const prog = this.store.bookProgress(filePath);
    const startIdx = prog ? Math.min(prog.charIndex, Math.max(0, text.length - 1)) : 0;
    const page = paginator.pageAt(startIdx);
    this.book.charIndex = page.start;
    this.book.page = page;
    this._scheduleSave();
    return { ok: true, page: this.pageState() };
  }

  /** 设置变化后重新度量并对齐当前位置。 */
  reapplyMetrics() {
    if (!this.book) return null;
    this.book.paginator.setMetrics(this.metrics());
    const page = this.book.paginator.pageAt(this.book.charIndex);
    this.book.charIndex = page.start;
    this.book.page = page;
    this._scheduleSave();
    return this.pageState();
  }

  /** 翻页 dir=1 下一页 / -1 上一页。返回新页状态（到头返回当前页）。 */
  turn(dir) {
    if (!this.book) return null;
    const pg = this.book.paginator;
    const page = dir > 0 ? pg.nextPage(this.book.charIndex) : pg.prevPage(this.book.charIndex);
    if (!page) return this.pageState();
    this.book.charIndex = page.start;
    this.book.page = page;
    this._scheduleSave();
    return this.pageState();
  }

  /** 章节跳转 dir=1 下一章 / -1 上一章（章中按一次先回章头）。 */
  chapter(dir) {
    if (!this.book) return null;
    const pg = this.book.paginator;
    const target = dir > 0 ? pg.nextChapterStart(this.book.charIndex) : pg.prevChapterStart(this.book.charIndex);
    if (target === null) return this.pageState();
    const page = pg.pageAt(target);
    this.book.charIndex = page.start;
    this.book.page = page;
    this._scheduleSave();
    return this.pageState();
  }

  /** 按百分比跳转（0-100）。 */
  jumpPercent(pct) {
    if (!this.book) return null;
    const n = Math.min(100, Math.max(0, Number(pct) || 0));
    const idx = Math.floor((this.book.text.length * n) / 100);
    const page = this.book.paginator.pageAt(idx);
    this.book.charIndex = page.start;
    this.book.page = page;
    this._scheduleSave();
    return this.pageState();
  }

  /** 当前页的渲染状态。 */
  pageState() {
    if (!this.book) return null;
    const b = this.book;
    const len = b.text.length;
    const page = b.page || b.paginator.build(b.charIndex);
    const isEnd = page.end >= len;
    const lines = [...page.lines];
    if (isEnd && lines.length) {
      lines[lines.length - 1] = `${lines[lines.length - 1]}　（完）`;
    }
    return {
      lines,
      chapterTitle: b.paginator.chapterTitleFor(b.charIndex),
      percent: len ? b.charIndex / len : 0,
      bookName: b.name,
      hasPrev: b.charIndex > 0,
      hasNext: !isEnd,
      isEnd,
    };
  }

  /** 渲染端外观子集。 */
  appearance() {
    const s = this.store.settings;
    return {
      fontSize: s.fontSize,
      lines: s.lines,
      width: s.width,
      theme: s.theme,
      bgColor: s.bgColor,
      fgColor: s.fgColor,
      showChapter: s.showChapter,
      showProgress: s.showProgress,
      hoverMode: s.hoverMode,
      wheelPaging: s.wheelPaging,
    };
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flushSave(), PROGRESS_SAVE_DELAY);
  }

  flushSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this.book) return;
    const b = this.book;
    this.store.saveProgress({
      path: b.path,
      name: b.name,
      charIndex: b.charIndex,
      percent: b.text.length ? b.charIndex / b.text.length : 0,
    });
  }
}

module.exports = { Library, METRICS };
