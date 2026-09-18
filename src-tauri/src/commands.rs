//! IPC 命令:webview invoke 入口。校验入参 → 改 store → 联动(几何/托盘/快捷键/广播)。

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::{is_known_key, with_doc, with_ui};
use crate::READER_LABEL;

const MAX_BOOK_BYTES: u64 = 64 * 1024 * 1024;

#[tauri::command]
pub fn get_doc(app: AppHandle) -> Value {
    with_doc(&app, |doc| doc.raw.clone())
}

#[tauri::command]
pub fn reader_ready(app: AppHandle) -> Value {
    let visible = with_ui(&app, |ui| ui.visible);
    let hover_mode = with_doc(&app, |doc| doc.snapshot().hover_mode);
    json!({ "visible": visible, "hoverMode": hover_mode })
}

/// 设置写入(值校验由设置端 JS 完成,Rust 做键白名单)。公开给托盘菜单复用。
pub fn set_setting_value(app: &AppHandle, key: &str, value: Value) -> Result<(), String> {
    if !is_known_key(key) {
        return Err("unknown key".into());
    }
    with_doc(app, |doc| {
        doc.raw["settings"][key] = value;
        doc.persist(app);
    });
    crate::store::after_change(app);
    Ok(())
}

#[tauri::command]
pub fn set_setting(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    set_setting_value(&app, &key, value)
}

/// 键位批量保存:重复检查 + 逐项探测,全过才写入并热应用。
#[tauri::command]
pub fn set_keys(
    app: AppHandle,
    boss: String,
    next: String,
    prev: String,
    next_ch: String,
    prev_ch: String,
) -> Value {
    let keys = [
        ("boss", boss.trim().to_string()),
        ("next", next.trim().to_string()),
        ("prev", prev.trim().to_string()),
        ("nextCh", next_ch.trim().to_string()),
        ("prevCh", prev_ch.trim().to_string()),
    ];
    let mut errors: Vec<(String, String)> = vec![];
    for (name, accel) in &keys {
        if accel.is_empty() {
            errors.push((name.to_string(), "键位为空".into()));
        }
    }
    if errors.is_empty() {
        let mut seen: Vec<&str> = vec![];
        for (name, accel) in &keys {
            if seen.contains(&accel.as_str()) {
                errors.push((name.to_string(), "与其他键位重复".into()));
            } else {
                seen.push(accel);
            }
        }
    }
    if errors.is_empty() {
        for (name, accel) in &keys {
            match crate::shortcuts::probe(&app, accel) {
                Ok(true) => {}
                Ok(false) => errors.push((name.to_string(), "被其他应用占用".into())),
                Err(_) => errors.push((name.to_string(), "格式无效".into())),
            }
        }
    }
    if !errors.is_empty() {
        let map: Value = errors
            .into_iter()
            .map(|(k, v)| (k, json!(v)))
            .collect::<serde_json::Map<_, _>>()
            .into();
        return json!({ "ok": false, "errors": map });
    }

    let apply = [
        ("bossKey", keys[0].1.clone()),
        ("nextPageKey", keys[1].1.clone()),
        ("prevPageKey", keys[2].1.clone()),
        ("nextChapterKey", keys[3].1.clone()),
        ("prevChapterKey", keys[4].1.clone()),
    ];
    let boss_accel = keys[0].1.clone();
    with_doc(&app, |doc| {
        for (k, v) in &apply {
            doc.raw["settings"][k] = json!(v);
        }
        doc.persist(&app);
    });
    crate::store::after_change(&app);
    // 应用后确认老板键真实注册状态
    let boss_conflict = !with_doc(&app, |doc| doc.snapshot().boss_key == boss_accel);
    json!({ "ok": true, "errors": {}, "bossConflict": boss_conflict })
}

/// 校验并通知阅读条打开书籍。公开给托盘菜单复用。
pub fn open_book_path(app: &AppHandle, path: String) -> Value {
    let meta = std::fs::metadata(&path);
    let message = match meta {
        Err(_) => Some(format!("无法读取文件:{path}")),
        Ok(m) if m.is_dir() => Some(format!("不是文件:{path}")),
        Ok(m) if m.len() > MAX_BOOK_BYTES => Some("文件超过 64MB,不支持".to_string()),
        Ok(_) => None,
    };
    if let Some(message) = message {
        return json!({ "opened": false, "message": message });
    }
    app.emit_to(READER_LABEL, "reader:open", json!({ "path": path }))
        .ok();
    json!({ "opened": true, "message": null })
}

