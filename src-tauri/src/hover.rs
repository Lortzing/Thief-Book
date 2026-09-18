//! 悬停轮询线程:16ms 基础节拍;拖拽时全程跟随(≈60fps),
//! 其余每 3 拍做一次光标命中检测(≈50ms,与 Electron 版一致)。
//!
//! 锁纪律(防死锁,2026-09 卡死事故的教训):**本线程绝不持有 UiState/Doc 锁
//! 调用任何会阻塞等待主线程的 API**(窗口读写、快捷键注册)。窗口操作经由
//! tao 从非主线程发起时会向主线程投递消息并同步等待——若此时主线程正等
//! 本线程持有的锁,即互等死锁。因此:锁内只改内存状态,锁外做系统调用。
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
const DRAG_MAX_MS: u64 = 30_000;  // 兜底:mouseup 丢失时不至于永久粘住光标

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

            let dragging = {
                let state = app.state::<Mutex<UiState>>();
                let ui = state.lock().unwrap();
                ui.dragging
            };
            if dragging {
                drag_step(&app);
            } else if beat % 3 == 0 {
                tick(&app);
            }
        }
    });
}

/// 拖拽跟随:短锁取状态,锁外移动窗口。
fn drag_step(app: &AppHandle) {
    let Some(win) = app.get_webview_window(READER_LABEL) else { return };
    let (offset, since) = {
        let state = app.state::<Mutex<UiState>>();
        let ui = state.lock().unwrap();
        (ui.drag_offset, ui.drag_since)
    };
    if let Some(since) = since {
        if since.elapsed().as_millis() as u64 > DRAG_MAX_MS {
            crate::reader::end_drag(app);
            return;
        }
    }
    if let Some((cx, cy)) = cursor_logical(app) {
        let _ = win.set_position(tauri::LogicalPosition::new(
            cx - offset.0,
            cy - offset.1,
        ));
    }
}

fn tick(app: &AppHandle) {
    // ---- 1. 短锁读运行态 ----
    let (boss_hidden, peek_until, keys_active) = {
        let state = app.state::<Mutex<UiState>>();
        let ui = state.lock().unwrap();
        (ui.boss_hidden, ui.peek_until, ui.keys_active)
    };

    // 纯老板键隐藏态(未浮现):不做窗口查询,只保证翻页键注销
    if boss_hidden && peek_until.is_none() {
        if keys_active {
            {
                let state = app.state::<Mutex<UiState>>();
                state.lock().unwrap().keys_active = false;
            }
            crate::shortcuts::set_page_keys(app, false);
        }
        return;
    }

    // ---- 2. 锁外做全部系统调用(窗口查询是阻塞的主线程往返) ----
    let Some(win) = app.get_webview_window(READER_LABEL) else { return };
    let s = with_doc(app, |doc| doc.snapshot());
    let Some((cx, cy)) = cursor_logical(app) else { return };
    let scale = match win.scale_factor() {
        Ok(v) => v,
        Err(_) => return,
    };
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
        return;
    };

    let m = ACTIVATE_MARGIN;
    let lx = pos.x as f64 / scale;
    let ly = pos.y as f64 / scale;
    let lw = size.width as f64 / scale;
    let lh = size.height as f64 / scale;
    let inside = cx >= lx - m && cx <= lx + lw + m && cy >= ly - m && cy <= ly + lh + m;

    if std::env::var_os("THIEF_DEBUG").is_some() {
        eprintln!(
            "[hover] cursor=({cx:.0},{cy:.0}) win=({lx:.0},{ly:.0},{lw:.0},{lh:.0}) inside={inside} peek={}",
            peek_until.is_some()
        );
    }

    // ---- 3a. 托盘浮现期:内容保持显示;到期恢复原状 ----
    if let Some(until) = peek_until {
        if Instant::now() < until {
            return; // 浮现中:悬停转换与键管理暂停
        }
        // 到期:清除浮现态
        {
            let state = app.state::<Mutex<UiState>>();
            state.lock().unwrap().peek_until = None;
        }
        if inside {
            // 鼠标恰在条上:交还常规悬停接管(老板键隐藏态一并解除)
            if boss_hidden {
                let state = app.state::<Mutex<UiState>>();
                state.lock().unwrap().boss_hidden = false;
            }
        } else {
            if s.hover_mode {
                {
                    let state = app.state::<Mutex<UiState>>();
                    state.lock().unwrap().visible = false;
                }
                crate::reader::apply_visible(app, false);
            }
            if boss_hidden {
                let _ = win.hide();
                if keys_active {
                    {
                        let state = app.state::<Mutex<UiState>>();
                        state.lock().unwrap().keys_active = false;
                    }
                    crate::shortcuts::set_page_keys(app, false);
                }
            }
        }
        return;
    }

    // ---- 3b. 常规悬停决策:短锁改内存,收集待执行动作 ----
    let mut show: Option<bool> = None;
    let mut keys: Option<bool> = None;
    {
        let state = app.state::<Mutex<UiState>>();
        let mut ui = state.lock().unwrap();
        if s.hover_mode {
            if inside {
                ui.left_at = None;
                if !ui.visible {
                    ui.visible = true;
                    show = Some(true);
                }
            } else if ui.visible {
                let left = *ui.left_at.get_or_insert_with(Instant::now);
                if left.elapsed() >= Duration::from_millis(s.hide_delay_ms) {
                    ui.visible = false;
                    ui.left_at = None;
                    show = Some(false);
                }
            }
        }
        if inside != ui.keys_active {
            ui.keys_active = inside;
            keys = Some(inside);
        }
    }

    // ---- 4. 锁外执行动作 ----
    if let Some(v) = show {
        crate::reader::apply_visible(app, v);
    }
    if let Some(k) = keys {
        crate::shortcuts::set_page_keys(app, k);
    }
}
