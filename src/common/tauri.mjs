'use strict';

/**
 * Tauri IPC 适配层:替代 Electron 的 preload 桥(window.reader / window.settings)。
 * 依赖 tauri.conf.json 的 app.withGlobalTauri: true。
 */

function tauri() {
  const t = window.__TAURI__;
  if (!t) throw new Error('window.__TAURI__ 不可用(检查 withGlobalTauri 配置)');
  return t;
}

/** invoke 包装:Rust Err(String) 会以 reject 传入,归一为 Error。 */
export async function invoke(cmd, args) {
  try {
    return await tauri().core.invoke(cmd, args);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** 事件订阅;返回取消订阅函数。payload 已由监听器解包。 */
export function listen(name, cb) {
  const p = tauri().event.listen(name, (e) => cb(e.payload));
  return () => p.then((un) => un());
}