/// 读取书籍原始字节(阅读条 webview 解码/分页在 JS 中完成)。
#[tauri::command]
pub fn read_book(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path).map_err(|_| format!("无法读取文件:{path}"))?;
    if bytes.len() as u64 > MAX_BOOK_BYTES {
        return Err("文件超过 64MB,不支持".into());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn open_book(app: AppHandle, path: String) -> Value {
    open_book_path(&app, path)
}

#[tauri::command]
pub async fn pick_book(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let file = app
        .dialog()
        .file()
        .add_filter("文本文件", &["txt"])
        .add_filter("所有文件", &["*"])
        .blocking_pick_file();
    file.and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn remove_book(app: AppHandle, path: String) -> Value {
    with_doc(&app, |doc| {
        if let Some(books) = doc.raw["books"].as_object_mut() {
            books.remove(&path);
        }
        if doc.raw["lastBookPath"].as_str() == Some(path.as_str()) {
            let latest = latest_book_path(doc);
            doc.raw["lastBookPath"] = latest.map(|p| json!(p)).unwrap_or(Value::Null);
        }
        doc.persist(&app);
    });
    crate::store::after_change(&app);
    json!({ "ok": true })
}

fn latest_book_path(doc: &crate::store::Doc) -> Option<String> {
    let books = doc.raw.get("books")?.as_object()?;
    let mut best: Option<(f64, &str)> = None;
    for b in books.values() {
        let updated = b.get("updatedAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let path = b.get("path").and_then(|v| v.as_str())?;
        match best {
            Some((u, _)) if u >= updated => {}
            _ => best = Some((updated, path)),
        }
    }
    best.map(|(_, p)| p.to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn save_progress(
    app: AppHandle,
    path: String,
    name: String,
    char_index: f64,
    percent: f64,
) {
    with_doc(&app, |doc| {
        let added_at = doc
            .raw["books"]
            .get(&path)
            .and_then(|b| b.get("addedAt"))
            .and_then(|v| v.as_f64())
            .map(|v| json!(v))
            .unwrap_or_else(|| json!(now_ms()));
        let name = if name.is_empty() {
            std::path::Path::new(&path)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone())
        } else {
            name
        };
        doc.raw["books"][&path] = json!({
            "path": path,
            "name": name,
            "charIndex": (char_index.max(0.0).floor()) as u64,
            "percent": percent.clamp(0.0, 1.0),
            "updatedAt": now_ms(),
            "addedAt": added_at,
        });
        doc.raw["lastBookPath"] = json!(path);
        doc.persist(&app);
    });
    crate::store::after_change(&app);
}

#[tauri::command]
pub fn jump(app: AppHandle, percent: f64) -> Value {
    app.emit_to(READER_LABEL, "reader:jump", json!({ "percent": percent }))
        .ok();
    json!({ "ok": true })
}

#[tauri::command]
pub fn probe_key(app: AppHandle, accel: String) -> Value {
    match crate::shortcuts::probe(&app, accel.trim()) {
        Ok(true) => json!({ "ok": true, "reason": null }),
        Ok(false) => json!({ "ok": false, "reason": "被其他应用占用" }),
        Err(_) => json!({ "ok": false, "reason": "格式无效" }),
    }
}

#[tauri::command]
pub fn drag_begin(app: AppHandle) {
    crate::reader::begin_drag(&app);
}

#[tauri::command]
pub fn drag_end(app: AppHandle) {
    crate::reader::end_drag(&app);
}

#[tauri::command]
pub fn show_settings(app: AppHandle) {
    crate::reader::show_settings(&app);
}

#[tauri::command]
pub fn popup_menu(app: AppHandle) {
    use tauri::menu::ContextMenu;
    let Ok(menu) = crate::tray::build_menu_public(&app) else { return };
    // ContextMenu::popup 在光标位置弹出,即右键菜单位置(需要原生 Window)
    if let Some(w) = app.get_webview_window(READER_LABEL) {
        let _ = menu.popup(w.as_ref().window());
    }
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}
