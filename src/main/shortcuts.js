'use strict';

/**
 * 全局快捷键：
 * - 老板键常驻注册；
 * - 翻页键（hjkl，可改）仅在鼠标悬停于阅读条期间注册，不干扰日常打字。
 */

const { globalShortcut } = require('electron');

class Shortcuts {
  /**
   * @param {{onBoss: ()=>void, onPaging: (dir: 'next'|'prev'|'nextCh'|'prevCh')=>void}} handlers
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.bossAccel = null;
    this.pageAccels = { next: null, prev: null, nextCh: null, prevCh: null };
    this.pageActive = false;
    /** 老板键是否注册失败（被占用/非法） */
    this.bossConflict = false;
    /** 当前悬停期间注册失败的翻页键 {accel: true} */
    this.pageConflicts = {};
  }

  /** 设置变化后热更新（老板键立即重注册，翻页键若处于激活态也重注册）。 */
  applySettings(settings) {
    this.reregisterBoss(settings.bossKey);
    this.pageAccels = {
      next: settings.nextPageKey,
      prev: settings.prevPageKey,
      nextCh: settings.nextChapterKey,
      prevCh: settings.prevChapterKey,
    };
    if (this.pageActive) this._registerPageKeys();
  }

  reregisterBoss(accel) {
    if (this.bossAccel) this._safeUnregister(this.bossAccel);
    this.bossAccel = accel || null;
    this.bossConflict = !accel || !this._register(accel, () => this.handlers.onBoss());
    return !this.bossConflict;
  }

  /** 鼠标悬停状态变化时切换翻页键。 */
  setPageKeysActive(active) {
    if (active === this.pageActive) return;
    this.pageActive = active;
    if (active) this._registerPageKeys();
    else this._unregisterPageKeys();
  }

  _registerPageKeys() {
    this._unregisterPageKeys();
    const entries = [
      [this.pageAccels.next, 'next'],
      [this.pageAccels.prev, 'prev'],
      [this.pageAccels.nextCh, 'nextCh'],
      [this.pageAccels.prevCh, 'prevCh'],
    ];
    const seen = new Set();
    for (const [accel, dir] of entries) {
      if (!accel || seen.has(accel)) continue;
      seen.add(accel);
      if (!this._register(accel, () => this.handlers.onPaging(dir))) {
        this.pageConflicts[accel] = true;
      }
    }
  }

  _unregisterPageKeys() {
    for (const accel of Object.values(this.pageAccels)) {
      if (accel) this._safeUnregister(accel);
    }
    this.pageConflicts = {};
  }

  _register(accel, cb) {
    try {
      globalShortcut.register(accel, cb);
      return globalShortcut.isRegistered(accel);
    } catch {
      return false;
    }
  }

  _safeUnregister(accel) {
    try {
      globalShortcut.unregister(accel);
    } catch {
      /* ignore */
    }
  }

  /**
   * 设置窗口用：探测 accelerator 是否可用（不与现有注册互踩）。
   * @returns {{ok: boolean, reason: string|null}}
   */
  probe(accel) {
    if (!accel || typeof accel !== 'string' || !accel.trim()) {
      return { ok: false, reason: '键位为空' };
    }
    try {
      // 已被本应用注册 = 自己占用自己，视为可用
      if (globalShortcut.isRegistered(accel)) return { ok: true, reason: null };
      globalShortcut.register(accel, () => {});
      const ok = globalShortcut.isRegistered(accel);
      globalShortcut.unregister(accel);
      return ok
        ? { ok: true, reason: null }
        : { ok: false, reason: '被其他应用占用' };
    } catch {
      return { ok: false, reason: '格式无效' };
    }
  }

  dispose() {
    try {
      globalShortcut.unregisterAll();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { Shortcuts };
