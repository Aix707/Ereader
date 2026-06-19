# Ereader

Ereader 是一款 Windows 本地阅读器 MVP，使用 Electron、React、Vite 和 TypeScript 构建。它面向本地小说与漫画阅读，支持导入 `txt`、`pdf`、`epub` 文件和图片文件夹，并把处理后的可阅读内容存入 SQLite 数据库。

## 功能概览

- 书架管理：导入文件、导入图片文件夹、搜索、最近阅读、继续阅读、删除与重建。
- 小说阅读：支持 TXT 段落阅读、EPUB 文本与插图阅读、PDF 页阅读。
- 漫画阅读：支持图片文件夹、漫画 PDF、漫画 EPUB，提供单页/双页、左右阅读方向、滚轮翻页、页码跳转和相邻页预加载。
- 阅读进度：自动保存每本书的阅读位置、阅读模式和偏好设置。
- 本地处理：导入后将章节、段落、插图、漫画页和 PDF 渲染页统一写入 SQLite。
- 诊断工具：检查数据库、资产数量、源文件状态、导入错误和缓存完整性。

## 技术栈

- 桌面壳：Electron
- 前端：React 18、Vite、TypeScript
- 数据库：better-sqlite3
- 文件处理：pdfjs-dist、sharp、@zip.js/zip.js、fast-xml-parser、node-html-parser、sanitize-html、chardet、iconv-lite
- 图标：lucide-react

## 快速开始

```powershell
npm ci
npm run dev
```

如果网络较慢，可以先切换 npm 镜像源：

```powershell
npm config set registry https://registry.npmmirror.com
npm ci
```

开发模式会先启动 Vite，再打开 Electron 窗口。

## 常用命令

```powershell
npm run dev
```

启动本地开发环境。

```powershell
npm run build
```

执行 TypeScript 检查并构建渲染进程产物。

```powershell
npm run doctor
```

检查 Electron 用户数据目录中的 `library.sqlite`，输出书籍、阅读单元、资产和诊断状态。

```powershell
npm run rebuild:native
```

为当前 Electron 版本重建 `better-sqlite3` native 依赖。

## 提交前检查

```powershell
npm run build
npm run doctor
npm audit --audit-level=moderate
git diff --check
```

`AGENTS.md` 是本地 Codex 协作说明，和 `dist/`、`node_modules/`、开发日志一样由 `.gitignore` 忽略，不作为 GitHub 提交内容。

## 打包与发布

```powershell
npm run package:win
```

生成未签名 Windows x64 NSIS 安装包，输出到 `release/`。安装包暂不做代码签名，因此 Windows 可能显示未知发布者提示。
本地打包脚本使用 npm 镜像源下载 Electron/electron-builder 二进制资源，并跳过 native rebuild；如果更换 Electron 或 native 依赖版本，先运行 `npm run rebuild:native`。
打包内容只包含应用代码、前端产物、图标和运行依赖；已导入并解析的书籍数据库仍位于用户数据目录，不会进入安装包。

GitHub Release 通过 tag 触发：

```powershell
git tag v0.1.0
git push origin main --tags
```

GitHub Actions 会在 Windows runner 上执行构建，清理同 tag 的旧 draft Release，再创建一个新的 draft Release。确认草稿内容和安装包后，再到 GitHub 页面手动发布。

## 数据存储

应用不复制原始书籍文件。导入时会读取源文件或源文件夹，处理后的阅读内容写入 SQLite：

```text
%APPDATA%\ereader\library.sqlite
```

数据库中的核心模型是：

- `books`：书籍元信息、源路径、格式、内容类型和导入状态。
- `renditions`：文本流或页面流。
- `reading_units`：章节、段落、HTML、插图、漫画页和 PDF 页面。
- `assets`：图片、插图和 PDF 渲染页 BLOB。
- `progress`、`preferences`、`diagnostics`、`import_jobs`：进度、偏好、诊断和导入任务。

阅读器通过 `ereader-asset://` 协议读取数据库资产，避免把处理后的图片散放到缓存目录。

## 项目结构

```text
src/                  React 渲染进程
src/components/       书架、阅读页、诊断页和窗口控件
src/components/readers/ 小说与漫画阅读器
src/lib/              前端共享工具
electron/             Electron 主进程、preload、数据库和导入器
scripts/              开发启动脚本和数据库诊断脚本
assets/               应用图标等静态资源
```

## 支持格式

| 格式 | 小说模式 | 漫画模式 | 说明 |
| --- | --- | --- | --- |
| TXT | 支持 | 不适用 | 自动检测编码，按段落和章节特征生成阅读单元。 |
| EPUB | 支持 | 支持 | 小说 EPUB 提取文本与插图；漫画 EPUB 提取页面或主图片。 |
| PDF | 支持 | 支持 | 导入时高倍率渲染为 WebP 页面资产。 |
| 图片文件夹 | 不适用 | 支持 | 支持常见图片格式，自然数字排序。 |

PDF 和 EPUB 可以在书架或阅读页切换小说/漫画内容类型。

## 调试建议

- 导入异常时先运行 `npm run doctor` 查看最近诊断记录。
- Native 依赖加载失败时运行 `npm run rebuild:native`。
- 大文件导入会进入 worker 导入队列，可在诊断页查看状态并重建单本书。
- 删除源文件后，已导入内容仍可阅读，但诊断会标记源文件缺失。

## 当前边界

- 目标平台是 Windows 桌面端。
- 不包含账号、云同步、批注、全文搜索、CBZ/CBR 支持。
- 原始源文件只用于来源追踪、缺失检测和重建，不写入数据库。
