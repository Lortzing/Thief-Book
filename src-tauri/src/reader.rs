//! 阅读条窗口:创建、几何(尺寸公式与 CSS 严格对应)、老板键、设置联动。
//!
//! 坐标体系:**一律逻辑像素**(与 Electron DIP、CSS px 同语义)。
//! 原因:tao 在 macOS 的 `cursor_position` 混算逻辑/物理单位(Retina 下返回错误值),
//! 而 CG 全局坐标(`monitor_from_point`、warp、CGEventSource)本就是逻辑点,
//! 逻辑空间跨显示器统一,是唯一不做单位换算也能自洽的空间。
//! 仅在 tauri API 边界换算:outer_position÷scale、set_position(Logical)、
//! Monitor 工作区(物理)÷scale。
//!
//! 锁纪律:窗口/事件 API 从非主线程调用会阻塞等待主线程响应,**绝不持
//! UiState/Doc 锁做这类调用**(与 hover 线程互等即死锁);锁只保护内存状态。

use serde_json::Value;
use std::sync::Mutex;
use tauri::Emitter;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::store::with_doc;
use crate::ui::UiState;
use crate::{READER_LABEL, SETTINGS_LABEL};

// 与 renderer/reader/reader.css 严格一致的尺寸常量(逻辑像素)
const PAD_TOP: f64 = 10.0;
const PAD_BOTTOM: f64 = 8.0;
const LINE_HEIGHT_FACTOR: f64 = 1.55;
const CHAPTER_H: f64 = 22.0;
const FOOTER_H: f64 = 19.0;
const BOTTOM_MARGIN: f64 = 6.0;

fn reader_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(READER_LABEL)
}

pub fn geometry(s: &crate::store::Snapshot) -> (f64, f64) {
    let line_h = (s.font_size * LINE_HEIGHT_FACTOR).round();
    let mut h = PAD_TOP + PAD_BOTTOM + s.lines * line_h;
    if s.show_chapter {
        h += CHAPTER_H;
    }
    if s.show_progress {
        h += FOOTER_H;
    }
    (s.width, h)
}

/// 逻辑点所在显示器的工作区(逻辑像素):(x, y, w, h)。
fn work_area_at(app: &AppHandle, lx: f64, ly: f64) -> (f64, f64, f64, f64) {
    let mon = app
        .monitor_from_point(lx, ly)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(m) = mon {
        let s = m.scale_factor();
        let wa = m.work_area();
        return (
            wa.position.x as f64 / s,
            wa.position.y as f64 / s,
            wa.size.width as f64 / s,
            wa.size.height as f64 / s,
        );
    }
    (0.0, 0.0, 1280.0, 800.0)
}

/// 把窗口矩形约束到某显示器工作区内(逻辑像素,至少完整可见)。
fn clamp_into_work_area(app: &AppHandle, x: f64, y: f64, w: f64, h: f64) -> (f64, f64) {
    let (wx, wy, ww, wh) = work_area_at(app, x + w / 2.0, y + h / 2.0);
    let w = w.min(ww);
    let h = h.min(wh);
    let x = x.clamp(wx, wx + ww - w);
    let y = y.clamp(wy, wy + wh - h);
    (x, y)
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let (s, saved_rect) =
        with_doc(app, |doc| (doc.snapshot(), doc.raw.get("windowRect").cloned()));
    let (w, h) = geometry(&s);

    // 初始位置(逻辑):记忆位置或主屏工作区底部居中
    let (x, y) = if let Some(Value::Object(rect)) = saved_rect {
        let rx = rect.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let ry = rect.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let rw = rect.get("width").and_then(|v| v.as_f64()).unwrap_or(w);
        let rh = rect.get("height").and_then(|v| v.as_f64()).unwrap_or(h);
        clamp_into_work_area(app, rx, ry, rw, rh)
    } else {
        let (wx, wy, ww, wh) = work_area_at(app, 0.0, 0.0);
        let x = wx + (ww - w) / 2.0;
        let y = wy + wh - h - BOTTOM_MARGIN;
        (x, y)
    };

    let win = WebviewWindowBuilder::new(
        app,
        READER_LABEL,
        WebviewUrl::App("renderer/reader/index.html".into()),
    )
    .title("Thief Book")
    .decorations(false)
    .transparent(true)
    // 显式全透明背景色:macOS 12+ 的 WKWebView 会在页面透明处垫
    // underPageBackgroundColor(默认系统底色),必须显式给透明值才真透
    .background_color(tauri::utils::config::Color(0, 0, 0, 0))
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .shadow(false)
    .focused(false)
    .inner_size(w, h)
    .position(x, y)
    .build()?;

    // 初始隐藏态:悬停模式下正文隐藏 + 点击穿透
    {
        let state = app.state::<Mutex<UiState>>();
        let mut ui = state.lock().unwrap();
        let _ = win.set_ignore_cursor_events(!s.hover_mode);
        ui.visible = !s.hover_mode;
    }
    Ok(())
}

