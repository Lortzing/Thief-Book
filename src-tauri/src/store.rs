//! 设置 + 阅读进度持久化:single JSON(user_data/reader-store.json)。
//! 逻辑校验/钳制在设置窗口的 JS(src/common/settings.js)完成,Rust 只做
//! 透存 + 少量启动期恢复(损坏备份重建、Electron 旧目录迁移、默认值)。

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

use crate::ui::UiState;
use std::sync::Mutex;

/// 整个 store 文档。字段松散存放,快照按需解析(缺省回默认)。
#[derive(Default)]
pub struct Doc {
    pub raw: Value,
}

/// 与 src/common/settings.js 的 DEFAULT_SETTINGS 保持一致。
const DEFAULTS_JSON: &str = r##"{
  "bossKey": "CommandOrControl+Shift+B",
  "nextPageKey": "j",
  "prevPageKey": "k",
  "nextChapterKey": "l",
  "prevChapterKey": "h",
  "hoverMode": true,
  "wheelPaging": true,
  "hideDelayMs": 300,
  "fontSize": 15,
  "lines": 2,
  "width": 620,
  "theme": "light",
  "bgColor": "rgba(255, 255, 255, 0.8)",
  "fgColor": "#1d1d1f",
  "showChapter": true,
  "showProgress": true,
  "resumeOnStart": true
}"##;

const KNOWN_KEYS: &[&str] = &[
    "bossKey", "nextPageKey", "prevPageKey", "nextChapterKey", "prevChapterKey",
    "hoverMode", "wheelPaging", "hideDelayMs", "fontSize", "lines", "width",
    "theme", "bgColor", "fgColor", "showChapter", "showProgress", "resumeOnStart",
];

fn defaults() -> Value {
    json!({
        "version": 3,
        "settings": serde_json::from_str::<Value>(DEFAULTS_JSON).unwrap(),
        "books": {},
        "lastBookPath": null,
        "windowRect": null,
    })
}

fn store_path(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().expect("app data dir");
    dir.join("reader-store.json")
}

/// Electron 4.x 的 userData 目录(productName 命名),首次运行时迁移。
fn legacy_store_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| {
            PathBuf::from(h)
                .join("Library/Application Support")
                .join("Thief Book")
                .join("reader-store.json")
        })
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(|h| {
            PathBuf::from(h).join("Thief Book").join("reader-store.json")
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

impl Doc {
    pub fn load(&mut self, app: &AppHandle) {
        let path = store_path(app);
        if !path.exists() {
            // Electron 旧数据迁移(一次性拷贝;windowRect 是逻辑像素、与 Tauri 的
            // 物理像素单位不同,直接丢弃让窗口回默认位置,避免落到错误位置)
            if let Some(legacy) = legacy_store_path() {
                if legacy.exists() {
                    if let Ok(bytes) = fs::read(&legacy) {
                        if let Ok(mut v) = serde_json::from_slice::<Value>(&bytes) {
                            if let Some(obj) = v.as_object_mut() {
                                obj.insert("windowRect".into(), Value::Null);
                            }
                            let body = serde_json::to_vec(&v).unwrap_or_default();
                            let _ = fs::create_dir_all(path.parent().unwrap());
                            let _ = fs::write(&path, body);
                        }
                    }
                }
            }
        }

        let raw = match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(v) => v,
                Err(_) => {
                    // 损坏:备份后重建(与 Electron 版行为一致)
                    let backup = path.with_file_name(format!(
                        "reader-store.json.corrupt-{}",
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .unwrap_or(0)
                    ));
                    let _ = fs::copy(&path, &backup);
                    defaults()
                }
            },
            Err(_) => defaults(),
        };
        self.raw = normalize(raw);
    }

    pub fn persist(&self, app: &AppHandle) {
        let path = store_path(app);
        let tmp = path.with_extension("json.tmp");
        let body = serde_json::to_string_pretty(&self.raw).unwrap_or_default();
        if fs::write(&tmp, body).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }

    pub fn settings(&self) -> &Value {
        self.raw.get("settings").unwrap_or(&Value::Null)
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot::from_settings(self.settings())
    }
}

