//! 托盘:左键老板键式切换,右键菜单。菜单随设置/书单变化重建。

use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;

use crate::store::with_doc;

const TRAY_ID: &str = "main";

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu_public(app)?;
    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .icon_as_template(true)
        .tooltip("Thief Book · 左键隐藏/显示,右键菜单")
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("缺省窗口图标缺失"),
        )
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::reader::peek(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn rebuild(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_menu_public(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

pub fn build_menu_public(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    use tauri::menu::IsMenuItem;

    let s = with_doc(app, |doc| doc.snapshot());
    let recents = recent_books(app);

    let page_next = MenuItem::with_id(app, "page:next", "下一页", true, None::<&str>)?;
    let page_prev = MenuItem::with_id(app, "page:prev", "上一页", true, None::<&str>)?;
    let page_next_ch = MenuItem::with_id(app, "page:nextCh", "下一章", true, None::<&str>)?;
    let page_prev_ch = MenuItem::with_id(app, "page:prevCh", "上一章", true, None::<&str>)?;
    let sep1 = tauri::menu::PredefinedMenuItem::separator(app)?;
    let open_item = MenuItem::with_id(app, "open", "打开小说…", true, None::<&str>)?;

    let recents_menu = if recents.is_empty() {
        let none = MenuItem::with_id(app, "recents:none", "暂无", false, None::<&str>)?;
        Submenu::with_id_and_items(app, "recents", "最近阅读", true, &[&none])?
    } else {
        let items: Vec<MenuItem<tauri::Wry>> = recents
            .iter()
            .map(|(path, name, percent)| {
                MenuItem::with_id(
                    app,
                    format!("recent:{path}"),
                    format!("{name}({percent}%)"),
                    true,
                    None::<&str>,
                )
            })
            .collect::<Result<_, _>>()?;
        let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items
            .iter()
            .map(|i| i as &dyn IsMenuItem<tauri::Wry>)
            .collect();
        Submenu::with_id_and_items(app, "recents", "最近阅读", true, &refs)?
    };

    let boss_hidden = crate::store::with_ui(app, |ui| ui.boss_hidden);
    let sep2 = tauri::menu::PredefinedMenuItem::separator(app)?;
    let boss_item = MenuItem::with_id(
        app,
        "boss",
        if boss_hidden {
            "显示阅读条"
        } else {
            "隐藏阅读条(老板键)"
        },
        true,
        None::<&str>,
    )?;
    let hover_item = CheckMenuItem::with_id(
        app,
        "hover-mode",
        "悬停显示正文",
        true,
        s.hover_mode,
        None::<&str>,
    )?;
    let settings_item = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let sep3 = tauri::menu::PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &page_next,
            &page_prev,
            &page_next_ch,
            &page_prev_ch,
            &sep1,
            &open_item,
            &recents_menu,
            &sep2,
            &boss_item,
            &hover_item,
            &settings_item,
            &sep3,
            &quit_item,
        ],
    )
}

/// 最近书单(按 updatedAt 倒序,取 6 本):(path, name, percent%)
fn recent_books(app: &AppHandle) -> Vec<(String, String, u32)> {
    let mut list = with_doc(app, |doc| {
        let books = doc
            .raw
            .get("books")
            .and_then(|b| b.as_object())
            .cloned()
            .unwrap_or_default();
        let mut v: Vec<(f64, String, String, f64)> = books
            .values()
            .filter_map(|b| {
                Some((
                    b.get("updatedAt").and_then(|x| x.as_f64())?,
                    b.get("path").and_then(|x| x.as_str())?.to_string(),
                    b.get("name")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                    b.get("percent").and_then(|x| x.as_f64()).unwrap_or(0.0),
                ))
            })
            .collect();
        v.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        v
    });
    list.truncate(6);
    list.into_iter()
        .map(|(_, path, name, percent)| (path, name, (percent * 100.0).round() as u32))
        .collect()
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref().to_string();
    match id.as_str() {
        "page:next" | "page:prev" | "page:nextCh" | "page:prevCh" => {
            let dir = id.trim_start_matches("page:");
            app.emit_to(crate::READER_LABEL, "reader:page", dir).ok();
        }
        "open" => {
            let app2 = app.clone();
            app.dialog()
                .file()
                .add_filter("文本文件", &["txt"])
                .add_filter("所有文件", &["*"])
                .pick_file(move |file| {
                    if let Some(path) = file.and_then(|f| f.into_path().ok()) {
                        let _ = crate::commands::open_book_path(
                            &app2,
                            path.to_string_lossy().into_owned(),
                        );
                    }
                });
        }
        "boss" => crate::reader::toggle_boss(app),
        "hover-mode" => {
            // 勾选态由菜单自绘,以 store 为准取反写回
            let cur = with_doc(app, |doc| doc.snapshot().hover_mode);
            let _ = crate::commands::set_setting_value(app, "hoverMode", serde_json::json!(!cur));
        }
        "settings" => crate::reader::show_settings(app),
        "quit" => app.exit(0),
        other => {
            if let Some(path) = other.strip_prefix("recent:") {
                let _ = crate::commands::open_book_path(app, path.to_string());
            }
        }
    }
}
