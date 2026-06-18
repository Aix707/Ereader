const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRepository } = require("./database.cjs");
const { createImporter, imageFilesInFolder } = require("./importer.cjs");

const FILE_FORMATS = new Map([
  [".txt", "txt"],
  [".pdf", "pdf"],
  [".epub", "epub"]
]);

let mainWindow;
let repo;
let importer;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 660,
    backgroundColor: "#f7f4ee",
    title: "Ereader",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  repo = createRepository(app.getPath("userData"));
  repo.migrateFromJson(path.join(app.getPath("userData"), "library.json"));
  importer = createImporter(repo);
  createWindow();
  importer.enqueueMany(repo.booksNeedingImport());
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
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

function assetToDataUrl(asset) {
  if (!asset) throw new Error("Asset not found");
  return `data:${asset.mime};base64,${Buffer.from(asset.data).toString("base64")}`;
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
ipcMain.handle("content:getAssetDataUrl", (_event, assetId) => assetToDataUrl(repo.getAsset(assetId)));

ipcMain.handle("cache:rebuildBook", (_event, id) => {
  requireBook(id);
  importer.enqueue(id);
  return repo.getBook(id);
});

ipcMain.handle("diagnostics:summary", () => repo.diagnosticsSummary());
