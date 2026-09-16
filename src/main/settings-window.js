'use strict';

/**
 * 设置窗口（懒创建单例）。
 * - ensureSettingsWindow()：已存在则唤起并聚焦，否则创建；
 * - 关闭即清空单例引用，下次打开重新创建（不记忆位置，每次居中）。
 */

const path = require('path');
const { BrowserWindow } = require('electron');

let win = null;

/** @returns {Electron.BrowserWindow|null} */
function getSettingsWindow() {
  if (win && !win.isDestroyed()) return win;
  win = null;
  return null;
}

/** @returns {Electron.BrowserWindow} */
function ensureSettingsWindow() {
  const existing = getSettingsWindow();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }

  win = new BrowserWindow({
    width: 480,
    height: 680,
    minWidth: 380,
    minHeight: 420,
    title: '设置 — Thief Book',
    resizable: true,
    fullscreenable: false,
    center: true,
    show: false,
    backgroundColor: '#16181d', // 与页面底色一致，避免首帧白闪
    webPreferences: {
      preload: path.join(__dirname, '../preload/settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  const w = win;
  w.loadFile(path.join(__dirname, '../renderer/settings/index.html'));
  w.once('ready-to-show', () => {
    if (!w.isDestroyed()) w.show();
  });
  w.on('closed', () => {
    win = null; // 允许下次重建
  });

  return win;
}

module.exports = { ensureSettingsWindow, getSettingsWindow };
