'use strict';

/**
 * 阅读条窗口：无边框透明置顶小条。
 * - hover 模式：轮询光标位置，移入淡入正文并接通翻页键，移出宽限后淡出并点击穿透。
 * - 老板键：整体 hide/show，轮询挂起。
 * - 隐藏态 = 内容透明 + setIgnoreMouseEvents(true)，窗口本体保持 show，
 *   因此恢复显示无需 show/hide 抖动；backdrop-filter 只在可见态启用，避免隐身时残留模糊块。
 */

const path = require('path');
const { BrowserWindow, screen } = require('electron');

const HOVER_POLL_MS = 50;
const ACTIVATE_MARGIN = 2; // 边界外扩，更容易命中
const DRAG_FOLLOW_MS = 16; // 拖拽跟随频率（约 60fps）
const DRAG_MAX_MS = 30000; // 兜底上限：mouseup 丢失（渲染端崩溃等）时不至于永久粘住光标

// 与 renderer/reader/reader.css 严格一致的尺寸常量
const PAD_TOP = 10;
const PAD_BOTTOM = 8;
const GRIP_W = 22;
const PAD_LEFT = 6;
const PAD_RIGHT = 14;
const LINE_HEIGHT_FACTOR = 1.55;
const CHAPTER_H = 22;
const FOOTER_H = 19;
const MOVE_SAVE_DELAY = 400;
const PEEK_MS = 3000; // 托盘点击:阅读条浮现时长

function lineHeight(fontSize) {
  return Math.round(fontSize * LINE_HEIGHT_FACTOR);
}

function windowHeightFor(settings) {
  let h = PAD_TOP + PAD_BOTTOM + settings.lines * lineHeight(settings.fontSize);
  if (settings.showChapter) h += CHAPTER_H;
  if (settings.showProgress) h += FOOTER_H;
  return h;
}

function defaultRect(settings, workArea) {
  const w = settings.width;
  const h = windowHeightFor(settings);
  return {
    x: Math.round(workArea.x + (workArea.width - w) / 2),
    y: Math.round(workArea.y + workArea.height - h - 6),
    width: w,
    height: h,
  };
}

