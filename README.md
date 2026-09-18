# Thief Book

极简摸鱼阅读器:一条贴在屏幕底部的透明阅读条,鼠标移过去才浮现,移开就隐身,老板键一键消失。

本仓库是 [cteamx/Thief-Book](https://github.com/cteamx/Thief-Book) 的完全重写。**5.0 起基于 [Tauri 2](https://tauri.app)**——用操作系统自带的 WebView(macOS WebKit / Windows WebView2 / Linux webkit2gtk)替代 Electron 内嵌的整个 Chromium,安装包从 **121MB 降到约 10MB**。界面与核心逻辑为纯 HTML/CSS/JS + ES Module,零前端依赖、零打包器。设计文档见 [docs/DESIGN.md](docs/DESIGN.md)。

## 特性

- **悬停显隐** —— 平时完全透明、点击穿透;鼠标移到阅读条上,正文淡入,移开(可调延迟)自动隐身。关闭后正文常显。
- **老板键** —— `⌘/Ctrl + Shift + B` 一键隐藏整条窗口,再按恢复原位原进度。托盘左键让阅读条**浮现 3 秒**(老板键隐藏中也可偷看,看完自动缩回)。
- **hjkl 翻页** —— `j`/`k` 翻页、`l`/`h` 跳章,仅在鼠标悬停于阅读条时生效,绝不干扰打字。滚轮、左键单击同样翻页(滚轮可在设置关闭)。键位全部可改。
- **进度记忆** —— 按**字符位置**记忆每本书的进度(改字号/宽度后仍对齐),翻页防抖落盘,启动自动恢复;最近书单随时可达。
- **编码自动识别** —— UTF-8 / UTF-16 / GB18030(GBK) / Big5 全自动,简繁皆宜,无需手动勾"乱码"。
- **确定性分页** —— 章节感知的贪心排版,页界可复现;最后一页自动标记"(完)"。
- **体积极小** —— 约 10MB,内存占用低。

## 快速开始

```bash
npm install
npm run dev
```

需要 Node.js ≥ 22 与 [Rust 工具链](https://tauri.app/start/prerequisites/)(macOS 另需 Xcode Command Line Tools)。macOS 上启动后 Dock 不出现图标,从**托盘**(屏幕右上角)右键打开菜单与设置。

## 使用

| 动作 | 效果 |
|---|---|
| 鼠标移到阅读条上 | 正文淡入、翻页键接通 |
| 鼠标移开 | 正文淡出、点击穿透 |
| `j` / `k` | 下一页 / 上一页(默认键位) |
| `l` / `h` | 下一章 / 上一章 |
| 滚轮 / 左键单击 | 下翻 / 上翻(滚轮可在设置中关闭) |
| `⌘/Ctrl + Shift + B` | 老板键:整条隐藏 / 恢复 |
| 托盘左键 | 阅读条浮现 3 秒(隐藏中也可偷看) |
| 左侧把手或章节行拖动 | 调整位置(记忆) |
| 右键 | 菜单:翻页 / 打开 / 最近阅读 / 设置 / 退出 |

所有键位可在设置窗口录制修改(支持单键与组合键,实时检测冲突)。

## 数据

设置与全部书籍进度保存在单一 JSON:

- macOS: `~/Library/Application Support/c.team.thief-book/reader-store.json`
- Windows: `%APPDATA%\c.team.thief-book\reader-store.json`

首次运行会自动迁移 Electron 4.x 旧版数据(书籍与进度保留,窗口位置因坐标单位不同重置)。JSON 损坏会自动备份重建。

## 常见问题

- **打开是乱码?** 编码全自动识别(UTF-8 / UTF-16 / GBK / Big5),一般无需处理;极冷门编码请先转 UTF-8。
- **老板键没反应?** 多半被其他软件占用,设置 → 键位 → 点"老板键"重新录制,会实时提示冲突。
- **翻页键打字时干扰输入?** 不会——翻页键只在鼠标悬停于阅读条上时注册,移开即注销。

## 开发

```bash
npm test          # 42 个零依赖单测(编码 / 分页 / 章节识别 / 书籍会话 / 设置校验)
npm run dev       # 开发模式运行
npm run build     # 打包当前平台产物
```

调试悬停/快捷键:`THIEF_DEBUG=1 npm run dev` 会在主进程 stderr 输出轮询轨迹。

发版:改版本号(package.json / tauri.conf.json / Cargo.toml 三处)→ 提交 → `git tag vX.Y.Z && git push origin vX.Y.Z`,CI 自动构建三平台并发布 Release。

## 致谢

- 原版 [cteamx/Thief-Book](https://github.com/cteamx/Thief-Book) 与 [marcoxiong](https://github.com/marcoxiong/Thief-Book) 的维护
- VSCode 插件版:[Thief-Book-VSCode](https://github.com/cteamx/Thief-Book-VSCode)

## License

MIT
