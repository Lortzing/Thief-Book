'use strict';

/**
 * 书籍会话:打开/翻页/章节/进度(逻辑与 Electron 版 library.js 一致)。
 * IO 通过注入的 backend(阅读条传入 Tauri invoke 实现,单测传 fake)。
 */

import { decodeBuffer, normalizeText, detectChapters, Paginator } from './book.mjs';

// 与 renderer/reader/reader.css 保持一致的度量常量
const METRICS = {
  gripW: 22,
  padLeft: 6,
  padRight: 14,
};

const PROGRESS_SAVE_DELAY = 500;

export class Library {
  /**
   * @param {{ settings: object,
   *           getProgress: (path: string) => {charIndex: number}|null,
   *           readBook: (path: string) => Promise<Uint8Array>,
   *           saveProgress: (e: {path,name,charIndex,percent}) => void }} backend
   */
  constructor(backend) {
    this.backend = backend;
    /** @type {{path,name,text,chapters,paginator,charIndex,page}|null} */
    this.book = null;
    this._saveTimer = null;
  }

  get hasBook() {
    return !!this.book;
  }

  get currentPath() {
    return this.book ? this.book.path : null;
  }

  /** 由当前设置推导排版度量。 */
  metrics() {
    const s = this.backend.settings;
    const usable = s.width - METRICS.gripW - METRICS.padLeft - METRICS.padRight;
    return {
      unitsPerLine: Math.max(8, Math.floor(usable / s.fontSize)),
      maxLines: s.lines,
    };
  }

  /**
   * 打开书籍;有历史进度则恢复并对齐到新页界。
   * @returns {Promise<{ok: boolean, message?: string, page?: object}>}
   */
  async open(filePath) {
    let bytes;
    try {
      bytes = await this.backend.readBook(filePath);
    } catch (err) {
      return { ok: false, message: (err && err.message) || `无法读取文件:${filePath}` };
    }
    if (!bytes || !bytes.length) {
      return { ok: false, message: '文件内容为空' };
    }

    const { text: decoded } = decodeBuffer(bytes);
    const text = normalizeText(decoded);
    if (!text.trim()) {
      return { ok: false, message: '文件内容为空' };
    }

    const name = filePath.split('/').pop().replace(/\.txt$/i, '');
    const paginator = new Paginator(text, detectChapters(text));

    this.flushSave();
    this.book = { path: filePath, name, text, paginator, charIndex: 0, page: null };
    paginator.setMetrics(this.metrics());

    const prog = this.backend.getProgress(filePath);
    const startIdx = prog
      ? Math.min(prog.charIndex, Math.max(0, text.length - 1))
      : 0;
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

  /** 翻页 dir=1 下一页 / -1 上一页。返回新页状态(到头返回当前页)。 */
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

  /** 章节跳转 dir=1 下一章 / -1 上一章(章中按一次先回章头)。 */
  chapter(dir) {
    if (!this.book) return null;
    const pg = this.book.paginator;
    const target =
      dir > 0
        ? pg.nextChapterStart(this.book.charIndex)
        : pg.prevChapterStart(this.book.charIndex);
    if (target === null) return this.pageState();
    const page = pg.pageAt(target);
    this.book.charIndex = page.start;
    this.book.page = page;
    this._scheduleSave();
    return this.pageState();
  }

  /** 按百分比跳转(0-100)。 */
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
    this.backend.saveProgress({
      path: b.path,
      name: b.name,
      charIndex: b.charIndex,
      percent: b.text.length ? b.charIndex / b.text.length : 0,
    });
  }
}
