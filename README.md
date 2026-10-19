# Ereader

轻量 Windows 本地小说与漫画阅读器，使用 **Tauri 2、Rust、React 18、Vite 和 TypeScript**。系统共享 WebView2 承载界面，安装包不包含 Electron、Node 或独立 Chromium。

## 下载与安装

从 [GitHub Releases](https://github.com/Aix707/Ereader/releases) 下载 Windows x64 安装包或 `Ereader.exe` 免安装版。免安装版同样使用系统共享 WebView2 和当前用户书库，不将书库写入程序目录；缺少 WebView2 时建议使用安装包引导安装。`SHA256SUMS.txt` 提供安装包、免安装版和源码 ZIP 的 SHA-256。

**从 Electron 1.x 升级到 2.0.0 会重置旧书库、进度和设置，原始书籍保留，需要重新导入。已使用 Tauri 2.0.0 的本地版本再次安装时保留新版数据。**

## 功能

- TXT、PDF、EPUB、未加密 PalmDOC/MOBI，以及自然数字排序的图片文件夹；AZW/AZW3 沿用 MOBI 解析入口，并不支持所有 Kindle 编码或 DRM。
- 小说文本与插图、漫画单/双页、左右阅读方向、滚轮翻页、页码跳转、进度恢复。
- 书架搜索、最近/继续阅读、阅读统计、重建、取消、删除和高级维护诊断。
- 系统字体、排版、自定义背景、透明背景、无边框窗口、最大化与阅读全屏。
- 界面采用12、14、20px三档字号及统一32px控件；阅读正文字号可单独调整。阅读页用按钮或F11进入全屏，Esc先关闭弹层，再退出全屏；返回书架恢复原窗口状态。
- PDF 在导入时逐页全部渲染为图片。所有阅读内容及图片写入 SQLite，原始文件缺失后仍可阅读。

## 环境与开发

目标为 Windows 10/11 x64。需要 Node.js 24、MSVC C++ Build Tools、Windows SDK 和项目锁定的 Rust 工具链。WebView2 最低版本为 128；安装器在缺失或版本过低时尝试安装/更新共享 Evergreen Runtime，因此该步骤需要联网。

```powershell
rustup toolchain install 1.99.1 --profile minimal
npm ci
npm run dev
```

开发模式由 Tauri 启动 Vite (`127.0.0.1:5173`) 和原生窗口，不需要重建 Node 原生模块。运行依赖锁定在 `package-lock.json`、`src-tauri/Cargo.lock` 和 `rust-toolchain.toml`。

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动原生开发窗口和 Vite |
| `npm run build` | TypeScript 检查及前端生产构建 |
| `npm test` | TypeScript 与 Rust 回归测试 |
| `npm run test:desktop` | 构建调试应用，在真实 WebView2 中验证导入、任务生命周期及持久化 |
| `npm run test:ui` | 隔离书库中验证九组窗口尺寸/缩放、书卡状态、统计布局和原生窗口切换 |
| `npm run test:window` | 隔离样例验证普通／最大化进入全屏及恢复，并核对 Win32 内容区域覆盖完整显示器 |
| `npm run doctor` | 只读检查当前书库的资产引用、任务诊断和来源状态 |
| `npm run benchmark` | 在独立书库测量 140 本书、28,000 单元的数据访问 |
| `npm run package:win` | 生成 Release 程序及 Windows x64 NSIS 安装包，检查体积预算 |
| `npm run prepare:release` | 在干净提交上生成免安装版、源码 ZIP 与校验文件，并逐文件核对源码归档 |

安装包输出为 `release/Ereader-2.0.0-Setup-x64.exe`；体积记录为 `release/size-report.json`。预算为安装包 30 MiB、安装目录 80 MiB，系统共享 WebView2 与书库数据单独计量。程序体积与导入后的书库体积不同，预渲染 PDF 的资产仍会随页数增长。

## 实现与安全边界

- `src-tauri/`：Rust 原生能力、SQLite 仓储、串行数据库线程、导入队列、文件读取、系统字体、WIC TIFF 解码与安装配置。
- `src/`：React 界面和阅读器；`src/types.ts` 集中定义业务与平台契约。
- `src/import/`：独立隐藏导入 WebView 的格式模块；仅在导入时创建，空闲 30 秒后销毁。PDF.js 自带解析 Worker，页面在导入 WebView 的 Canvas 渲染。
- `scripts/`、`tests/fixtures/`：构建报告、回归测试和小型格式样例，不随程序交付。

文件系统只由 Rust 访问。导入器持有当前任务的受限来源索引，通过分段二进制 IPC 读取；WebP 也通过二进制 IPC 写入，不转换成 Base64 或 JSON 字节数组。原生拖放路径需要先由主进程登记，前端不能任意指定磁盘文件。

TXT 流式解码，保留 UTF-8/16/32、GBK/GB18030 等编码。EPUB 按 ZIP 条目读取，MOBI 按记录读取，图片及 PDF 逐页处理并释放。PDF Worker 内置 JPEG/JBIG2/JPX 解码，离线字体与 CMap 单独保留，不打包重复的独立解码包或源码映射。PDF 长边为 2800，普通图片长边最多 3200，背景最多 2400；动画图片和多页 TIFF 沿用首帧/首页策略。

HTML 使用 DOMPurify 严格标签白名单，移除所有属性；CSP 禁止外部脚本、框架和网络资源。每个窗口仅可调用对应的原生接口。

每次导入写入暂存 rendition，成功后才原子切换内容、阅读模式和版本。取消、删除、中断及来源变化会使旧任务失效，清理未完成资产。已有完整版本可继续阅读。资产 ID 不复用，避免图片缓存命中已经删除的旧内容。

书架按事件增量更新。漫画缩略图与长文本使用可视范围渲染，图片预加载受解码预算约束；进度保存不扫描来源。来源检查在刷新时执行并缓存 5 秒，完整性检查仅在高级维护或 doctor 中运行。

## 数据与此次升级

新版数据目录：

```text
%LOCALAPPDATA%\com.aix707.ereader\
  library.sqlite       书籍、阅读单元、图片 BLOB、进度、偏好与诊断
  webview\             WebView2 应用配置与缓存
  background.webp      自定义背景
  electron-reset-v2.json 一次性旧版清理记录
```

**此次 Electron → Tauri 升级从空书库开始**，清除旧书库、旧阅读进度、设置与已知应用缓存。原始书籍不会删除，需要重新导入。清理读取旧库的来源路径并保护这些原始文件/文件夹；保留清单先写入新目录，防止中途失败后丢失保护信息。以后的 Tauri 升级保留新版书库，不会再次重置。

NSIS 安装器依据旧版注册信息卸载 Electron，并沿用旧安装目录。只处理已识别的 Ereader 安装，不递归删除猜测路径。

测试或调试时必须使用隔离书库，设置该变量也会禁用旧版日常数据清理：

```powershell
$env:EREADER_USER_DATA_DIR = "D:\Ereader\output\migration\dev-data"
npm run dev
```

桌面回归脚本自动创建隔离目录，导入测试入口也要求来源处于指定测试目录。窗口尺寸与缩放测试入口同样要求隔离书库。这些入口仅编译进调试构建。导入报告保存在 `output/migration/desktop-report.json`，界面报告与截图位于 `output/playwright/ui-refresh/`，均不提交。界面缩放矩阵使用真实WebView2内容缩放，不修改Windows显示设置，也不能替代不同显示器的系统DPI测试。

窗口回归截图和 Win32 几何记录位于 `output/playwright/fullscreen/`。全屏检查比较实际内容区域与显示器的物理位置、宽高，覆盖从最大化点击全屏、F11、Esc 和返回书架；不能只用全屏状态标志判定成功。正式安装版可传 `--binary <exe> --library <output/ 下已关闭的隔离样例书库>`，脚本会复制样例后运行，不改写原样例或日常书库。

## 验证与交付

```powershell
npm run build
npm test
npm run test:desktop
npm run test:ui
npm run test:window
npm audit --audit-level=moderate
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

发布前提交已审核的源码，再执行 `npm run package:win` 和 `npm run prepare:release`。源码归档只包含该提交的 Git 文件，拒绝测试数据库、生成目录和疑似凭据。发布工作流执行回归并生成四项分发文件；tag 对应的正式版本已经发布时保留其资产，否则准备 draft Release。本地打包命令不上传或发布。体积与验收边界见 [验证记录](OPTIMIZATION.md)。

应用不包含账号、云同步、批注、全文搜索或 CBZ/CBR 支持。当前安装包未进行代码签名。
