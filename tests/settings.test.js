'use strict';

/** src/common/settings.mjs:设置校验/钳制(纯函数)。 */

const assert = require('assert');
const {
  DEFAULT_SETTINGS,
  SETTING_KEYS,
  RANGES,
  clamp,
  sanitizeColor,
  sanitizeSetting,
} = require('../src/common/settings.mjs');

test('DEFAULT_SETTINGS: 键齐全且主题为透明白默认', () => {
  assert.strictEqual(DEFAULT_SETTINGS.theme, 'light');
  assert.strictEqual(DEFAULT_SETTINGS.bgColor, 'rgba(255, 255, 255, 0.8)');
  assert.strictEqual(DEFAULT_SETTINGS.fgColor, '#1d1d1f');
  assert.ok(SETTING_KEYS.includes('wheelPaging'));
  assert.ok(SETTING_KEYS.length === new Set(SETTING_KEYS).size, '键不得重复');
});

test('clamp: 数值范围钳制', () => {
  assert.strictEqual(clamp('fontSize', 999), 40);
  assert.strictEqual(clamp('fontSize', 0), 9);
  assert.strictEqual(clamp('fontSize', 'abc'), DEFAULT_SETTINGS.fontSize);
  assert.strictEqual(clamp('lines', 10), 6);
  assert.strictEqual(clamp('width', 10), 280);
  assert.strictEqual(clamp('hideDelayMs', 1), 50);
  assert.strictEqual(clamp('theme', 1), 1); // 非数值键原样返回
});

test('sanitizeSetting: theme / 颜色 / 布尔 / 字符串 / 未知键', () => {
  assert.strictEqual(sanitizeSetting('theme', 'pink', 'light'), 'light'); // 非法回退默认
  assert.strictEqual(sanitizeSetting('theme', 'dark', 'light'), 'dark');

  assert.strictEqual(sanitizeSetting('bgColor', '#abcdef', 'rgba(255,255,255,0.8)'), '#abcdef');
  assert.strictEqual(
    sanitizeSetting('bgColor', 'javascript:alert(1)', '#abcdef'),
    '#abcdef',
    '非法颜色保持原值'
  );

  assert.strictEqual(sanitizeSetting('hoverMode', false, true), false);
  assert.strictEqual(sanitizeSetting('bossKey', '  Ctrl+X  ', ''), 'Ctrl+X');
  assert.strictEqual(sanitizeSetting('bossKey', '   ', 'Ctrl+X'), null); // 空串无效
  assert.strictEqual(sanitizeSetting('nope', 1, null), null); // 未知键拒绝
});

test('sanitizeColor: 正则', () => {
  assert.strictEqual(sanitizeColor(' rgba(0,0,0,.5) ', 'x'), 'rgba(0,0,0,.5)');
  assert.strictEqual(sanitizeColor('#1a2b3c', 'x'), '#1a2b3c');
  assert.strictEqual(sanitizeColor('red', 'fallback'), 'fallback');
  assert.strictEqual(sanitizeColor('rgb(1,2,3', 'fallback'), 'fallback');
});

test('RANGES 与默认值自洽', () => {
  for (const [key, [lo, hi]] of Object.entries(RANGES)) {
    const d = DEFAULT_SETTINGS[key];
    assert.ok(d >= lo && d <= hi, `${key} 默认值 ${d} 超出 [${lo}, ${hi}]`);
  }
});
