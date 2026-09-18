# Thief Book — 设计文档

本项目是 [marcoxiong/Thief-Book](https://github.com/marcoxiong/Thief-Book)(cteamx/Thief 的 fork)的完全重写。
- 4.x:Electron,零运行时依赖——但内嵌整个 Chromium,产物 121MB。
- **5.x:Tauri 2**,系统 WebView + Rust 壳,产物约 10MB;界面/核心逻辑仍是零依赖的纯 HTML/CSS/JS(ES Module,无打包器)。

本文件描述 5.x 现行架构。4.x 的历史规格见 git 历史(docs/DESIGN.md@v4.0.1)。

## 范围

只保留:TXT 阅读、按书记忆进度、老板键、悬停显隐、hjkl/滚轮/点击翻页、章节跳转、最近书单。
删除:股票/网页/视频/PDF/TouchBar 模式、自动翻页、搜索页、任务栏标题模式。

## 目录

```
src/common/    纯 JS 逻辑(ESM,浏览器与 node 单测共用)
  book.mjs        解码(UTF-8/UTF-16/GB18030/Big5 自动,简繁打分消歧) / 章节识别 / 分页
  session.mjs     书籍会话:打开/翻页/章节/进度(IO 经注入的 backend)
  settings.mjs    设置校验/钳制(纯函数,设置窗口与单测共用)
  tauri.mjs       IPC 适配层:invoke/listen 封装
src/renderer/  纯 HTML/CSS/JS,无框架无构建
  reader/         阅读条(持书籍会话,事件驱动)
  settings/       设置窗口
src-tauri/     Rust 壳
  src/lib.rs       生命周期、单实例、ExitRequested 不退出
  src/reader.rs    阅读条窗口:几何公式、老板键、设置联动、手动拖拽
  src/hover.rs     16ms 轮询线程:悬停显隐(≈50ms) + 拖拽跟随(≈60fps)
  src/shortcuts.rs 老板键常驻 + 翻页键仅悬停期注册
  src/tray.rs      托盘左键切换 + 右键菜单(随 store 重建)
  src/store.rs     reader-store.json:默认值/损坏备份重建/Electron 目录迁移
  src/commands.rs  IPC 命令
tests/         零依赖单测(node tests/run.js)
```

## 职责划分

Rust 只做壳:窗口/托盘/全局快捷键/光标轮询/文件 IO。所有领域逻辑(编码、分页、设置校验)
在 webview 的 JS 中——与 4.x 相同的代码,同样的单测覆盖。

## 坐标体系(重要)

**一律逻辑像素**(与 CSS px 同语义)。macOS 的 CG 全局坐标(warp、CGEventSource、
`monitor_from_point`)本就是逻辑点,逻辑空间跨显示器统一。tao 框架的
`cursor_position()` 在 macOS 把逻辑坐标与主屏物理高度混算,Retina 下返回错误值,
故光标读取改用 `device_query`(macOS 即 CGEventSource 逻辑点;Windows/Linux 为物理像素,
按所在显示器缩放换算)。仅在 tauri API 边界换算:`outer_position÷scale`、
`set_position(Logical)`、Monitor 工作区(物理)÷scale。

## 行为规格

### 阅读条窗口
- 无边框、透明(`macos-private-api`)、置顶、`focused: false`(永不抢焦点)、跳过任务栏、mac 隐藏 Dock 图标(Accessory)。
- 默认位置:主屏工作区底部居中、留 6px 边距;把手/章节行手动拖拽(16ms 跟随,mouseup 结束,30s 兜底),位置记忆(逻辑像素)。
- 尺寸由设置推导:`width` 可配(默认 620),高度 = 行数×行高(1.55×字号)+ 章节行 22 + 进度行 19 + 内边距 18。
- 阅读条永不真正关闭(退出走托盘);所有窗口关闭也不退出(app.exit 才退出)。

### 悬停显隐(hover 模式,默认开)
- Rust 线程 16ms 节拍:拖拽时全程跟随;其余每 3 拍(≈50ms)做光标命中检测(边界外扩 2px)。
- **锁纪律(防死锁)**:轮询线程绝不持有 UiState/Doc 锁调用阻塞 API——窗口读写经 tao
  从非主线程发起时同步等待主线程,若主线程正等该锁即互等死锁(5.0 曾致"打开即卡死")。
  锁内只改内存状态,锁外做系统调用;进度落盘走轻量 `broadcast`(不做几何/托盘联动)。
- 移入:`set_ignore_cursor_events(false)`,事件通知渲染端淡入,注册 hjkl 翻页全局键。
- 移出:宽限 `hideDelayMs`(默认 300ms)后,`set_ignore_cursor_events(true)`、淡出、注销翻页键。
- 隐藏态 = 内容透明 + 点击穿透,窗口本体保持存在,轮询检测无需 show/hide 抖动。

### 老板键(默认 `CmdOrCtrl+Shift+B`,可改)
- 常驻全局快捷键 + 菜单项触发同一逻辑:整窗 hide/show,恢复时按 hoverMode 重置可见态。
- **托盘左键 = 浮现 3 秒**:无论老板键是否隐藏,正文显示 3 秒——到期鼠标恰在条上则交还
  悬停接管(必要时解除老板键隐藏),否则恢复原状(隐藏中的窗口重新隐藏)。浮现期间
  悬停转换与翻页键管理暂停;老板键手动切换会取消浮现。

### 翻页
- j/k 翻页、l/h 跳章(可改,单键/组合键);仅悬停期注册。
- 滚轮 180ms 防抖(`wheelPaging` 可关)、左键单击下一页;章节行是拖拽把手,点击不翻页。
- 最后一页末尾追加"(完)"。

### 进度与书单
- 进度按字符位置 charIndex 记忆,翻页防抖 500ms 由 JS 触发 `save_progress` 命令落盘;
  webview 隐藏/卸载时立即 flush。启动按 `resumeOnStart` 恢复上次书籍。
- 书单按 updatedAt 倒序,设置窗口与托盘菜单可达。

## 编码识别

BOM(UTF-8/UTF-16) 优先,其后严格 UTF-8。GB18030 与 Big5 的字节流几乎总能**互相**"合法"
解码成乱码,try/catch 无法区分——两者都严格解码后按**常用汉字命中率**打分择优
(真实文本 25%+,跨编码乱码约 1%),平手偏向 GB18030。全部失败回退宽松 UTF-8。

## 分页算法(book.mjs)

- 归一化(\r\n→\n、去 BOM、去文末空白——否则产生空白尾页、丢失"(完)"),缓存全文与章节表。
- 章节从**章节起点**贪心排版,页界确定性:`pageAt(charIndex)` 永远返回包含该字符的页。
- 每行宽度按全半角加权:全角=1 单位,半角=0.5 单位;`unitsPerLine = floor(内容宽 / 字号)`,
  内容宽 = width − 把手 22 − 内边距 20(与 reader.css 严格一致)。
- 章节识别:`第X[章节回卷集部篇]` / `序章|楔子|番外…` / `Chapter N` 行首匹配;开头连续紧邻
  (<80 字符)的标题行视为目录剔除,只删到切点(目录紧贴正文第一章时切点即第一章标题)。

## IPC 契约

渲染端 → 主(`invoke`,命令名 + JSON 参数):

| 命令 | 参数 | 返回 |
|---|---|---|
| `get_doc` | — | 完整 store 文档 |
| `reader_ready` | — | `{visible, hoverMode}` |
| `set_setting` | `{key, value}` | `null`(键白名单外则 Err) |
| `set_keys` | `{boss,next,prev,nextCh,prevCh}` | `{ok, errors, bossConflict}` |
| `open_book` | `{path}` | `{opened, message?}`(校验后发 `reader:open`) |
| `read_book` | `{path}` | 原始字节(>64MB 报错) |
| `pick_book` | — | 文件路径或 null |
| `remove_book` | `{path}` | `{ok}` |
| `save_progress` | `{path,name,charIndex,percent}` | — |
| `jump` | `{percent}` | `{ok}`(转发 `reader:jump`) |
| `probe_key` | `{accel}` | `{ok, reason?}` |
| `drag_begin` / `drag_end` | — | — 手动拖拽起止 |
| `show_settings` | — | — 打开/唤起/显示设置窗口 |
| `popup_menu` | — | — 在光标处弹出主菜单 |
| `quit_app` | — | — |

主 → 渲染端(`emit_to`,载荷即回调收到的值):
- `reader:visible` `bool`、`reader:page` `"next"|"prev"|"nextCh"|"prevCh"`、
  `reader:open` `{path}`、`reader:jump` `{percent}`、`doc:changed` 完整文档

任意文档变更后 Rust 统一联动:阅读条几何重排(底边中点锚定)、托盘菜单重建、老板键热应用、双窗口广播。

## 安全

- `contextIsolation` 由 Tauri 默认提供;CSP `default-src 'self' ipc: http://ipc.localhost`。
- IPC 命令入参校验(键白名单、路径可读性、64MB 上限);不加载任何远程内容。
- `withGlobalTauri` 暴露的核心 API 仅 invoke/listen,窗口控制全部在 Rust 侧。

## 存储格式(reader-store.json,v3)

```json
{ "version": 3,
  "settings": { bossKey, nextPageKey, prevPageKey, nextChapterKey, prevChapterKey,
                hoverMode, wheelPaging, hideDelayMs, fontSize, lines, width,
                theme, bgColor, fgColor, showChapter, showProgress, resumeOnStart },
  "books": { "<路径>": { path, name, charIndex, percent, updatedAt, addedAt } },
  "lastBookPath": null,
  "windowRect": { x, y, width, height } }   // 逻辑像素
```

默认值在 Rust(`store.rs::DEFAULTS_JSON`)与 JS(`settings.mjs::DEFAULT_SETTINGS`)两处镜像,需同步修改。
Electron 4.x 旧目录(`~/Library/Application Support/Thief Book`)首次运行自动迁移(丢 windowRect)。

## 调试

- `THIEF_DEBUG=1` 启动:主进程 stderr 输出悬停轮询轨迹与快捷键注册结果。
- macOS 悬停/拖拽自动验证:CDP 不可用(WKWebView),用 `osascript` JXA
  `CGWarpMouseCursorPosition` 移动真实光标 + 观察 stderr 轨迹;模拟键盘被辅助功能权限拦截,翻页需人工验证。

## 打包

`npx tauri build`(本机平台)/ `npm run build`。CI(推 v* 标签)构建:
macOS dmg(arm64+x64)、Windows nsis、Linux deb+AppImage,自动发布 Release,无签名。
