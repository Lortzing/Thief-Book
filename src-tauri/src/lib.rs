//! Thief Book 5.0 — Tauri 主程序。
//! 与 Electron 版(4.x)行为对齐:阅读条常驻、悬停显隐、老板键、手动拖拽、托盘菜单。
//! 书籍解码/分页/会话逻辑在阅读条 webview 的 JS(src/common)中,Rust 只做壳:
//! 窗口/托盘/快捷键/光标轮询/存储文件 IO。

mod commands;
mod hover;
mod reader;
mod shortcuts;
mod store;
mod tray;
mod ui;

use std::sync::Mutex;
use tauri::{Manager, RunEvent};

use ui::UiState;

pub const READER_LABEL: &str = "reader";
pub const SETTINGS_LABEL: &str = "settings";

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次启动:把可能被老板键隐藏的阅读条找回来
            if let Some(win) = app.get_webview_window(READER_LABEL) {
                let ui_state = app.state::<Mutex<UiState>>();
                let mut ui = ui_state.lock().unwrap();
                if ui.boss_hidden {
                    ui.boss_hidden = false;
                    let _ = win.show();
                    reader::apply_initial_visible(app, &mut ui);
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(Mutex::new(UiState::default()))
        .manage(Mutex::new(store::Doc::default()))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            {
                let doc_state = app.state::<Mutex<store::Doc>>();
                let mut doc = doc_state.lock().unwrap();
                doc.load(app.handle());
            }
            reader::create(app.handle())?;
            shortcuts::init(app.handle());
            tray::create(app.handle())?;
            hover::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_doc,
            commands::reader_ready,
            commands::set_setting,
            commands::set_keys,
            commands::open_book,
            commands::read_book,
            commands::pick_book,
            commands::remove_book,
            commands::save_progress,
            commands::jump,
            commands::probe_key,
            commands::drag_begin,
            commands::drag_end,
            commands::show_settings,
            commands::popup_menu,
            commands::quit_app,
        ])
        .on_window_event(|window, event| {
            // 阅读条永远不真正关闭,退出走托盘菜单;设置窗口正常关闭
            if window.label() == READER_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // 阅读条常驻:所有窗口关闭也不退出(app.exit 才退出)
            if let RunEvent::ExitRequested { code: None, api, .. } = event {
                api.prevent_exit();
            }
        });
}