/// 仅向双窗口广播文档。进度落盘等高频路径使用(翻页 500ms 防抖),
/// 不做几何/托盘/快捷键联动——那些在主线程做窗口与菜单操作,热路径上
/// 既浪费又会加剧与轮询线程的锁竞争。
pub fn broadcast(app: &AppHandle) {
    let raw = with_doc(app, |doc| doc.raw.clone());
    app.emit_to(crate::READER_LABEL, "doc:changed", &raw).ok();
    app.emit_to(crate::SETTINGS_LABEL, "doc:changed", &raw).ok();
}

/// 任意 doc 变更后的联动:窗口几何/托盘菜单/老板键热应用 + 广播。
/// 必须在**不持有** Doc 锁时调用(内部会重新加锁)。
pub fn after_change(app: &AppHandle) {
    crate::reader::apply_settings_changed(app);
    crate::tray::rebuild(app);
    let boss = with_doc(app, |doc| {
        doc.settings()
            .get("bossKey")
            .and_then(|v| v.as_str())
            .unwrap_or("CommandOrControl+Shift+B")
            .to_string()
    });
    crate::shortcuts::apply_boss_key(app, &boss);
    let raw = with_doc(app, |doc| doc.raw.clone());
    app.emit_to(crate::READER_LABEL, "doc:changed", &raw).ok();
    app.emit_to(crate::SETTINGS_LABEL, "doc:changed", &raw).ok();
}

/// 补全缺失字段/坏值(仅结构性;数值范围的精细校验在设置端 JS)。
fn normalize(mut raw: Value) -> Value {
    let def = defaults();
    if !raw.is_object() {
        return def;
    }
    if raw.get("version") != Some(&json!(3)) && raw.get("version").and_then(|v| v.as_u64()) != Some(3) {
        raw["version"] = json!(3);
    }
    if !raw.get("settings").map(|s| s.is_object()).unwrap_or(false) {
        raw["settings"] = def["settings"].clone();
    }
    if !raw.get("books").map(|b| b.is_object()).unwrap_or(false) {
        raw["books"] = json!({});
    }
    raw
}

/// hover 轮询与窗口几何需要的设置子集(缺省回默认值)。
pub struct Snapshot {
    pub hover_mode: bool,
    pub hide_delay_ms: u64,
    pub width: f64,
    pub lines: f64,
    pub font_size: f64,
    pub show_chapter: bool,
    pub show_progress: bool,
    pub boss_key: String,
    pub page_keys: [String; 4], // next, prev, nextCh, prevCh
}

fn get_bool(v: &Value, key: &str, default: bool) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(default)
}

fn get_num(v: &Value, key: &str, default: f64) -> f64 {
    v.get(key).and_then(|x| x.as_f64()).unwrap_or(default)
}

fn get_str(v: &Value, key: &str, default: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(default)
        .to_string()
}

impl Snapshot {
    pub fn from_settings(v: &Value) -> Self {
        Snapshot {
            hover_mode: get_bool(v, "hoverMode", true),
            hide_delay_ms: get_num(v, "hideDelayMs", 300.0).clamp(50.0, 3000.0) as u64,
            width: get_num(v, "width", 620.0).clamp(280.0, 1600.0),
            lines: get_num(v, "lines", 2.0).clamp(1.0, 6.0),
            font_size: get_num(v, "fontSize", 15.0).clamp(9.0, 40.0),
            show_chapter: get_bool(v, "showChapter", true),
            show_progress: get_bool(v, "showProgress", true),
            boss_key: get_str(v, "bossKey", "CommandOrControl+Shift+B"),
            page_keys: [
                get_str(v, "nextPageKey", "j"),
                get_str(v, "prevPageKey", "k"),
                get_str(v, "nextChapterKey", "l"),
                get_str(v, "prevChapterKey", "h"),
            ],
        }
    }
}

/// 设置键是否可写(白名单)。
pub fn is_known_key(key: &str) -> bool {
    KNOWN_KEYS.contains(&key)
}

/// 供命令层使用的公共小助手。
pub fn with_doc<R>(app: &AppHandle, f: impl FnOnce(&mut Doc) -> R) -> R {
    let state = app.state::<Mutex<Doc>>();
    let mut doc = state.lock().unwrap();
    f(&mut doc)
}

pub fn with_ui<R>(app: &AppHandle, f: impl FnOnce(&mut UiState) -> R) -> R {
    let state = app.state::<Mutex<UiState>>();
    let mut ui = state.lock().unwrap();
    f(&mut ui)
}
