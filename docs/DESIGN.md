# Thief Book 4.0 — 设计文档

本项目是 [marcoxiong/Thief-Book](https://github.com/marcoxiong/Thief-Book)（cteamx/Thief 的 fork）的完全重写。
原版：Electron 2 + electron-vue + Vue2 + element-ui + lowdb + axios 等 10 个运行时依赖，830 行单文件主进程。
重写版：**零运行时依赖**、无打包器（源码即产物）、现代 Electron + contextIsolation 沙箱。

## 范围

只保留：TXT 阅读、按书记忆进度、老板键、悬停显隐、hjkl/滚轮/点击翻页、章节跳转、最近书单。
删除：股票/网页/视频/PDF/TouchBar 模式、自动翻页、搜索页、任务栏标题模式。

## 目录

```
src/common/    纯逻辑，不依赖 electron，可单测
  book.js        解码(UTF-8/UTF-16/GB18030/Big5 自动，简繁打分消歧) / 章节识别 / 分页
  store.js       设置 + 阅读进度持久化 (userData/reader-store.json, 防抖原子写)
src/main/      主进程
  index.js       生命周期、托盘、右键菜单、IPC 接线
  library.js     当前书籍会话：打开/翻页/章节/进度保存
  reader-window.js  阅读条窗口：hover 轮询显隐、尺寸位置、老板键隐藏
  shortcuts.js   全局快捷键：老板键常驻 + 翻页键仅 hover 时注册
  settings-window.js  设置窗口（懒创建）
src/preload/   contextBridge，sandbox: true
src/renderer/  纯 HTML/CSS/JS，无框架无构建
  reader/        阅读条
  settings/      设置窗口
tests/         零依赖单测（node tests/run.js，支持关键字过滤）
  run.js         运行器：收集 *.test.js 的全局 test()
  book.test.js   编码 / 归一化 / 章节识别 / 折行加权 / 分页不变量
  store.test.js  设置校验 / 进度 / 持久化往返 / 损坏恢复 / 迁移
  library.test.js 书籍会话集成（打开/翻页/章节/跳转/落盘，不依赖 Electron）
```

## 编码识别

BOM(UTF-8/UTF-16) 优先，其后严格 UTF-8。GB18030 与 Big5 的字节流几乎总能**互相**“合法”
解码成乱码，try/catch 无法区分——两者都严格解码后按**常用汉字命中率**打分择优
（真实文本 25%+，跨编码乱码约 1%），平手偏向 GB18030。全部失败回退宽松 UTF-8。

## 行为规格

### 阅读条窗口
- 无边框、透明、置顶(`floating`)、`focusable: false`（永不抢焦点）、跳过任务栏、mac 隐藏 Dock 图标。
- 默认位置：主屏工作区底部居中、留 6px 边距；可拖拽（左侧把手或章节标题行），位置记忆。
- 拖拽为**手动实现**：`focusable: false` 窗口上 `-webkit-app-region` 不可靠——把手 mousedown 经 IPC
  通知主进程后以 16ms 轮询跟随光标（`setPosition`），mouseup 结束并落盘；30s 超时兜底防粘滞。
- 尺寸由设置推导：`width` 可配（默认 620），高度 = 行数×行高 + 章节行 + 进度行 + 内边距。

### 悬停显隐（hover 模式，默认开）
- 主进程 50ms 轮询 `screen.getCursorScreenPoint()`，判断是否在窗口边界（外扩 2px）内。
- 移入：`setIgnoreMouseEvents(false)`，通知渲染端淡入正文（180ms），注册 hjkl 翻页全局键。
- 移出：宽限 `hideDelayMs`（默认 300ms）后，正文淡出、`setIgnoreMouseEvents(true, {forward:true})`、注销翻页键。
- 常显模式（hover 模式关）：正文常驻显示，仅翻页键仍要求鼠标在窗口上。
- 关键点：窗口隐藏态是**完全透明 + 点击穿透**，但窗口本体保持 show，这样轮询检测和瞬时显示无需 show/hide 抖动；`backdrop-filter` 仅在可见态启用，避免隐藏时留下一块模糊。

### 老板键（默认 `CommandOrControl+Shift+B`，可改）
- 常驻全局快捷键 + 托盘左键 + 右键菜单项，三处触发同一逻辑。
- 按下：`win.hide()` 瞬间隐藏（hover 轮询挂起）；再按：`win.show()` 恢复原位原进度。

### 翻页
- 默认键位 j=下一页 k=上一页 l=下一章 h=上一章，均可改（任意 Electron accelerator，支持单键）。
- 仅在鼠标悬停于阅读条时注册生效，不干扰平时打字。
- 滚轮：向下=下一页，向上=上一页，180ms 防抖（`wheelPaging` 可关）。左键单击=下一页。
- 最后一页末尾追加"（完）"。

### 进度与书单
- 进度按**字符位置 charIndex** 记忆（原版按页码，改字号即失效——本版修复）。
- 每本书：`{path, name, charIndex, percent, updatedAt, addedAt}`，翻页防抖 500ms 落盘，退出前强制落盘。
- 启动时恢复上次书籍与位置；最近书单（按 updatedAt 排序）在设置窗口与右键菜单可达。

## 分页算法（book.js）

- 打开时归一化文本（\r\n→\n、去 BOM、**去文末空白**——否则末尾空行会排出空白尾页、丢失“（完）”标记），缓存全文与章节表。
- 章节从**章节起点**贪心排版，页界确定性：同一章内 `pageAt(charIndex)` 永远返回包含该字符的页，
  上一页/下一页 = 从章节起点重走一遍（章节数十 KB，亚毫秒级）。
- 每行宽度按全半角加权：全角=1 单位，半角=0.5 单位；`charsPerLine = floor(内容宽 / 字号)`。
- 页从起点起跳过前导空行；不足一章的尾部按剩余内容排。
- 章节识别：`第X[章节回卷集部篇]` / `序章|楔子|番外…` / `Chapter N` 行首匹配；开头连续紧邻(<80 字符)
  的标题行视为目录剔除——切点标题可能是正文第一章（目录紧贴正文的常见排版），只删到切点为止。

## IPC 契约（invoke/handle + 推送）

渲染端 → 主（`ipcRenderer.invoke`，preload 白名单封装）：

| channel | payload | 返回 |
|---|---|---|
| `reader:ready` | — | `{page, appearance, visible, hasBook}` |
| `reader:page` | `{dir: 1\|-1}` | `PageState` |
| `reader:chapter` | `{dir: 1\|-1}` | `PageState` |
| `reader:open` | — | `{opened, message?}` 打开文件对话框 |
| `reader:menu` | `{x, y}`（send） | — 右键菜单 |
| `reader:dragStart` / `reader:dragEnd` | —（send） | — 手动拖拽起止 |
| `settings:get` | — | `{settings, books, currentBook, bossConflict}` |
| `settings:set` | `{key, value}` | `{ok}` |
| `settings:setKeys` | `{next, prev, nextCh, prevCh, boss}` | `{ok, errors: {[k]: string}}` |
| `settings:openBook` | `{path}` | `{opened, message?}` |
| `settings:forgetBook` | `{path}` | `{ok}` |
| `settings:jump` | `{percent: 0-100}` | `{ok}` |
| `settings:pickBook` | — | `{path?}` 文件选择对话框 |
| `settings:probeKey` | `{accel}` | `{ok, reason?}` 探测快捷键可用性 |

主 → 渲染端（`webContents.send`，载荷即 preload 回调收到的值）：
- `push:page` `PageState`、`push:visible` `bool`、`push:appearance` `Appearance`、`push:books` `BookRow[]`

```
PageState  = { lines: string[], chapterTitle: string|null, percent: number,
               bookName: string, hasPrev: bool, hasNext: bool, isEnd: bool }
Appearance = { fontSize, lines, width, theme, bgColor, fgColor,
               showChapter, showProgress, hoverMode, wheelPaging }
BookRow    = { path, name, percent, updatedAt }
```

## 安全

`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、IPC 入参校验 + sender 校验、
不加载任何远程内容。

## 打包

`npm run dist:mac` → electron-builder 出 macOS arm64 无签名 zip（沙盒是 Linux，只能出 zip/dir，dmg 需 macOS）。
