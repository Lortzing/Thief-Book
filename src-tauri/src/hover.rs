//! 悬停轮询线程:16ms 基础节拍;拖拽时全程跟随(≈60fps),
//! 其余每 3 拍做一次光标命中检测(≈50ms,与 Electron 版一致)。
//!
//! 光标读取不使用 tauri 的 cursor_position——tao 在 macOS 的实现把逻辑坐标与
//! 主屏物理高度混算,Retina(缩放≠1)下返回错误值。改用 device_query:
//! macOS 下即 CGEventSource 的全局逻辑点(CG 坐标空间,主屏左上为原点)。

use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::store::with_doc;
use crate::ui::UiState;
use crate::READER_LABEL;

const DRAG_FOLLOW_MS: u64 = 16;
const ACTIVATE_MARGIN: f64 = 2.0; // 边界外扩(逻辑像素),更容易命中

/// 光标位置(逻辑像素)。
pub fn cursor_logical(app: &AppHandle) -> Option<(f64, f64)> {
    use device_query::{DeviceQuery, DeviceState};
    let (x, y) = DeviceState::new().get_mouse().coords;
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        Some((x as f64, y as f64))
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows/Linux 下 device_query 返回物理像素,按所在显示器缩放换算
        let m = app.monitor_from_point(x as f64, y as f64).ok().flatten()?;
        let s = m.scale_factor();
        Some((x as f64 / s, y as f64 / s))
    }
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut beat: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(DRAG_FOLLOW_MS));
            beat = beat.wrapping_add(1);

            let state = app.state::<Mutex<UiState>>();
            let mut ui = state.lock().unwrap();

            if ui.dragging {
                crate::reader::drag_tick(&app, &mut ui);
            } else if beat % 3 == 0 {
                tick(&app, &mut ui);
            }
        }
    });
}

fn tick(app: &AppHandle, ui: &mut UiState) {
    if ui.boss_hidden {
        if ui.keys_active {
            ui.keys_active = false;
            crate::shortcuts::set_page_keys(app, false);
        }
        return;
    }
    let Some(win) = app.get_webview_window(READER_LABEL) else { return };
    let s = with_doc(app, |doc| doc.snapshot());
    let Some((cx, cy)) = cursor_logical(app) else { return };
    let scale = win.scale_factor().unwrap_or(1.0);
    let Ok(pos) = win.outer_position() else { return };
    let Ok(size) = win.outer_size() else { return };

    let m = ACTIVATE_MARGIN;
    let lx = pos.x as f64 / scale;
    let ly = pos.y as f64 / scale;
    let lw = size.width as f64 / scale;
    let lh = size.height as f64 / scale;
    let inside = cx >= lx - m && cx <= lx + lw + m && cy >= ly - m && cy <= ly + lh + m;

    if std::env::var_os("THIEF_DEBUG").is_some() {
        eprintln!(
            "[hover] cursor=({cx:.0},{cy:.0}) win=({lx:.0},{ly:.0},{lw:.0},{lh:.0}) inside={inside} visible={}",
            ui.visible
        );
    }

    if s.hover_mode {
        if inside {
            ui.left_at = None;
            if !ui.visible {
                crate::reader::show_content(app, ui, true);
            }
        } else if ui.visible {
            let left = *ui.left_at.get_or_insert_with(Instant::now);
            if left.elapsed() >= Duration::from_millis(s.hide_delay_ms) {
                ui.left_at = None;
                crate::reader::show_content(app, ui, false);
            }
        }
    }

    // 翻页键只在鼠标悬停于阅读条上时生效(两种模式一致)
    if inside != ui.keys_active {
        ui.keys_active = inside;
        crate::shortcuts::set_page_keys(app, inside);
    }
}
