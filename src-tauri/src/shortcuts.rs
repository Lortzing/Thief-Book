//! 全局快捷键:老板键常驻(可换绑),翻页键(hjkl)仅在悬停期间注册。

use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::store::with_doc;
use crate::READER_LABEL;

const PAGE_DIRS: [&str; 4] = ["next", "prev", "nextCh", "prevCh"];

/// 当前注册中的翻页 accelerator。
static PAGE_REG: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// 当前注册中的老板键。
static BOSS_REG: Mutex<Option<String>> = Mutex::new(None);

pub fn init(app: &AppHandle) {
    let boss = with_doc(app, |doc| doc.snapshot().boss_key);
    apply_boss_key(app, &boss);
}

pub fn apply_boss_key(app: &AppHandle, accel: &str) {
    let gs = app.global_shortcut();
    let mut cur = BOSS_REG.lock().unwrap();
    if cur.as_deref() == Some(accel) {
        return;
    }
    if let Some(old) = cur.take() {
        let _ = gs.unregister(old.as_str());
    }
    let registered = gs
        .on_shortcut(accel, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                // 插件在事件分发期间持有内部锁并同步调用本回调:回调里再调
                // register/unregister 会重入同一把锁自死锁。排队到主线程稍后执行。
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || crate::reader::toggle_boss(&app2));
            }
        })
        .is_ok();
    if registered {
        *cur = Some(accel.to_string());
    }
}

/// 快捷键变更统一投递到主线程执行:插件的事件分发在持锁状态下调用回调,
/// 回调或轮询线程直接调用 register/unregister 都可能形成锁环,排队执行彻底解环。
pub fn dispatch_set_page_keys(app: &AppHandle, active: bool) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || set_page_keys(&app2, active));
}

/// 翻页键开关(仅限主线程直接调用)。
pub fn set_page_keys(app: &AppHandle, active: bool) {
    let gs = app.global_shortcut();
    let mut reg = PAGE_REG.lock().unwrap();

    if active {
        let keys = with_doc(app, |doc| doc.snapshot().page_keys);
        for (i, accel) in keys.iter().enumerate() {
            let accel = accel.trim();
            if accel.is_empty() || reg.iter().any(|r| r == accel) {
                continue;
            }
            let dir = PAGE_DIRS[i];
            let ok = gs
                .on_shortcut(accel, move |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        app.emit_to(READER_LABEL, "reader:page", dir).ok();
                    }
                })
                .is_ok();
            if ok {
                reg.push(accel.to_string());
            }
            if std::env::var_os("THIEF_DEBUG").is_some() {
                eprintln!("[keys] 注册 {accel} => {ok}");
            }
        }
    } else {
        for accel in reg.drain(..) {
            let _ = gs.unregister(accel.as_str());
        }
    }
}

/// 设置窗口用:探测 accelerator 是否可用(已注册=自己占用自己,视为可用)。
pub fn probe(app: &AppHandle, accel: &str) -> Result<bool, String> {
    let gs = app.global_shortcut();
    if gs.is_registered(accel) {
        return Ok(true);
    }
    gs.register(accel).map_err(|e| e.to_string())?;
    let ok = gs.is_registered(accel);
    let _ = gs.unregister(accel);
    Ok(ok)
}
