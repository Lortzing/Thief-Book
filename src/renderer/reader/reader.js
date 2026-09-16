'use strict';

/**
 * 阅读条渲染端：展示页面、滚轮/点击翻页、右键菜单、hover 显隐动画。
 * 键盘翻页不走这里（窗口 focusable:false），由主进程全局快捷键接管。
 */

(() => {
  const el = (id) => document.getElementById(id);
  const bar = el('bar');
  const chapterEl = el('chapter');
  const linesEl = el('lines');
  const progressEl = el('progress');
  const nameEl = el('bookname');
  const hairline = el('hairline');
  const api = window.reader;

  const LINE_HEIGHT_FACTOR = 1.55; // 与主进程一致
  const WHEEL_DEBOUNCE_MS = 180;

  let lastWheelAt = 0;

  function applyAppearance(a) {
    if (!a) return;
    const root = document.documentElement.style;
    root.setProperty('--bg', a.bgColor);
    root.setProperty('--fg', a.fgColor);
    root.setProperty('--font-size', `${a.fontSize}px`);
    linesEl.style.lineHeight = `${Math.round(a.fontSize * LINE_HEIGHT_FACTOR)}px`;
    chapterEl.style.display = a.showChapter ? '' : 'none';
    el('footer').style.display = a.showProgress ? '' : 'none';
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

  function renderHint() {
    linesEl.replaceChildren(makeLine('右键打开 TXT · 把手或章节行拖动位置 · 滚轮 / 点击翻页', 'hint'));
    chapterEl.textContent = '';
    progressEl.textContent = '';
    nameEl.textContent = '未打开书籍';
    hairline.style.width = '0%';
  }

  function setVisible(v) {
    bar.classList.toggle('shown', !!v);
  }

  // ---- 交互 ----

  // 手动拖拽：把手/章节行 mousedown 通知主进程跟随光标（focusable:false 下
  // -webkit-app-region 拖拽不可靠），mouseup 任意处结束。
  let dragging = false;
  for (const handle of [el('grip'), chapterEl]) {
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      api.beginDrag();
    });
  }
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    api.endDrag();
  });

  el('content').addEventListener('click', (e) => {
    if (e.target.closest('#chapter')) return; // 章节行是拖拽把手，不翻页
    api.next(); // 左键下一页（无书时无害）
  });

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (dragging) {
      dragging = false;
      api.endDrag();
    }
    api.popupMenu(Math.round(e.screenX), Math.round(e.screenY));
  });

  document.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheelAt < WHEEL_DEBOUNCE_MS) return;
      if (e.deltaY > 1.5) {
        lastWheelAt = now;
        api.next();
      } else if (e.deltaY < -1.5) {
        lastWheelAt = now;
        api.prev();
      }
    },
    { passive: false }
  );

  // ---- 订阅 ----

  api.onPage(renderPage);
  api.onVisible(setVisible);
  api.onAppearance(applyAppearance);

  (async () => {
    const st = await api.ready();
    if (!st) return;
    applyAppearance(st.appearance);
    setVisible(st.visible);
    if (st.hasBook && st.page) renderPage(st.page);
    else renderHint();
  })().catch((err) => console.error('[reader] init failed:', err));
})();
