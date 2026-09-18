'use strict';

/**
 * Thief Book 主进程入口：生命周期、托盘、菜单、IPC 接线。
 */

const path = require('path');
const { app, Menu, Tray, dialog, ipcMain, nativeImage } = require('electron');
const { createStore } = require('../common/store');
const { Library } = require('./library');
const { ReaderWindow } = require('./reader-window');
const { Shortcuts } = require('./shortcuts');
const { ensureSettingsWindow, getSettingsWindow } = require('./settings-window');

let store = null;
let library = null;
let reader = null;
let shortcuts = null;
let tray = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (reader) reader.reveal();
  });

  app.whenReady()
    .then(init)
    .catch((err) => {
      console.error('[thief-book] init failed:', err);
      dialog.showErrorBox('Thief Book 启动失败', String((err && err.stack) || err));
      app.quit();
    });

  app.on('before-quit', () => {
    if (library) library.flushSave();
    if (store) store.persistNow();
  });

  app.on('will-quit', () => {
    if (shortcuts) shortcuts.dispose();
  });

  // 阅读条常驻，只通过托盘/菜单退出
  app.on('window-all-closed', () => {});
}

function init() {
  if (process.platform === 'darwin') app.dock.hide();

  store = createStore(app.getPath('userData'));
  library = new Library(store);

  reader = new ReaderWindow(store);
  reader.onHoverChange = (active) => shortcuts && shortcuts.setPageKeysActive(active);
  reader.create();

  shortcuts = new Shortcuts({
    onBoss: () => reader.toggleBoss(),
    onPaging: pageCmd,
  });
  shortcuts.applySettings(store.settings);
  if (shortcuts.bossConflict) {
    dialog.showErrorBox(
      '老板键注册失败',
      `快捷键「${store.settings.bossKey}」被其他应用占用或无效。\n请从托盘菜单打开设置更换键位。`
    );
  }

  if (store.settings.resumeOnStart && store.lastBookPath) {
    const r = library.open(store.lastBookPath);
    if (!r.ok) console.warn('[thief-book] 恢复上次书籍失败:', r.message);
  }

  createTray();
  registerIpc();
}

// ---------------------------------------------------------------------------
// 推送与联动
// ---------------------------------------------------------------------------

function pushPage(st) {
  reader.send('push:page', st);
}

function pushBooks() {
  const w = getSettingsWindow();
  if (w && !w.isDestroyed()) {
    w.webContents.send('push:books', store.listBooks());
  }
}

function applySettingsChanged() {
  const st = library.reapplyMetrics();
  if (st) pushPage(st);
  reader.applySettingsChanged();
  reader.send('push:appearance', library.appearance());
  shortcuts.applySettings(store.settings);
  rebuildTrayMenu();
}

// ---------------------------------------------------------------------------
// 书籍
// ---------------------------------------------------------------------------

