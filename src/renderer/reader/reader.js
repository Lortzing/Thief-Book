'use strict';

/**
 * 阅读条渲染端:展示页面、滚轮/点击翻页、右键菜单、hover 显隐动画、手动拖拽把手。
 * 解码/分页在本地(session.mjs);文件读取/事件/窗口控制经 Tauri IPC(tauri.mjs)。
 */

import { invoke, listen } from '../../common/tauri.mjs';
import { Library } from '../../common/session.mjs';

(() => {
  const el = (id) => document.getElementById(id);
  const bar = el('bar');
  const chapterEl = el('chapter');
  const linesEl = el('lines');
  const progressEl = el('progress');
  const nameEl = el('bookname');
  const hairline = el('hairline');

  const LINE_HEIGHT_FACTOR = 1.55; // 与主进程一致
  const WHEEL_DEBOUNCE_MS = 180;

  let lastWheelAt = 0;
  let wheelPaging = true; // 由 doc:changed 携带,可在设置中关闭
  let dragging = false;
  let doc = null; // 整个 store 文档

  // 会话 backend:进度读写走 store 文档,文件字节走 Rust 命令
  const backend = {
    settings: null,
    getProgress: (p) => {
      const b = doc && doc.books ? doc.books[p] : null;
      return b ? { charIndex: b.charIndex } : null;
    },
    readBook: async (p) => {
      const buf = await invoke('read_book', { path: p });
      return new Uint8Array(buf);
    },
    saveProgress: (e) => {
      invoke('save_progress', {
        path: e.path,
        name: e.name,
        charIndex: e.charIndex,
        percent: e.percent,
      }).catch(() => {});
    },
  };
  const lib = new Library(backend);

  function applyAppearance(s) {
    if (!s) return;
    const root = document.documentElement.style;
    root.setProperty('--bg', s.bgColor);
    root.setProperty('--fg', s.fgColor);
    root.setProperty('--font-size', `${s.fontSize}px`);
    linesEl.style.lineHeight = `${Math.round(s.fontSize * LINE_HEIGHT_FACTOR)}px`;
    chapterEl.style.display = s.showChapter ? '' : 'none';
    el('footer').style.display = s.showProgress ? '' : 'none';
    wheelPaging = s.wheelPaging !== false;
  }

  function makeLine(text, cls) {
    const d = document.createElement('div');
    d.className = cls ? `line ${cls}` : 'line';
    d.textContent = text;
    return d;
  }

  function renderPage(p) {
    if (!p) return;
    linesEl.replaceChildren(
      ...(p.lines && p.lines.length ? p.lines.map((l) => makeLine(l)) : [makeLine('…', 'hint')])
    );
    chapterEl.textContent = p.chapterTitle || '';
    const pct = (p.percent * 100).toFixed(1);
    progressEl.textContent = p.isEnd ? `${pct}% · 完` : `${pct}%`;
    nameEl.textContent = p.bookName || '';
    hairline.style.width = `${(p.percent * 100).toFixed(2)}%`;
  }

  function renderHint(message) {
    linesEl.replaceChildren(
      makeLine(message || '右键打开 TXT · 把手或章节行拖动位置 · 滚轮 / 点击翻页', 'hint')
    );
    chapterEl.textContent = '';
    progressEl.textContent = '';
    nameEl.textContent = '未打开书籍';
    hairline.style.width = '0%';
  }

  function setVisible(v) {
    bar.classList.toggle('shown', !!v);
  }

  function pageCmd(dir) {
    const st =
      dir === 'next' ? lib.turn(1) :
      dir === 'prev' ? lib.turn(-1) :
      dir === 'nextCh' ? lib.chapter(1) :
      lib.chapter(-1);
    if (st) renderPage(st);
  }

  async function openPath(p) {
    try {
      const r = await lib.open(p);
      if (r.ok) renderPage(r.page);
      else renderHint(r.message);
    } catch (err) {
      renderHint((err && err.message) || '打开失败');
    }
  }

  // ---- 交互 ----

  // 手动拖拽:把手/章节行 mousedown 通知主进程跟随光标,mouseup 任意处结束。
  for (const handle of [el('grip'), chapterEl]) {
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      invoke('drag_begin').catch(() => {});
    });
  }
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    invoke('drag_end').catch(() => {});
  });

  el('content').addEventListener('click', (e) => {
    if (e.target.closest('#chapter')) return; // 章节行是拖拽把手,不翻页
    pageCmd('next'); // 左键下一页(无书时无害)
  });

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (dragging) {
      dragging = false;
      invoke('drag_end').catch(() => {});
    }
    invoke('popup_menu').catch(() => {});
  });

  document.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (!wheelPaging) return;
      const now = Date.now();
      if (now - lastWheelAt < WHEEL_DEBOUNCE_MS) return;
      if (e.deltaY > 1.5) {
        lastWheelAt = now;
        pageCmd('next');
      } else if (e.deltaY < -1.5) {
        lastWheelAt = now;
        pageCmd('prev');
      }
    },
    { passive: false }
  );

  // 老板键隐藏/窗口不可见时,尽快把防抖中的进度落盘
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) lib.flushSave();
  });
  window.addEventListener('beforeunload', () => lib.flushSave());

  // ---- 订阅 ----

  listen('reader:visible', (v) => setVisible(v));
  listen('reader:page', (dir) => pageCmd(dir));
  listen('reader:open', ({ path }) => openPath(path));
  listen('reader:jump', ({ percent }) => {
    const st = lib.jumpPercent(percent);
    if (st) renderPage(st);
  });
  listen('doc:changed', (newDoc) => {
    if (!newDoc || !newDoc.settings) return;
    doc = newDoc;
    backend.settings = doc.settings;
    applyAppearance(doc.settings);
    const st = lib.reapplyMetrics();
    if (st) renderPage(st);
    else if (!lib.hasBook) renderHint();
  });

  // ---- 初始化 ----

  (async () => {
    try {
      doc = await invoke('get_doc');
      const ready = await invoke('reader_ready');
      backend.settings = doc.settings;
      applyAppearance(doc.settings);
      setVisible(ready.visible);
      if (doc.settings.resumeOnStart && doc.lastBookPath) {
        await openPath(doc.lastBookPath);
      }
      if (!lib.hasBook) renderHint();
    } catch (err) {
      console.error('[reader] 初始化失败:', err);
      renderHint('初始化失败:' + (err && err.message ? err.message : err));
    }
  })();
})();
