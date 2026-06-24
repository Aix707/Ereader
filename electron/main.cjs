const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const sharp = require("sharp");
const { createRepository } = require("./database.cjs");
const { detectContentType } = require("./content-detector.cjs");
const { imageFilesInFolder } = require("./importer.cjs");
const { createWorkerImporter } = require("./import-worker-client.cjs");

const FILE_FORMATS = new Map([
  [".txt", "txt"],
  [".pdf", "pdf"],
  [".epub", "epub"],
  [".mobi", "mobi"],
  [".azw", "mobi"],
  [".azw3", "mobi"]
]);

let mainWindow;
let repo;
let importer;
const APP_ICON = path.join(__dirname, "..", "assets", "app-icon.png");
const FONT_REGISTRY_KEYS = [
  "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
  "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"
];
const FALLBACK_FONTS = ["serif", "system-ui", "SimSun", "Microsoft YaHei", "KaiTi", "SimHei"];
const BACKGROUND_MAX_EDGE = 2400;
const BACKGROUND_FILE = "home-background.webp";
let fontCache = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "ereader-asset",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  },
  {
    scheme: "ereader-background",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
]);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 660,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    icon: APP_ICON,
    title: "Ereader",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  Menu.setApplicationMenu(null);

  mainWindow.on("maximize", sendWindowState);
  mainWindow.on("unmaximize", sendWindowState);
  mainWindow.on("enter-full-screen", sendWindowState);
  mainWindow.on("leave-full-screen", sendWindowState);

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

function sendWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("window:stateChanged", windowState());
}

function windowState() {
  return {
    isMaximized: Boolean(mainWindow?.isMaximized()),
    isFullScreen: Boolean(mainWindow?.isFullScreen())
  };
}

function listSystemFonts() {
  if (fontCache) return fontCache;
  const systemNames = new Set();
  for (const key of FONT_REGISTRY_KEYS) {
    try {
      const output = execFileSync("reg", ["query", key], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 2500
      });
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^\s{2,}(.+?)\s+REG_\w+\s+(.+)$/);
        if (!match) continue;
        for (const family of fontFamiliesFromRegistryName(match[1])) {
          systemNames.add(family);
        }
      }
    } catch {
      // Registry access can fail on unusual Windows installs; font folder fallback handles that.
    }
  }

  try {
    const fontDir = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");
    for (const entry of fs.readdirSync(fontDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(ttf|ttc|otf)$/i.test(entry.name)) continue;
      const family = path.basename(entry.name, path.extname(entry.name)).replace(/[_-]+/g, " ").trim();
      if (family) systemNames.add(family);
    }
  } catch {
    // Ignore fallback failures and rely on the static list below.
  }

  const preferred = ["Microsoft YaHei", "Microsoft YaHei UI", "SimSun", "SimHei", "KaiTi", "DengXian", "FangSong"];
  const orderedSystem = [
    ...preferred.filter((family) => systemNames.has(family)),
    ...[...systemNames].sort((left, right) => left.localeCompare(right, "zh-CN"))
  ];
  const seen = new Set();
  const fonts = [];
  for (const family of FALLBACK_FONTS) {
    const normalized = normalizeFontFamilyName(family);
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    fonts.push({ family: normalized, source: "fallback" });
  }
  for (const family of orderedSystem) {
    const normalized = normalizeFontFamilyName(family);
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    fonts.push({ family: normalized, source: "system" });
  }
  fontCache = fonts;
  return fontCache;
}

function fontFamiliesFromRegistryName(value) {
  const clean = normalizeFontFamilyName(
    String(value || "")
      .replace(/\s*\((TrueType|OpenType|Type 1|Raster)\)\s*$/i, "")
      .replace(/\s*\([^)]+\)\s*$/g, "")
  );
  if (!clean) return [];
  return clean
    .split(/\s*&\s*/)
    .map(normalizeFontFamilyName)
    .filter(Boolean);
}

