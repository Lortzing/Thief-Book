'use strict';

/**
 * 设置与阅读进度持久化。
 * - 单文件 JSON：userData/reader-store.json
 * - 防抖 + 原子写（tmp + rename），损坏时自动备份重建（原版 db 损坏直接崩溃）
 * - 不依赖任何第三方库
 */

const fs = require('fs');
const path = require('path');

const STORE_VERSION = 3;

const DEFAULT_SETTINGS = {
  bossKey: 'CommandOrControl+Shift+B',
  nextPageKey: 'j',
  prevPageKey: 'k',
  nextChapterKey: 'l',
  prevChapterKey: 'h',
  hoverMode: true,
  wheelPaging: true,
  hideDelayMs: 300,
  fontSize: 15,
  lines: 2,
  width: 620,
  theme: 'light', // 'light' | 'dark' | 'custom'
  bgColor: 'rgba(255, 255, 255, 0.8)',
  fgColor: '#1d1d1f',
  showChapter: true,
  showProgress: true,
  resumeOnStart: true,
};

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

// 数值型设置的安全范围
const RANGES = {
  hideDelayMs: [50, 3000],
  fontSize: [9, 40],
  lines: [1, 6],
  width: [280, 1600],
};

function clamp(key, value) {
  const r = RANGES[key];
  if (!r) return value;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS[key];
  return Math.min(r[1], Math.max(r[0], n));
}

function sanitizeColor(value, fallback) {
  if (typeof value === 'string' && /^(#[0-9a-fA-F]{3,8}|rgba?\(.+\))$/.test(value.trim())) {
    return value.trim();
  }
  return fallback;
}

function fresh() {
  return {
    version: STORE_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    books: {}, // absPath -> {path,name,charIndex,percent,updatedAt,addedAt}
    lastBookPath: null,
    windowRect: null, // {x,y,width,height}
  };
}

function migrate(raw) {
  const data = fresh();
  if (!raw || typeof raw !== 'object') return data;
  data.lastBookPath = typeof raw.lastBookPath === 'string' ? raw.lastBookPath : null;
  if (raw.windowRect &&
      Number.isFinite(raw.windowRect.x) && Number.isFinite(raw.windowRect.y) &&
      Number.isFinite(raw.windowRect.width) && Number.isFinite(raw.windowRect.height)) {
    data.windowRect = raw.windowRect;
  }
  if (raw.settings && typeof raw.settings === 'object') {
    for (const k of SETTING_KEYS) {
      if (raw.settings[k] === undefined) continue;
      let v = raw.settings[k];
      if (k in RANGES) v = clamp(k, v);
      else if (k === 'theme') v = ['dark', 'light', 'custom'].includes(v) ? v : DEFAULT_SETTINGS.theme;
      else if (k === 'bgColor') v = sanitizeColor(v, DEFAULT_SETTINGS.bgColor);
      else if (k === 'fgColor') v = sanitizeColor(v, DEFAULT_SETTINGS.fgColor);
      else if (k === 'bossKey' || k === 'nextPageKey' || k === 'prevPageKey' ||
               k === 'nextChapterKey' || k === 'prevChapterKey') {
        if (typeof v !== 'string' || !v.trim()) v = DEFAULT_SETTINGS[k];
      }
      else if (typeof v === 'boolean') { /* hoverMode / showChapter / showProgress / resumeOnStart */ }
      else v = DEFAULT_SETTINGS[k];
      data.settings[k] = v;
    }
  }
  if (raw.books && typeof raw.books === 'object') {
    for (const [p, b] of Object.entries(raw.books)) {
      if (!b || typeof b !== 'object' || typeof b.path !== 'string') continue;
      data.books[p] = {
        path: b.path,
        name: typeof b.name === 'string' ? b.name : path.basename(b.path),
        charIndex: Number.isFinite(b.charIndex) ? Math.max(0, Math.floor(b.charIndex)) : 0,
        percent: Number.isFinite(b.percent) ? Math.min(1, Math.max(0, b.percent)) : 0,
        updatedAt: Number.isFinite(b.updatedAt) ? b.updatedAt : Date.now(),
        addedAt: Number.isFinite(b.addedAt) ? b.addedAt : Date.now(),
      };
    }
  }

  // v2 → v3: 默认主题从深色改为透明白。
  // 迁移范围：v2 内置深色默认值；以及 alpha=0 的全透明背景（悬停隐藏 bug 存在期间的
  // 典型规避手段——修好后没有保留价值）。用户自定义的颜色不受影响。
  if (!raw.version || raw.version < 3) {
    const s = data.settings;
    const oldDarkDefault =
      s.theme === 'dark' && s.bgColor === 'rgba(24, 26, 32, 0.78)' && s.fgColor === '#e8e6e3';
    const invisibleBg = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)$/.test(s.bgColor);
    if (oldDarkDefault || invisibleBg) {
      s.theme = DEFAULT_SETTINGS.theme;
      s.bgColor = DEFAULT_SETTINGS.bgColor;
      s.fgColor = DEFAULT_SETTINGS.fgColor;
    }
  }
  return data;
}

