'use strict';

/** src/common/store.js：设置校验、进度持久化、损坏恢复。 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, DEFAULT_SETTINGS } = require('../src/common/store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'thief-book-store-'));
}

function writeRaw(dir, obj) {
  fs.writeFileSync(path.join(dir, 'reader-store.json'), JSON.stringify(obj), 'utf8');
}

// ---------------------------------------------------------------------------
// 加载与校验
// ---------------------------------------------------------------------------

test('空目录加载默认设置', () => {
  const store = createStore(tmpDir());
  assert.deepStrictEqual(store.settings, DEFAULT_SETTINGS);
  assert.strictEqual(store.lastBookPath, null);
  assert.strictEqual(store.windowRect, null);
  assert.deepStrictEqual(store.listBooks(), []);
});

test('setSetting: 未知 key 拒绝', () => {
  const store = createStore(tmpDir());
  assert.deepStrictEqual(store.setSetting('nope', 1), { ok: false, error: 'unknown key' });
});

test('setSetting: 数值范围钳制', () => {
  const store = createStore(tmpDir());
  for (const [key, value, want] of [
    ['fontSize', 999, 40],
    ['fontSize', 0, 9],
    ['fontSize', 'abc', DEFAULT_SETTINGS.fontSize],
    ['lines', 10, 6],
    ['width', 10, 280],
    ['hideDelayMs', 1, 50],
  ]) {
    assert.strictEqual(store.setSetting(key, value).ok, true, key);
    assert.strictEqual(store.getSetting(key), want, `${key}=${value}`);
  }
});

test('setSetting: theme / 颜色 / 键位校验', () => {
  const store = createStore(tmpDir());

  assert.strictEqual(store.setSetting('theme', 'pink').ok, true);
  assert.strictEqual(store.getSetting('theme'), 'light'); // 非法回退默认

  assert.strictEqual(store.setSetting('bgColor', '#abcdef').ok, true);
  assert.strictEqual(store.getSetting('bgColor'), '#abcdef');
  assert.strictEqual(store.setSetting('bgColor', 'javascript:alert(1)').ok, true);
  assert.strictEqual(store.getSetting('bgColor'), '#abcdef'); // 非法保持原值
  assert.strictEqual(store.setSetting('fgColor', 'rgba(0,0,0,.5)').ok, true);
  assert.strictEqual(store.getSetting('fgColor'), 'rgba(0,0,0,.5)');

  assert.strictEqual(store.setSetting('bossKey', '  Ctrl+X  ').ok, true);
  assert.strictEqual(store.getSetting('bossKey'), 'Ctrl+X');
  assert.deepStrictEqual(store.setSetting('bossKey', '   '), { ok: false, error: 'invalid value' });

  assert.strictEqual(store.setSetting('hoverMode', false).ok, true);
  assert.strictEqual(store.getSetting('hoverMode'), false);
});

test('setWindowRect: 非法矩形被忽略', () => {
  const store = createStore(tmpDir());
  store.setWindowRect({ x: 1, y: 2, width: 3, height: 4 });
  assert.deepStrictEqual(store.windowRect, { x: 1, y: 2, width: 3, height: 4 });
  store.setWindowRect({ x: NaN, y: 2, width: 3, height: 4 });
  store.setWindowRect(null);
  assert.deepStrictEqual(store.windowRect, { x: 1, y: 2, width: 3, height: 4 });
});

// ---------------------------------------------------------------------------
// 进度与书单
// ---------------------------------------------------------------------------

test('saveProgress: 钳制并落盘 charIndex / percent', () => {
  const store = createStore(tmpDir());
  store.saveProgress({ path: '/books/a.txt', name: 'a', charIndex: 123.7, percent: 2 });
  const b = store.bookProgress('/books/a.txt');
  assert.strictEqual(b.charIndex, 123);
  assert.strictEqual(b.percent, 1);
  assert.strictEqual(b.name, 'a');
  assert.ok(b.updatedAt > 0 && b.addedAt > 0);
  assert.strictEqual(store.lastBookPath, '/books/a.txt');
});

test('listBooks: 按 updatedAt 倒序；removeBook 回退 lastBookPath', () => {
  const dir = tmpDir();
  writeRaw(dir, {
    version: 2,
    lastBookPath: '/a',
    books: {
      '/a': { path: '/a', name: 'a', charIndex: 0, percent: 0, updatedAt: 100, addedAt: 1 },
      '/b': { path: '/b', name: 'b', charIndex: 0, percent: 0, updatedAt: 200, addedAt: 1 },
      '/c': { path: '/c', name: 'c', charIndex: 0, percent: 0, updatedAt: 50, addedAt: 1 },
    },
  });
  const store = createStore(dir);
  assert.deepStrictEqual(store.listBooks().map((b) => b.path), ['/b', '/a', '/c']);
  assert.strictEqual(store.lastBookPath, '/a');

  store.removeBook('/a');
  assert.strictEqual(store.lastBookPath, '/b'); // 回退到最近的剩余书籍
  assert.strictEqual(store.bookProgress('/a'), null);
});

// ---------------------------------------------------------------------------
// 持久化与恢复
// ---------------------------------------------------------------------------

test('persistNow 后重建 store，设置/进度/窗口位置完整恢复', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  store.setSetting('fontSize', 20);
  store.setSetting('bossKey', 'Ctrl+Alt+X');
  store.setWindowRect({ x: 11, y: 22, width: 620, height: 70 });
  store.saveProgress({ path: '/books/b.txt', name: 'b', charIndex: 555, percent: 0.4 });
  store.persistNow();

  const store2 = createStore(dir);
  assert.strictEqual(store2.getSetting('fontSize'), 20);
  assert.strictEqual(store2.getSetting('bossKey'), 'Ctrl+Alt+X');
  assert.deepStrictEqual(store2.windowRect, { x: 11, y: 22, width: 620, height: 70 });
  assert.strictEqual(store2.bookProgress('/books/b.txt').charIndex, 555);
  assert.strictEqual(store2.lastBookPath, '/books/b.txt');
});

test('损坏文件：备份后以默认值重建，不抛异常', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'reader-store.json'), '{not valid json{{{', 'utf8');
  const store = createStore(dir);
  assert.deepStrictEqual(store.settings, DEFAULT_SETTINGS);
  const backups = fs.readdirSync(dir).filter((f) => /\.corrupt-\d+$/.test(f));
  assert.strictEqual(backups.length, 1, '损坏文件应留有备份');
});

test('migrate: 旧数据中的坏值被钳制/回退', () => {
  const dir = tmpDir();
  writeRaw(dir, {
    version: 1,
    settings: {
      fontSize: 9999,
      lines: 'x',
      theme: 'pink',
      bossKey: '',
      hoverMode: 'yes',
    },
    books: {
      '/p': { path: '/p', charIndex: -5, percent: 5, updatedAt: 'bad', addedAt: 1 },
    },
    windowRect: { x: 1, y: 2, width: 3, height: NaN },
    lastBookPath: 42,
  });
  const store = createStore(dir);
  assert.strictEqual(store.getSetting('fontSize'), 40);
  assert.strictEqual(store.getSetting('lines'), DEFAULT_SETTINGS.lines);
  assert.strictEqual(store.getSetting('theme'), 'light'); // 非法回退默认（v3 起默认浅色）
  assert.strictEqual(store.getSetting('bossKey'), DEFAULT_SETTINGS.bossKey);
  assert.strictEqual(store.getSetting('hoverMode'), true); // 坏类型回退默认
  const b = store.bookProgress('/p');
  assert.strictEqual(b.charIndex, 0);
  assert.strictEqual(b.percent, 1);
  assert.ok(Number.isFinite(b.updatedAt));
  assert.strictEqual(store.windowRect, null);
  assert.strictEqual(store.lastBookPath, null);
});

test('migrate v2→v3: 旧深色默认值迁移为透明白默认', () => {
  const dir = tmpDir();
  writeRaw(dir, {
    version: 2,
    settings: {
      theme: 'dark',
      bgColor: 'rgba(24, 26, 32, 0.78)',
      fgColor: '#e8e6e3',
    },
  });
  const store = createStore(dir);
  assert.strictEqual(store.getSetting('theme'), 'light');
  assert.strictEqual(store.getSetting('bgColor'), 'rgba(255, 255, 255, 0.8)');
  assert.strictEqual(store.getSetting('fgColor'), '#1d1d1f');
});

test('migrate v2→v3: 全透明背景(隐藏 bug 规避值)迁移为透明白默认', () => {
  const dir = tmpDir();
  writeRaw(dir, {
    version: 2,
    settings: { theme: 'light', bgColor: 'rgba(245, 245, 247, 0)', fgColor: '#1d1d1f' },
  });
  const store = createStore(dir);
  assert.strictEqual(store.getSetting('bgColor'), 'rgba(255, 255, 255, 0.8)');
  assert.strictEqual(store.getSetting('fgColor'), '#1d1d1f');
});

test('migrate: 用户自定义颜色不受 v3 迁移影响', () => {
  const dir = tmpDir();
  writeRaw(dir, {
    version: 2,
    settings: { theme: 'custom', bgColor: 'rgba(80, 20, 120, 0.5)', fgColor: '#ffcc00' },
  });
  const store = createStore(dir);
  assert.strictEqual(store.getSetting('theme'), 'custom');
  assert.strictEqual(store.getSetting('bgColor'), 'rgba(80, 20, 120, 0.5)');
  assert.strictEqual(store.getSetting('fgColor'), '#ffcc00');

  // v3 已迁移过的数据不会二次改动
  const dir2 = tmpDir();
  writeRaw(dir2, {
    version: 3,
    settings: { theme: 'dark', bgColor: 'rgba(24, 26, 32, 0.78)', fgColor: '#e8e6e3' },
  });
  const store2 = createStore(dir2);
  assert.strictEqual(store2.getSetting('theme'), 'dark');
});

test('toJSON: 供给设置窗口的完整快照', () => {
  const store = createStore(tmpDir());
  store.saveProgress({ path: '/x', name: 'x', charIndex: 1, percent: 0.1 });
  const snap = store.toJSON();
  assert.strictEqual(snap.version, 3);
  assert.deepStrictEqual(snap.settings, store.settings);
  assert.ok(snap.books['/x']);
  // 快照是深拷贝，改快照不影响内部状态
  snap.settings.fontSize = 1;
  snap.books['/x'].charIndex = 99;
  assert.strictEqual(store.getSetting('fontSize'), DEFAULT_SETTINGS.fontSize);
  assert.strictEqual(store.bookProgress('/x').charIndex, 1);
});
