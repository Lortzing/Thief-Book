# Thief Book 4.0

极简摸鱼阅读器：一条贴在屏幕底部的透明阅读条，鼠标移过去才浮现，移开就隐身，老板键一键消失。

本仓库是 [cteamx/Thief-Book](https://github.com/cteamx/Thief-Book)（[marcoxiong](https://github.com/marcoxiong/Thief-Book) 的活跃 fork）的完全重写：**零运行时依赖、无打包器**（源码即产物）、现代 Electron 沙箱安全模型。设计文档见 [docs/DESIGN.md](docs/DESIGN.md)。

## 特性

- **悬停显隐** —— 平时完全透明、点击穿透；鼠标移到阅读条上，正文 180ms 淡入，移开（可调延迟）自动隐身。关闭后正文常显。
- **老板键** —— `⌘/Ctrl + Shift + B` 一键隐藏整条窗口，再按恢复原位原进度。托盘左键同效。
- **hjkl 翻页** —— `j`/`k` 翻页、`l`/`h` 跳章，仅在鼠标悬停于阅读条时生效，绝不干扰打字。滚轮、左键单击同样翻页。键位全部可改。
- **进度记忆** —— 按**字符位置**记忆每本书的进度（改字号/宽度后仍对齐），翻页防抖落盘，启动自动恢复；最近书单随时可达。
- **编码自动识别** —— UTF-8 / UTF-16 / GB18030(GBK) / Big5 全自动，简繁皆宜，无需手动勾“乱码”。
- **确定性分页** —— 章节感知的贪心排版，页界可复现；最后一页自动标记“（完）”。

## 快速开始

```bash
npm install
npm start
```

需要 Node.js ≥ 18。macOS 上启动后 Dock 不出现图标，从**托盘**（屏幕右上角）右键打开菜单与设置。

## 使用

| 动作 | 效果 |
|---|---|
| 鼠标移到阅读条上 | 正文淡入、翻页键接通 |
| 鼠标移开 | 正文淡出、点击穿透 |
| `j` / `k` | 下一页 / 上一页（默认键位） |
| `l` / `h` | 下一章 / 上一章 |
| 滚轮 / 左键单击 | 下翻 / 上翻（滚轮可在设置中关闭） |
| `⌘/Ctrl + Shift + B` | 老板键：整条隐藏 / 恢复 |
| 左侧把手拖动 | 调整位置（记忆） |
| 右键 | 菜单：翻页 / 打开 / 最近阅读 / 设置 / 退出 |

所有键位可在设置窗口录制修改（支持单键与组合键，实时检测冲突）。

## 数据

设置与全部书籍进度保存在单一文件：

- macOS: `~/Library/Application Support/Thief Book/reader-store.json`
- Windows: `%APPDATA%/Thief Book/reader-store.json`

JSON 损坏会自动备份重建，不会丢失到打不开。

## 常见问题

- **打开是乱码？** 4.0 全自动识别编码（UTF-8 / UTF-16 / GBK / Big5），一般无需处理；极冷门编码请先转 UTF-8。
- **老板键没反应？** 多半被其他软件占用，设置 → 键位 → 点“老板键”重新录制，会实时提示冲突。
- **翻页键打字时干扰输入？** 不会——翻页键只在鼠标悬停于阅读条上时注册，移开即注销。

## 与 3.x 的差异

砍掉了股票、网页、视频、PDF、TouchBar、任务栏标题、自动翻页与搜索页，只做一件事：安静地看 TXT。运行时依赖从 10 个降到 **0 个**。

## 开发

```bash
npm test        # 零依赖单测（编码 / 分页 / 章节识别 / 持久化 / 书籍会话，49 个用例）
npm start       # 运行
npm run dist:mac  # 打包 macOS arm64 zip（无签名）
```

## 致谢

- 原版 [cteamx/Thief-Book](https://github.com/cteamx/Thief-Book) 与 [marcoxiong](https://github.com/marcoxiong/Thief-Book) 的维护
- VSCode 插件版：[Thief-Book-VSCode](https://github.com/cteamx/Thief-Book-VSCode)

## License

MIT
