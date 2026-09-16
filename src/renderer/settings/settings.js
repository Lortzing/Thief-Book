'use strict';

/**
 * 设置窗口渲染端：键位录制、外观/行为即时生效、最近书单。
 * 只通过 preload 暴露的 window.settings 与主进程通信。
 */

(() => {
  const api = window.settings;

  // src/common/store.js 的 RANGES / sanitizeColor 镜像（渲染端不走 CommonJS）
  const RANGES = {
    fontSize: [9, 40],
    lines: [1, 6],
    width: [280, 1600],
    hideDelayMs: [50, 3000],
  };
  const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\(.+\))$/;

  const THEME_PRESETS = {
    dark: { bgColor: 'rgba(24, 26, 32, 0.78)', fgColor: '#e8e6e3' },
    light: { bgColor: 'rgba(255, 255, 255, 0.8)', fgColor: '#1d1d1f' },
  };

  // setKeys 字段名 → settings 键名（数组顺序即界面行序）
  const KEY_ROWS = [
    { field: 'next', settingKey: 'nextPageKey' },
    { field: 'prev', settingKey: 'prevPageKey' },
    { field: 'nextCh', settingKey: 'nextChapterKey' },
    { field: 'prevCh', settingKey: 'prevChapterKey' },
    { field: 'boss', settingKey: 'bossKey' },
  ];

  // 只按修饰符不结束录制；其余按键一律转 accelerator
  const MODIFIER_KEYS = new Set([
    'Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'OS', 'Dead', 'Unidentified',
  ]);
  const KEY_ALIASES = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  };

  const el = (id) => document.getElementById(id);

  let settings = {};
  let keys = { next: '', prev: '', nextCh: '', prevCh: '', boss: '' };
  let recording = null;    // 正在录制的 field
  let currentPath = null;  // 当前打开的书（高亮用）
  let lastBooks = [];

  // ---------------------------------------------------------------------------
  // 键位
  // ---------------------------------------------------------------------------

  const keyEls = {};
  for (const row of document.querySelectorAll('.key-row')) {
    const field = row.dataset.field;
    keyEls[field] = {
      btn: row.querySelector('.keycap'),
      err: row.querySelector('.err'),
    };
    keyEls[field].btn.addEventListener('click', () => {
      if (recording === field) cancelRecording();
      else startRecording(field);
    });
  }

  function startRecording(field) {
    cancelRecording();
    recording = field;
    keysStatus('');
    keyEls[field].btn.classList.add('rec');
    keyEls[field].btn.textContent = '按下按键…';
    keyEls[field].err.textContent = '';
  }

  function cancelRecording() {
    if (!recording) return;
    keyEls[recording].btn.classList.remove('rec');
    keyEls[recording].btn.textContent = keys[recording];
    recording = null;
  }

  /** keydown → Electron accelerator；纯修饰符返回 null。 */
  function accelFromEvent(e) {
    if (MODIFIER_KEYS.has(e.key)) return null;
    let main = KEY_ALIASES[e.key] || e.key;
    if (main.length === 1) main = main.toLowerCase();
    const parts = [];
    if (e.metaKey || e.ctrlKey) parts.push('CmdOrCtrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    parts.push(main);
    return parts.join('+');
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        cancelRecording();
        return;
      }
      if (e.isComposing) return;
      const accel = accelFromEvent(e);
      if (!accel) return;
      const field = recording;
      recording = null;
      keys[field] = accel;
      keyEls[field].btn.classList.remove('rec');
      keyEls[field].btn.textContent = accel;
      probeKey(field, accel);
    },
    true
  );

  // 点击录制按钮以外任意处，结束录制
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!recording) return;
      if (e.target !== keyEls[recording].btn) cancelRecording();
    },
    true
  );

  async function probeKey(field, accel) {
    let r = null;
    try {
      r = await api.probeKey(accel);
    } catch {
      return;
    }
    if (keys[field] !== accel) return; // 录制值已被再次修改
    keyEls[field].err.textContent = r && !r.ok ? `冲突：${r.reason || '不可用'}` : '';
  }

  function keysStatus(msg, isErr) {
    const s = el('keys-status');
    s.textContent = msg || '';
    s.classList.toggle('err', !!isErr);
  }

  el('save-keys').addEventListener('click', async () => {
    cancelRecording();
    keysStatus('');
    for (const k of Object.values(keyEls)) k.err.textContent = '';
    let r = null;
    try {
      r = await api.setKeys({ ...keys });
    } catch {
      /* 落到下方失败分支 */
    }
    if (r && r.ok) {
      keysStatus(r.bossConflict ? '已保存，但老板键仍被占用' : '已保存');
      return;
    }
    const errors = (r && r.errors) || {};
    let shown = 0;
    for (const row of KEY_ROWS) {
      const msg = errors[row.field];
      if (msg) {
        keyEls[row.field].err.textContent = msg;
        shown += 1;
      }
    }
    if (!shown) keysStatus('保存失败', true);
  });

  // ---------------------------------------------------------------------------
  // 外观 / 行为
  // ---------------------------------------------------------------------------

  function bindNumber(id, key) {
    const input = el(id);
    input.value = settings[key];
    input.addEventListener('change', () => {
      const [lo, hi] = RANGES[key];
      let n = Math.round(Number(input.value));
      if (!Number.isFinite(n)) n = settings[key];
      n = Math.min(hi, Math.max(lo, n));
      input.value = n;
      if (n === settings[key]) return;
      settings[key] = n;
      api.set(key, n).catch(() => {});
    });
  }

  function bindCheck(id, key) {
    const input = el(id);
    input.checked = !!settings[key];
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      api.set(key, input.checked).catch(() => {});
    });
  }

  function updateSwatch() {
    const sw = el('color-swatch');
    sw.style.background = settings.bgColor;
    sw.style.color = settings.fgColor;
  }

  function setThemeUI() {
    for (const b of el('theme-seg').querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.theme === settings.theme);
    }
    const custom = settings.theme === 'custom';
    el('bg-color-row').hidden = !custom;
    el('fg-color-row').hidden = !custom;
    el('bg-color').value = settings.bgColor;
    el('fg-color').value = settings.fgColor;
    updateSwatch();
  }

  el('theme-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-theme]');
    if (!btn) return;
    const theme = btn.dataset.theme;
    settings.theme = theme;
    api.set('theme', theme).catch(() => {});
    const preset = THEME_PRESETS[theme];
    if (preset) {
      settings.bgColor = preset.bgColor;
      settings.fgColor = preset.fgColor;
      api.set('bgColor', preset.bgColor).catch(() => {});
      api.set('fgColor', preset.fgColor).catch(() => {});
    }
    setThemeUI();
  });

  function bindColor(id, key) {
    const input = el(id);
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (!COLOR_RE.test(v)) {
        el('color-err').textContent = '无效颜色，支持 #hex 或 rgb()/rgba()';
        input.value = settings[key];
        return;
      }
      el('color-err').textContent = '';
      settings[key] = v;
      api.set(key, v).catch(() => {});
      updateSwatch();
    });
  }

  // ---------------------------------------------------------------------------
  // 书单
  // ---------------------------------------------------------------------------

  function bookStatus(msg, isErr) {
    const s = el('book-status');
    s.textContent = msg || '';
    s.classList.toggle('err', !!isErr);
  }

  function fmtTime(ts) {
    if (!Number.isFinite(ts)) return '';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function opBtn(text, op) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.dataset.op = op;
    if (op === 'remove') b.className = 'remove';
    return b;
  }

  function bookRow(b) {
    const current = b.path === currentPath;
    const row = document.createElement('div');
    row.className = 'book-row' + (current ? ' current' : '');
    row.dataset.path = b.path;

    const main = document.createElement('div');
    main.className = 'book-main';
    const name = document.createElement('span');
    name.className = 'book-name';
    name.textContent = b.name || b.path;
    name.title = b.path;
    main.appendChild(name);
    if (current) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '阅读中';
      main.appendChild(badge);
    }

    const pct = Math.round((b.percent || 0) * 100);
    const sub = document.createElement('div');
    sub.className = 'book-sub';
    const pctEl = document.createElement('span');
    pctEl.className = 'book-pct';
    pctEl.textContent = `${pct}%`;
    const timeEl = document.createElement('span');
    timeEl.className = 'book-time';
    timeEl.textContent = fmtTime(b.updatedAt);

    const ops = document.createElement('span');
    ops.className = 'book-ops';
    const jumpInput = document.createElement('input');
    jumpInput.type = 'number';
    jumpInput.min = '0';
    jumpInput.max = '100';
    jumpInput.value = String(pct);
    ops.append(opBtn('打开', 'open'), jumpInput, opBtn('跳转', 'jump'), opBtn('移除', 'remove'));

    sub.append(pctEl, timeEl, ops);
    row.append(main, sub);
    return row;
  }

  function renderBooks(books) {
    lastBooks = Array.isArray(books) ? books : [];
    el('book-list').replaceChildren(...lastBooks.map(bookRow));
    el('book-empty').hidden = lastBooks.length > 0;
  }

  async function openBookAt(p) {
    const prev = currentPath;
    currentPath = p; // 先行高亮：push:books 可能先于本次 invoke 返回
    bookStatus('');
    let r = null;
    try {
      r = await api.openBook(p);
    } catch {
      /* 落到失败分支 */
    }
    if (r && r.opened) return;
    if (currentPath === p) {
      currentPath = prev;
      renderBooks(lastBooks); // 打开失败：还原高亮
    }
    bookStatus((r && r.message) || '打开失败', true);
  }

  function jumpRow(rowEl, p) {
    const input = rowEl.querySelector('.book-ops input');
    let n = Math.round(Number(input.value));
    if (!Number.isFinite(n)) return;
    n = Math.min(100, Math.max(0, n));
    input.value = n;
    api
      .jump(n)
      .then((r) => {
        if (!r || !r.ok) {
          bookStatus('跳转失败', true);
          return;
        }
        // jump 不触发 push:books，本地即时反馈百分比
        const pctEl = rowEl.querySelector('.book-pct');
        if (pctEl) pctEl.textContent = `${n}%`;
        const entry = lastBooks.find((b) => b.path === p);
        if (entry) entry.percent = n / 100;
      })
      .catch(() => {});
  }

  el('book-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-op]');
    if (!btn) return;
    const rowEl = btn.closest('.book-row');
    if (!rowEl) return;
    const p = rowEl.dataset.path;
    if (btn.dataset.op === 'open') openBookAt(p);
    else if (btn.dataset.op === 'jump') jumpRow(rowEl, p);
    else if (btn.dataset.op === 'remove') api.forgetBook(p).catch(() => {});
  });

  // 在百分比输入框里回车 = 跳转
  el('book-list').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    const rowEl = e.target.closest('.book-row');
    if (rowEl) jumpRow(rowEl, rowEl.dataset.path);
  });

  el('open-book').addEventListener('click', async () => {
    let picked = null;
    try {
      picked = await api.pickBook();
    } catch {
      return;
    }
    if (picked && picked.path) openBookAt(picked.path);
  });

  api.onBooks((books) => renderBooks(books));

  // ---------------------------------------------------------------------------
  // 初始化
  // ---------------------------------------------------------------------------

  (async () => {
    let st = null;
    try {
      st = await api.getState();
    } catch (err) {
      console.error('[settings] 读取状态失败:', err);
      return;
    }
    if (!st || !st.settings) return;
    settings = st.settings;
    currentPath = st.currentBook ? st.currentBook.path : null;

    for (const row of KEY_ROWS) {
      keys[row.field] = settings[row.settingKey] || '';
      keyEls[row.field].btn.textContent = keys[row.field];
    }

    bindNumber('font-size', 'fontSize');
    bindNumber('lines', 'lines');
    bindNumber('width', 'width');
    bindNumber('hide-delay', 'hideDelayMs');
    bindCheck('show-chapter', 'showChapter');
    bindCheck('show-progress', 'showProgress');
    bindCheck('hover-mode', 'hoverMode');
    bindCheck('resume-on-start', 'resumeOnStart');
    bindColor('bg-color', 'bgColor');
    bindColor('fg-color', 'fgColor');
    setThemeUI();

    renderBooks(st.books || []);
  })();
})();
