'use strict';

/**
 * 设置校验/钳制(纯函数,设置窗口与单测共用)。
 * 持久化由 Rust 完成(src-tauri/src/store.rs 的 DEFAULTS_JSON 与此保持一致)。
 */

export const DEFAULT_SETTINGS = {
  bossKey: 'CommandOrCtrl+Shift+B',
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

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

// 数值型设置的安全范围
export const RANGES = {
  hideDelayMs: [50, 3000],
  fontSize: [9, 40],
  lines: [1, 6],
  width: [280, 1600],
};

export function clamp(key, value) {
  const r = RANGES[key];
  if (!r) return value;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS[key];
  return Math.min(r[1], Math.max(r[0], n));
}

export function sanitizeColor(value, fallback) {
  if (
    typeof value === 'string' &&
    /^(#[0-9a-fA-F]{3,8}|rgba?\(.+\))$/.test(value.trim())
  ) {
    return value.trim();
  }
  return fallback;
}

/** 完整的设置写入校验;非法值回退默认/原值。返回 null 表示无效请求。 */
export function sanitizeSetting(key, value, previous) {
  if (!SETTING_KEYS.includes(key)) return null;
  if (key in RANGES) return clamp(key, value);
  if (key === 'theme') {
    return ['light', 'dark', 'custom'].includes(value) ? value : DEFAULT_SETTINGS.theme;
  }
  if (key === 'bgColor') return sanitizeColor(value, previous);
  if (key === 'fgColor') return sanitizeColor(value, previous);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

export const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\(.+\))$/;