/**
 * @param {string} userDataDir Electron app.getPath('userData')
 */
function createStore(userDataDir) {
  const file = path.join(userDataDir, 'reader-store.json');
  let data = load();
  let dirty = false;
  let timer = null;

  function load() {
    try {
      return migrate(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        // 损坏：备份后重建，绝不崩溃
        try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
      return fresh();
    }
  }

  function schedule() {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => persistNow(), 300);
  }

  function persistNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return;
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      dirty = false;
    } catch (err) {
      // 写失败（磁盘满/权限）：保留脏标记，下次再试
      console.error('[store] persist failed:', err && err.message);
    }
  }

  return {
    persistNow,

    get settings() {
      return { ...data.settings };
    },

    getSetting(key) {
      return data.settings[key];
    },

    setSetting(key, value) {
      if (!SETTING_KEYS.includes(key)) return { ok: false, error: 'unknown key' };
      let v = value;
      if (key in RANGES) v = clamp(key, value);
      else if (key === 'theme') v = ['dark', 'light', 'custom'].includes(value) ? value : DEFAULT_SETTINGS.theme;
      else if (key === 'bgColor') v = sanitizeColor(value, data.settings.bgColor);
      else if (key === 'fgColor') v = sanitizeColor(value, data.settings.fgColor);
      else if (typeof value === 'boolean') v = value;
      else if (typeof value === 'string' && value.trim()) v = value.trim();
      else return { ok: false, error: 'invalid value' };
      data.settings[key] = v;
      schedule();
      return { ok: true };
    },

    get windowRect() {
      return data.windowRect ? { ...data.windowRect } : null;
    },

    setWindowRect(rect) {
      if (!rect ||
          !Number.isFinite(rect.x) || !Number.isFinite(rect.y) ||
          !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;
      data.windowRect = { ...rect };
      schedule();
    },

    get lastBookPath() {
      return data.lastBookPath;
    },

    bookProgress(p) {
      const b = data.books[p];
      return b ? { ...b } : null;
    },

    saveProgress(entry) {
      const prev = data.books[entry.path];
      data.books[entry.path] = {
        path: entry.path,
        name: entry.name || prev && prev.name || path.basename(entry.path),
        charIndex: Math.max(0, Math.floor(entry.charIndex) || 0),
        percent: Math.min(1, Math.max(0, Number(entry.percent) || 0)),
        updatedAt: Date.now(),
        addedAt: prev ? prev.addedAt : Date.now(),
      };
      data.lastBookPath = entry.path;
      schedule();
    },

    removeBook(p) {
      delete data.books[p];
      if (data.lastBookPath === p) {
        const latest = this.listBooks()[0];
        data.lastBookPath = latest ? latest.path : null;
      }
      schedule();
    },

    /** 最近书单，按 updatedAt 倒序。 */
    listBooks() {
      return Object.values(data.books)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((b) => ({ ...b }));
    },

    /** 给设置窗口的完整快照。 */
    toJSON() {
      return JSON.parse(JSON.stringify(data));
    },
  };
}

module.exports = { createStore, DEFAULT_SETTINGS, SETTING_KEYS };
