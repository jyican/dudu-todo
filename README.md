# 悬浮待办 (floating-todo)

一个悬浮在桌面、始终置顶的待办清单,数据全部存本地,**每 3 小时**对未完成项发一次系统通知。基于 Tauri 2,跨平台(macOS / Windows / Linux)。

## 功能

- 📌 无边框半透明悬浮窗,始终置顶,拖标题栏移动
- ➕ 随手添加:一句话 + 可选截止日期
- ✅ 待做 / 已完成两个分区,点圆圈切换,悬停出现删除
- ⏰ 后台每 3 小时把所有未完成项汇总成一条系统通知 —— **关掉窗口也照常提醒**
- 🗂 关闭窗口只是隐藏到系统托盘,从托盘菜单可「显示」或「退出」
- 💾 数据存本地 JSON,无账号、无云:
  - macOS: `~/Library/Application Support/com.andrew.floating-todo/todos.json`
  - Windows: `%APPDATA%\com.andrew.floating-todo\todos.json`
  - Linux: `~/.config/com.andrew.floating-todo/todos.json`

## 开发运行

```bash
pnpm install
pnpm tauri dev
```

测试通知时把间隔改短(秒):

```bash
TODO_INTERVAL_SECS=20 pnpm tauri dev
```

## 打包成可安装的 App

```bash
pnpm tauri build
```

产物在 `src-tauri/target/release/bundle/`(macOS 下是 `.app` 和 `.dmg`)。
macOS 出通用版(Intel+Apple Silicon)需:`rustup target add x86_64-apple-darwin` 后
`pnpm tauri build --target universal-apple-darwin`。

## 一次出 Windows + macOS(GitHub Actions)

Windows 安装包无法在 macOS 上交叉编译,用 CI 在各自系统上构建。
工作流在 `.github/workflows/release.yml`:

1. 把仓库推到 GitHub。
2. 打一个版本标签触发构建并发布到 Release(草稿):
   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```
3. CI 在 `windows-latest` 出 `.msi` / `.exe`,在 `macos-latest` 出通用版 `.dmg`,
   汇总到一个 GitHub Release。也可在 Actions 页面手动运行(产物作为 artifact 下载)。

## 自定义

- **提醒间隔**:`src-tauri/src/lib.rs` 里 `interval_secs()` 默认 `3 * 60 * 60`(3 小时)。
- **窗口大小 / 透明度 / 是否置顶**:`src-tauri/tauri.conf.json` 的 `app.windows`。
- **配色**:`src/styles.css` 顶部 `:root` 变量。

## 注意

- 首次运行 macOS 会弹通知授权,需在「系统设置 → 通知」允许「悬浮待办」,否则收不到提醒。
- 日常使用建议 `pnpm tauri build` 出 release 版双击运行;`dev` 模式只用于开发调试。