function normalizeFontFamilyName(value) {
  return String(value || "").replace(/[\u0000-\u001f;"{}]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function backgroundDir() {
  return path.join(app.getPath("userData"), "background");
}

function backgroundPath() {
  return path.join(backgroundDir(), BACKGROUND_FILE);
}

function backgroundVersion(settings = repo.getAppSettings()) {
  return Number(settings.appearance?.backgroundImageVersion || 0);
}

function appSettingsWithValidBackground() {
  const settings = repo.getAppSettings();
  if (settings.appearance.backgroundLayerMode !== "image") return settings;
  if (fs.existsSync(backgroundPath())) return settings;
  return repo.updateAppSettings({
    appearance: {
      ...settings.appearance,
      backgroundLayerMode: "default"
    }
  });
}

async function chooseBackgroundImage() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择背景图片",
    properties: ["openFile"],
    filters: [
      { name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "avif", "bmp", "gif", "tif", "tiff"] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return appSettingsWithValidBackground();

  fs.mkdirSync(backgroundDir(), { recursive: true });
  const buffer = await sharp(result.filePaths[0], { animated: false })
    .rotate()
    .resize({
      width: BACKGROUND_MAX_EDGE,
      height: BACKGROUND_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true
    })
    .webp({ quality: 88, effort: 4 })
    .toBuffer();
  fs.writeFileSync(backgroundPath(), buffer);

  const current = repo.getAppSettings();
  return repo.updateAppSettings({
    appearance: {
      ...current.appearance,
      backgroundLayerMode: "image",
      backgroundImageVersion: backgroundVersion(current) + 1
    }
  });
}

function resetBackground() {
  const current = repo.getAppSettings();
  return repo.updateAppSettings({
    appearance: {
      ...current.appearance,
      backgroundLayerMode: "default"
    }
  });
}

function removeBackground() {
  const current = repo.getAppSettings();
  try {
    if (fs.existsSync(backgroundPath())) fs.unlinkSync(backgroundPath());
  } catch {
    // The mode change still makes the background invisible even if cleanup fails.
  }
  return repo.updateAppSettings({
    appearance: {
      ...current.appearance,
      backgroundLayerMode: "none"
    }
  });
}

function registerAssetProtocol() {
  protocol.handle("ereader-asset", async (request) => {
    try {
      const url = new URL(request.url);
      const assetId = Number(url.hostname === "asset" ? url.pathname.slice(1) : url.hostname);
      if (!Number.isSafeInteger(assetId) || assetId <= 0) {
        return new Response("Invalid asset id", { status: 400 });
      }
      const asset = repo.getAsset(assetId);
      if (!asset) return new Response("Asset not found", { status: 404 });
      const etag = `"asset-${asset.id}-${asset.data.length}"`;
      if (request.headers.get("if-none-match") === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            "Cache-Control": "public, max-age=31536000, immutable",
            ETag: etag
          }
        });
      }
      return new Response(asset.data, {
        headers: {
          "Content-Type": asset.mime,
          "Cache-Control": "public, max-age=31536000, immutable",
          ETag: etag,
          "Content-Length": String(asset.data.length)
        }
      });
    } catch (error) {
      return new Response(String(error?.message || error), { status: 500 });
    }
  });
}

function registerBackgroundProtocol() {
  protocol.handle("ereader-background", async () => {
    try {
      const filePath = backgroundPath();
      if (!fs.existsSync(filePath)) return new Response("Background not found", { status: 404 });
      const data = fs.readFileSync(filePath);
      const etag = `"home-background-${data.length}-${Math.floor(fs.statSync(filePath).mtimeMs)}"`;
      return new Response(data, {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": "public, max-age=31536000, immutable",
          ETag: etag,
          "Content-Length": String(data.length)
        }
      });
    } catch (error) {
      return new Response(String(error?.message || error), { status: 500 });
    }
  });
}

app.whenReady().then(() => {
  app.setAppUserModelId("local.ereader");
  repo = createRepository(app.getPath("userData"));
  repo.migrateFromJson(path.join(app.getPath("userData"), "library.json"));
  importer = createWorkerImporter(app.getPath("userData"), repo, {
    onStateChanged(message) {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("import:stateChanged", message);
    }
  });
  registerAssetProtocol();
  registerBackgroundProtocol();
  createWindow();
  importer.enqueueMany(repo.booksNeedingImport());
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  importer?.dispose?.();
});

function makeId(absPath) {
  return crypto
    .createHash("sha1")
    .update(path.normalize(absPath).toLowerCase())
    .digest("hex")
    .slice(0, 20);
}

function inferFileFormat(filePath) {
  return FILE_FORMATS.get(path.extname(filePath).toLowerCase()) || null;
}

function titleFromPath(absPath, format) {
  const base = path.basename(absPath);
  return format === "image-folder" ? base : base.replace(path.extname(base), "");
}

async function makeBook(absPath, kind, format) {
  const id = makeId(absPath);
  const existing = repo.getRawBook(id);
  const contentType = existing?.content_type || await detectContentType(absPath, kind, format);
  return repo.upsertBook({
    id,
    title: titleFromPath(absPath, format),
    path: absPath,
    kind,
    format,
    contentType
  });
}