async function openBookDialog() {
  const r = await dialog.showOpenDialog({
    title: '选择 TXT 小说',
    properties: ['openFile'],
    filters: [
      { name: '文本文件', extensions: ['txt'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths.length) return { opened: false, message: null };
  return openBookPath(r.filePaths[0]);
}

function openBookPath(p) {
  const res = library.open(p);
  if (res.ok) {
    pushPage(res.page);
    pushBooks();
  }
  return { opened: res.ok, message: res.message || null };
}

// ---------------------------------------------------------------------------
// 菜单 / 托盘
// ---------------------------------------------------------------------------

function pageCmd(dir) {
  const st =
    dir === 'next' ? library.turn(1) :
    dir === 'prev' ? library.turn(-1) :
    dir === 'nextCh' ? library.chapter(1) :
    library.chapter(-1);
  if (st) pushPage(st);
}

function buildMenu() {
  const s = store.settings;
  const recents = store.listBooks().slice(0, 6);
  return Menu.buildFromTemplate([
    { label: '下一页', click: () => pageCmd('next') },
    { label: '上一页', click: () => pageCmd('prev') },
    { label: '下一章', click: () => pageCmd('nextCh') },
    { label: '上一章', click: () => pageCmd('prevCh') },
    { type: 'separator' },
    { label: '打开小说…', click: () => openBookDialog() },
    {
      label: '最近阅读',
      submenu: recents.length
        ? recents.map((b) => ({
            label: `${b.name}（${(b.percent * 100).toFixed(0)}%）`,
            click: () => {
              const r = openBookPath(b.path);
              if (!r.opened && r.message) dialog.showErrorBox('打开失败', r.message);
            },
          }))
        : [{ label: '暂无', enabled: false }],
    },
    { type: 'separator' },
    {
      label: reader.bossHidden ? '显示阅读条' : '隐藏阅读条（老板键）',
      click: () => reader.toggleBoss(),
    },
    {
      label: '悬停显示正文',
      type: 'checkbox',
      checked: s.hoverMode,
      click: (item) => {
        store.setSetting('hoverMode', item.checked);
        applySettingsChanged();
      },
    },
    { label: '设置…', click: () => ensureSettingsWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}

function loadTrayIcon() {
  const templatePath = path.join(__dirname, '../../assets/icons/tray-template.png');
  const colorPath = path.join(__dirname, '../../assets/icons/icons.png');
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(templatePath);
    if (!img.isEmpty()) {
      img.setTemplateImage(true);
      return img;
    }
  }
  return nativeImage.createFromPath(colorPath);
}

function createTray() {
  tray = new Tray(loadTrayIcon());
  tray.setToolTip('Thief Book · 左键隐藏/显示，右键菜单');
  if (process.platform === 'darwin') {
    // mac：左键老板键式切换，右键即时构建菜单（checkbox 状态总是最新）
    tray.on('click', () => reader.peek());
    tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
  } else {
    tray.on('click', () => reader.peek());
    rebuildTrayMenu();
  }
}

function rebuildTrayMenu() {
  if (!tray || process.platform === 'darwin') return;
  tray.setContextMenu(buildMenu());
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  const isReader = (e) =>
    !!(reader && reader.win && !reader.win.isDestroyed() && e.sender === reader.win.webContents);
  const isSettings = (e) => {
    const w = getSettingsWindow();
    return !!(w && !w.isDestroyed() && e.sender === w.webContents);
  };

  // ---- 阅读条 ----

  ipcMain.handle('reader:ready', (e) => {
    if (!isReader(e)) return null;
    return {
      page: library.pageState(),
      appearance: library.appearance(),
      visible: reader.hoverVisible,
      hasBook: library.hasBook,
    };
  });

  ipcMain.handle('reader:page', (e, p) => {
    if (!isReader(e) || !p) return null;
    const st = library.turn(p.dir === -1 ? -1 : 1);
    if (st) pushPage(st);
    return st;
  });

  ipcMain.handle('reader:chapter', (e, p) => {
    if (!isReader(e) || !p) return null;
    const st = library.chapter(p.dir === -1 ? -1 : 1);
    if (st) pushPage(st);
    return st;
  });

  ipcMain.handle('reader:open', async (e) => {
    if (!isReader(e)) return { opened: false, message: null };
    return openBookDialog();
  });

  ipcMain.on('reader:menu', (e, p) => {
    if (!isReader(e) || !p) return;
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    buildMenu().popup({ window: reader.win, x, y });
  });

  ipcMain.on('reader:dragStart', (e) => {
    if (isReader(e)) reader.beginDrag();
  });

  ipcMain.on('reader:dragEnd', (e) => {
    if (isReader(e)) reader.endDrag();
  });

  // ---- 设置窗口 ----

  ipcMain.handle('settings:get', (e) => {
    if (!isSettings(e)) return null;
    return {
      settings: store.settings,
      books: store.listBooks(),
      currentBook: library.book ? { path: library.book.path, name: library.book.name } : null,
      bossConflict: shortcuts.bossConflict,
    };
  });

  ipcMain.handle('settings:set', (e, p) => {
    if (!isSettings(e) || !p || typeof p !== 'object') return { ok: false, error: 'bad request' };
    const r = store.setSetting(p.key, p.value);
    if (r.ok) applySettingsChanged();
    return r;
  });

  ipcMain.handle('settings:setKeys', (e, p) => {
    if (!isSettings(e) || !p || typeof p !== 'object') return { ok: false, errors: { _: 'bad request' } };
    const keys = {
      boss: p.boss,
      next: p.next,
      prev: p.prev,
      nextCh: p.nextCh,
      prevCh: p.prevCh,
    };
    const errors = {};
    const seen = new Map();
    for (const [k, accel] of Object.entries(keys)) {
      if (typeof accel !== 'string' || !accel.trim()) {
        errors[k] = '键位为空';
        continue;
      }
      const norm = accel.trim();
      if (seen.has(norm) && seen.get(norm) !== k) errors[k] = '与其他键位重复';
      else seen.set(norm, k);
    }
    if (!Object.keys(errors).length) {
      for (const [k, accel] of Object.entries(keys)) {
        const probe = shortcuts.probe(accel.trim());
        if (!probe.ok) errors[k] = probe.reason;
      }
    }
    if (Object.keys(errors).length) return { ok: false, errors };

    store.setSetting('bossKey', keys.boss.trim());
    store.setSetting('nextPageKey', keys.next.trim());
    store.setSetting('prevPageKey', keys.prev.trim());
    store.setSetting('nextChapterKey', keys.nextCh.trim());
    store.setSetting('prevChapterKey', keys.prevCh.trim());
    shortcuts.applySettings(store.settings);
    return { ok: true, errors: {}, bossConflict: shortcuts.bossConflict };
  });

  ipcMain.handle('settings:openBook', (e, p) => {
    if (!isSettings(e) || !p || typeof p.path !== 'string') {
      return { opened: false, message: 'bad request' };
    }
    return openBookPath(p.path);
  });

  ipcMain.handle('settings:forgetBook', (e, p) => {
    if (!isSettings(e) || !p || typeof p.path !== 'string') return { ok: false };
    store.removeBook(p.path);
    pushBooks();
    return { ok: true };
  });

  ipcMain.handle('settings:jump', (e, p) => {
    if (!isSettings(e) || !p) return { ok: false };
    const st = library.jumpPercent(Number(p.percent));
    if (st) pushPage(st);
    return { ok: !!st };
  });

  ipcMain.handle('settings:pickBook', async (e) => {
    if (!isSettings(e)) return { path: null };
    const r = await dialog.showOpenDialog({
      title: '选择 TXT 小说',
      properties: ['openFile'],
      filters: [
        { name: '文本文件', extensions: ['txt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return { path: r.canceled || !r.filePaths.length ? null : r.filePaths[0] };
  });

  ipcMain.handle('settings:probeKey', (e, p) => {
    if (!isSettings(e) || !p || typeof p.accel !== 'string') {
      return { ok: false, reason: 'bad request' };
    }
    return shortcuts.probe(p.accel);
  });
}