/** 把矩形约束到某块屏幕的工作区内（至少露出大半）。 */
function clampRect(rect, display) {
  const wa = display.workArea;
  const w = Math.min(rect.width, wa.width);
  const h = Math.min(rect.height, wa.height);
  const x = Math.min(Math.max(rect.x, wa.x), wa.x + wa.width - w);
  const y = Math.min(Math.max(rect.y, wa.y), wa.y + wa.height - h);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

class ReaderWindow {
  /** @param {import('../common/store').Store} store */
  constructor(store) {
    this.store = store;
    this.win = null;
    this.hoverVisible = false; // 正文是否处于显示态
    this.bossHidden = false;
    this.peekUntil = 0; // 托盘浮现截止时刻
    this.leftAt = 0;
    this.keysWanted = false;  // 最近一次 tick 的悬停结果
    this.keysActive = false;
    this.dragging = false;
    this._dragOffset = { x: 0, y: 0 };
    this._dragTimer = null;
    this._dragStartedAt = 0;
    /** @type {(active: boolean)=>void} 翻页键开关（主进程接线到 Shortcuts） */
    this.onHoverChange = null;
    this._pollTimer = null;
    this._moveTimer = null;
  }

  create() {
    const s = this.store.settings;
    const saved = this.store.windowRect;
    const rect = saved
      ? clampRect(saved, screen.getDisplayMatching(saved))
      : defaultRect(s, screen.getPrimaryDisplay().workArea);

    this.win = new BrowserWindow({
      ...rect,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false, // 永不抢焦点：键盘全部走全局快捷键
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '../preload/reader.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    this.win.setAlwaysOnTop(true, 'floating');
    this.win.loadFile(path.join(__dirname, '../renderer/reader/index.html'));

    this.win.once('ready-to-show', () => {
      this.win.show();
      this._applyInitialState();
    });
    this.win.on('moved', () => this._scheduleSaveRect());
    this.win.on('closed', () => {
      this.win = null;
      this.stopPolling();
    });

    this.startPolling();
    return this.win;
  }

  _applyInitialState() {
    const s = this.store.settings;
    if (s.hoverMode) {
      this._hideContent();
    } else {
      this._showContent();
    }
  }

  // ---------- hover 轮询 ----------

  startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this._tick(), HOVER_POLL_MS);
  }

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._setKeysActive(false);
  }

  _tick() {
    if (!this.win) return;
    // 托盘浮现期:内容保持显示;到期鼠标在条上则交还悬停接管,否则恢复原状
    if (this.peekUntil) {
      if (Date.now() < this.peekUntil) return; // 浮现中:暂停悬停转换与翻页键
      this.peekUntil = 0;
      const b = this.win.getBounds();
      const p = screen.getCursorScreenPoint();
      const inside =
        p.x >= b.x - ACTIVATE_MARGIN && p.x <= b.x + b.width + ACTIVATE_MARGIN &&
        p.y >= b.y - ACTIVATE_MARGIN && p.y <= b.y + b.height + ACTIVATE_MARGIN;
      if (inside) {
        if (this.bossHidden) this.bossHidden = false; // 交还悬停接管
      } else {
        if (this.store.settings.hoverMode) this._hideContent();
        if (this.bossHidden) {
          this.win.hide();
          this._setKeysActive(false);
        }
      }
      return;
    }
    if (this.bossHidden) {
      this._setKeysActive(false);
      return;
    }
    const s = this.store.settings;
    const b = this.win.getBounds();
    const p = screen.getCursorScreenPoint();
    const inside =
      p.x >= b.x - ACTIVATE_MARGIN && p.x <= b.x + b.width + ACTIVATE_MARGIN &&
      p.y >= b.y - ACTIVATE_MARGIN && p.y <= b.y + b.height + ACTIVATE_MARGIN;

    if (s.hoverMode) {
      if (inside) {
        this.leftAt = 0;
        if (!this.hoverVisible) this._showContent();
      } else if (this.hoverVisible) {
        if (!this.leftAt) this.leftAt = Date.now();
        if (Date.now() - this.leftAt >= s.hideDelayMs) this._hideContent();
      }
    }
    // 翻页键只在鼠标悬停在阅读条上时生效（两种模式一致）
    this._setKeysActive(inside);
  }

  _showContent() {
    this.hoverVisible = true;
    if (this.win) this.win.setIgnoreMouseEvents(false);
    // 载荷即回调值：与 push:page / push:appearance / push:books 一致，
    // preload 原样透传（包一层 {visible} 会让渲染端拿到恒真的对象，永远无法隐藏）
    this.send('push:visible', true);
  }

  _hideContent() {
    this.hoverVisible = false;
    this.leftAt = 0;
    if (this.win) this.win.setIgnoreMouseEvents(true, { forward: true });
    this.send('push:visible', false);
  }

  _setKeysActive(active) {
    if (active === this.keysActive) return;
    this.keysActive = active;
    if (this.onHoverChange) this.onHoverChange(active);
  }

  // ---------- 托盘浮现 / 老板键 ----------

  /** 托盘左键:阅读条带正文浮现 3 秒,不管老板键是否隐藏中。 */
  peek() {
    if (!this.win) return;
    if (this.bossHidden) this.win.show(); // 隐藏中的窗口临时亮出,bossHidden 状态保留
    this.peekUntil = Date.now() + PEEK_MS;
    this._showContent();
  }

  toggleBoss() {
    if (!this.win) return;
    this.peekUntil = 0; // 手动切换取消浮现
    if (this.bossHidden) {
      this.bossHidden = false;
      this.win.show();
      this._applyInitialState(); // 随后 50ms 内的 tick 会按光标位置自动修正
    } else {
      this.endDrag();
      this.bossHidden = true;
      this.win.hide();
      this._setKeysActive(false);
    }
  }

  /** 二次启动/紧急恢复时确保可见。 */
  reveal() {
    if (this.bossHidden) this.toggleBoss();
  }

  // ---------- 手动拖拽 ----------
  // focusable:false 的无边框窗口上 -webkit-app-region 拖拽不可靠。
  // 把手 mousedown → 渲染端通知主进程 → 16ms 轮询跟随光标 → mouseup 结束并落盘位置。

  beginDrag() {
    if (!this.win || this.dragging) return;
    const p = screen.getCursorScreenPoint();
    const b = this.win.getBounds();
    this.dragging = true;
    this._dragOffset = { x: p.x - b.x, y: p.y - b.y };
    this._dragStartedAt = Date.now();
    this._dragTimer = setInterval(() => this._dragTick(), DRAG_FOLLOW_MS);
  }

  endDrag() {
    if (!this.dragging) return;
    this.dragging = false;
    if (this._dragTimer) {
      clearInterval(this._dragTimer);
      this._dragTimer = null;
    }
    this._scheduleSaveRect();
  }

  _dragTick() {
    if (!this.win || !this.dragging) return;
    if (Date.now() - this._dragStartedAt > DRAG_MAX_MS) {
      this.endDrag();
      return;
    }
    const p = screen.getCursorScreenPoint();
    this.win.setPosition(
      Math.round(p.x - this._dragOffset.x),
      Math.round(p.y - this._dragOffset.y)
    );
  }

  // ---------- 推送 ----------

  send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, payload);
    }
  }

  // ---------- 设置变化 ----------

  /** 外观/尺寸变化：底边中点锚定，避免调宽度时条“漂走”。 */
  applySettingsChanged() {
    if (!this.win) return;
    this.endDrag();
    const s = this.store.settings;
    const b = this.win.getBounds();
    const h = windowHeightFor(s);
    const rect = {
      x: b.x + Math.round((b.width - s.width) / 2),
      y: b.y + (b.height - h),
      width: s.width,
      height: h,
    };
    this.win.setBounds(clampRect(rect, screen.getDisplayMatching(rect)));

    if (!s.hoverMode && !this.hoverVisible) this._showContent();
    // hoverMode 从关到开：若鼠标不在条上，下一次 tick 会在宽限期后自然隐藏
  }

  // ---------- 位置记忆 ----------

  _scheduleSaveRect() {
    if (this._moveTimer) clearTimeout(this._moveTimer);
    this._moveTimer = setTimeout(() => {
      this._moveTimer = null;
      if (!this.win) return;
      const b = this.win.getBounds();
      this.store.setWindowRect(b);
    }, MOVE_SAVE_DELAY);
  }

  destroy() {
    this.endDrag();
    if (this._moveTimer) clearTimeout(this._moveTimer);
    this.stopPolling();
    if (this.win) this.win.destroy();
    this.win = null;
  }
}

module.exports = { ReaderWindow, windowHeightFor, defaultRect, clampRect };