/// 正文可见性的系统侧(点击穿透 + 通知渲染端)。仅主线程调用。
pub fn apply_visible(app: &AppHandle, visible: bool) {
    if let Some(win) = reader_window(app) {
        let _ = win.set_ignore_cursor_events(!visible);
    }
    app.emit_to(READER_LABEL, "reader:visible", visible).ok();
}

/// 轮询线程用的投递版:窗口操作与 wry eval 都涉及主线程限制,
/// 统一经事件循环异步执行(非主线程调用时为入队,不会内联)。
pub fn dispatch_apply_visible(app: &AppHandle, visible: bool) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || apply_visible(&app2, visible));
}

/// 按 hoverMode 应用初始可见态(二次启动唤起时)。
pub fn apply_initial_visible(app: &AppHandle) {
    let s = with_doc(app, |doc| doc.snapshot());
    let v = !s.hover_mode;
    {
        let state = app.state::<Mutex<UiState>>();
        state.lock().unwrap().visible = v;
    }
    apply_visible(app, v);
}

/// 托盘点击:阅读条带正文浮现 3 秒,不管老板键是否隐藏中
/// (隐藏中的窗口临时亮出,到期若无鼠标接管则重新隐藏)。
pub fn peek(app: &AppHandle) {
    let Some(win) = reader_window(app) else { return };
    let boss_hidden = {
        let state = app.state::<Mutex<UiState>>();
        let ui = state.lock().unwrap();
        ui.boss_hidden
    };
    if boss_hidden {
        let _ = win.show();
    }
    {
        let state = app.state::<Mutex<UiState>>();
        let mut ui = state.lock().unwrap();
        ui.peek_until = Some(std::time::Instant::now() + std::time::Duration::from_secs(3));
        ui.visible = true;
    }
    apply_visible(app, true);
}

/// 老板键切换。
pub fn toggle_boss(app: &AppHandle) {
    let s = with_doc(app, |doc| doc.snapshot());
    let Some(win) = reader_window(app) else { return };

    let (now_hidden, was_dragging) = {
        let state = app.state::<Mutex<UiState>>();
        let mut ui = state.lock().unwrap();
        let was_hidden = ui.boss_hidden;
        let dragging = ui.dragging;
        ui.dragging = false;
        ui.boss_hidden = !was_hidden;
        ui.left_at = None;
        ui.peek_until = None;
        (!was_hidden, dragging)
    };

    if now_hidden {
        // 注意:此处可能运行在热键回调(插件持锁分发 + run_on_main_thread 主线程
        // 内联执行)中,严禁调用任何快捷键 API——翻页键的注销由轮询线程的
        // boss-hidden 分支(异步投递到主线程)在 ~50ms 内完成。
        let _ = win.hide();
        if was_dragging {
            save_window_rect(app);
        }
    } else {
        let v = !s.hover_mode;
        {
            let state = app.state::<Mutex<UiState>>();
            state.lock().unwrap().visible = v;
        }
        let _ = win.show();
        apply_visible(app, v);
    }
}

