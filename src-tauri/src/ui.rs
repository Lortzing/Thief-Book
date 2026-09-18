//! UI 运行态(悬停/拖拽/老板键),hover 轮询线程与菜单/快捷键回调共享。

use std::time::Instant;

#[derive(Default)]
pub struct UiState {
    /// 阅读条正文是否处于显示态
    pub visible: bool,
    /// 光标离开条的时刻(hideDelayMs 宽限起点)
    pub left_at: Option<Instant>,
    /// 翻页全局快捷键当前是否注册(注册表由 shortcuts 模块自行维护)
    pub keys_active: bool,
    /// 老板键隐藏中
    pub boss_hidden: bool,
    /// 托盘点击的浮现截止时刻(内容保持显示,到期恢复原状)
    pub peek_until: Option<Instant>,
    /// 手动拖拽进行中
    pub dragging: bool,
    /// 拖拽抓取偏移(逻辑像素)
    pub drag_offset: (f64, f64),
    /// 拖拽开始时刻(30s 兜底)
    pub drag_since: Option<Instant>,
}
