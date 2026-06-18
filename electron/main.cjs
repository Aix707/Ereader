const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRepository } = require("./database.cjs");
const { imageFilesInFolder } = require("./importer.cjs");
const { createWorkerImporter } = require("./import-worker-client.cjs");

const FILE_FORMATS = new Map([
  [".txt", "txt"],
  [".pdf", "pdf"],
  [".epub", "epub"]
]);

let mainWindow;
let repo;
let importer;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "ereader-asset",
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
    backgroundColor: "#f7f4ee",
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
      return new Response(asset.data, {
        headers: {
          "Content-Type": asset.mime,
          "Cache-Control": "no-store",
          "Content-Length": String(asset.data.length)
        }
      });
    } catch (error) {
      return new Response(String(error?.message || error), { status: 500 });
    }
  });
}

app.whenReady().then(() => {
  repo = createRepository(app.getPath("userData"));
  repo.migrateFromJson(path.join(app.getPath("userData"), "library.json"));
  importer = createWorkerImporter(app.getPath("userData"), repo, {
    onStateChanged(message) {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("import:stateChanged", message);
    }
  });
  registerAssetProtocol();
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

function makeBook(absPath, kind, format) {
  return repo.upsertBook({
    id: makeId(absPath),
    title: titleFromPath(absPath, format),
    path: absPath,
    kind,
    format,
    contentType: format === "image-folder" ? "comic" : "novel"
  });
}

function scanFolderForBooks(folderPath) {
  const books = [];
  if (imageFilesInFolder(folderPath).length > 0) {
    books.push(makeBook(folderPath, "folder", "image-folder"));
  }

  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = path.join(folderPath, entry.name);
    if (entry.isFile()) {
      const format = inferFileFormat(absPath);
      if (format) books.push(makeBook(absPath, "file", format));
    } else if (entry.isDirectory() && imageFilesInFolder(absPath).length > 0) {
      books.push(makeBook(absPath, "folder", "image-folder"));
    }
  }
  return books;
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
      { name: "Supported books", extensions: ["txt", "pdf", "epub"] },
      { name: "Text", extensions: ["txt"] },
      { name: "PDF", extensions: ["pdf"] },
      { name: "EPUB", extensions: ["epub"] }
    ]
  });
  if (result.canceled) return repo.listBooks();
  const imported = result.filePaths
    .map((filePath) => ({ filePath, format: inferFileFormat(filePath) }))
    .filter((item) => item.format)
    .map((item) => makeBook(item.filePath, "file", item.format));
  for (const book of imported) importer.enqueue(book.id);
  return repo.listBooks();
});

ipcMain.handle("dialog:importFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "导入文件夹",
    properties: ["openDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) return repo.listBooks();
  const imported = scanFolderForBooks(result.filePaths[0]);
  for (const book of imported) importer.enqueue(book.id);
  return repo.listBooks();
});

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