/// 当前窗口逻辑矩形:(x, y, w, h)。
fn window_logical_rect(win: &tauri::WebviewWindow) -> Option<(f64, f64, f64, f64)> {
    let scale = win.scale_factor().unwrap_or(1.0);
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    Some((
        pos.x as f64 / scale,
        pos.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
    ))
}

/// 设置变化:底边中点锚定调整几何(Electron 同款,避免调宽度时条"漂走")。
pub fn apply_settings_changed(app: &AppHandle) {
    let Some(win) = reader_window(app) else { return };
    let s = with_doc(app, |doc| doc.snapshot());
    let (w, h) = geometry(&s);

    let Some((lx, ly, lw, lh)) = window_logical_rect(&win) else { return };
    let nx = lx + (lw - w) / 2.0;
    let ny = ly + (lh - h);
    let (nx, ny) = clamp_into_work_area(app, nx, ny, w, h);

    let _ = win.set_size(LogicalSize::new(w, h));
    let _ = win.set_position(LogicalPosition::new(nx, ny));

    // hoverMode 关→开 由轮询宽限后自然隐藏;开→关 需要立即显示
    if !s.hover_mode {
        let need_show = {
            let state = app.state::<Mutex<UiState>>();
            let mut ui = state.lock().unwrap();
            if !ui.visible {
                ui.visible = true;
                true
            } else {
                false
            }
        };
        if need_show {
            apply_visible(app, true);
        }
    }
}

/// 手动拖拽开始:16ms 跟随光标(逻辑像素)由 hover 线程执行,mouseup 结束。
pub fn begin_drag(app: &AppHandle) {
    let Some(win) = reader_window(app) else { return };
    let Some((lx, ly, _, _)) = window_logical_rect(&win) else { return };
    let Some((cx, cy)) = crate::hover::cursor_logical(app) else { return };
    let state = app.state::<Mutex<UiState>>();
    let mut ui = state.lock().unwrap();
    if ui.dragging || ui.boss_hidden {
        return;
    }
    ui.dragging = true;
    ui.drag_offset = (cx - lx, cy - ly);
    ui.drag_since = Some(std::time::Instant::now());
}

pub fn end_drag(app: &AppHandle) {
    let was_dragging = {
        let state = app.state::<Mutex<UiState>>();
        let mut ui = state.lock().unwrap();
        let was = ui.dragging;
        ui.dragging = false;
        ui.drag_since = None;
        was
    };
    if was_dragging {
        save_window_rect(app);
    }
}

/// 把当前窗口矩形(逻辑像素)写入 store。
pub fn save_window_rect(app: &AppHandle) {
    let Some(win) = reader_window(app) else { return };
    let Some((x, y, w, h)) = window_logical_rect(&win) else { return };
    with_doc(app, |doc| {
        doc.raw["windowRect"] = serde_json::json!({
            "x": x.round(), "y": y.round(),
            "width": w.round(), "height": h.round(),
        });
        doc.persist(app);
    });
}

/// 打开(或唤起)设置窗口。设置页面加载完成后会调用 show_settings 显示自身。
pub fn show_settings(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let result = WebviewWindowBuilder::new(
        app,
        SETTINGS_LABEL,
        WebviewUrl::App("renderer/settings/index.html".into()),
    )
    .title("设置 — Thief Book")
    .inner_size(480.0, 680.0)
    .min_inner_size(380.0, 420.0)
    .resizable(true)
    .maximizable(false)
    .fullscreen(false)
    .center()
    .visible(false)
    .build();
    if let Err(err) = result {
        eprintln!("[thief-book] 打开设置窗口失败: {err}");
    }
}