async function scanFolderForBooks(folderPath) {
  const books = [];
  if (imageFilesInFolder(folderPath).length > 0) {
    books.push(await makeBook(folderPath, "folder", "image-folder"));
  }

  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = path.join(folderPath, entry.name);
    if (entry.isFile()) {
      const format = inferFileFormat(absPath);
      if (format) books.push(await makeBook(absPath, "file", format));
    } else if (entry.isDirectory() && imageFilesInFolder(absPath).length > 0) {
      books.push(await makeBook(absPath, "folder", "image-folder"));
    }
  }
  return books;
}

async function importPaths(rawPaths) {
  const imported = [];
  const seen = new Set();
  for (const rawPath of Array.isArray(rawPaths) ? rawPaths : []) {
    if (typeof rawPath !== "string" || rawPath.trim() === "") continue;
    const absPath = path.resolve(rawPath);
    const key = path.normalize(absPath).toLowerCase();
    if (seen.has(key) || !fs.existsSync(absPath)) continue;
    seen.add(key);

    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      imported.push(...(await scanFolderForBooks(absPath)));
      continue;
    }
    if (!stat.isFile()) continue;
    const format = inferFileFormat(absPath);
    if (format) imported.push(await makeBook(absPath, "file", format));
  }
  for (const book of imported) importer.enqueue(book.id);
  return repo.listBooks();
}

function requireBook(id) {
  const book = repo.getBook(id);
  if (!book) throw new Error("Book not found");
  return book;
}

ipcMain.handle("library:list", () => repo.listBooks());

ipcMain.handle("dialog:importFiles", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "导入书籍",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Supported books", extensions: ["txt", "pdf", "epub", "mobi", "azw", "azw3"] },
      { name: "Text", extensions: ["txt"] },
      { name: "PDF", extensions: ["pdf"] },
      { name: "EPUB", extensions: ["epub"] },
      { name: "MOBI", extensions: ["mobi", "azw", "azw3"] }
    ]
  });
  if (result.canceled) return repo.listBooks();
  const imported = [];
  for (const filePath of result.filePaths) {
    const format = inferFileFormat(filePath);
    if (format) imported.push(await makeBook(filePath, "file", format));
  }
  for (const book of imported) importer.enqueue(book.id);
  return repo.listBooks();
});

ipcMain.handle("dialog:importFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "导入文件夹",
    properties: ["openDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) return repo.listBooks();
  const imported = await scanFolderForBooks(result.filePaths[0]);
  for (const book of imported) importer.enqueue(book.id);
  return repo.listBooks();
});

ipcMain.handle("dialog:importDroppedPaths", async (_event, paths) => importPaths(paths));

ipcMain.handle("library:updateBook", (_event, id, patch) => {
  const updated = repo.updateBook(id, patch || {});
  if (patch?.contentType) importer.enqueue(id);
  return updated;
});

ipcMain.handle("library:removeBook", (_event, id) => repo.removeBook(id));

ipcMain.handle("library:revealBook", async (_event, id) => {
  const book = requireBook(id);
  if (book.kind === "folder") {
    await shell.openPath(book.path);
  } else {
    shell.showItemInFolder(book.path);
  }
});

ipcMain.handle("content:getTextUnits", (_event, id) => repo.getTextUnits(id));
ipcMain.handle("content:getPageUnits", (_event, id) => repo.getPageUnits(id));

ipcMain.handle("cache:rebuildBook", (_event, id) => {
  requireBook(id);
  importer.enqueue(id);
  return repo.getBook(id);
});

ipcMain.handle("cache:cancelImport", (_event, id) => {
  requireBook(id);
  importer.cancel(id);
  return repo.getBook(id);
});

ipcMain.handle("diagnostics:summary", () => repo.diagnosticsSummary());
ipcMain.handle("stats:summary", () => repo.statsSummary());
ipcMain.handle("settings:get", () => appSettingsWithValidBackground());
ipcMain.handle("settings:update", (_event, patch) => repo.updateAppSettings(patch || {}));
ipcMain.handle("appearance:chooseHomeBackgroundImage", () => chooseBackgroundImage());
ipcMain.handle("appearance:resetHomeBackground", () => resetBackground());
ipcMain.handle("appearance:removeHomeBackground", () => removeBackground());
ipcMain.handle("system:listFonts", () => listSystemFonts());

ipcMain.handle("window:minimize", () => {
  mainWindow?.minimize();
});

ipcMain.handle("window:toggleMaximize", () => {
  if (!mainWindow) return { isMaximized: false };
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
  return { isMaximized: mainWindow.isMaximized() };
});

ipcMain.handle("window:toggleFullScreen", () => {
  if (!mainWindow) return { isFullScreen: false };
  const isFullScreen = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(isFullScreen);
  sendWindowState();
  return { isFullScreen };
});

ipcMain.handle("window:close", () => {
  mainWindow?.close();
});

ipcMain.handle("window:getState", () => windowState());
