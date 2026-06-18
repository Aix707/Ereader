const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ereader", {
  listLibrary: () => ipcRenderer.invoke("library:list"),
  importFiles: () => ipcRenderer.invoke("dialog:importFiles"),
  importFolder: () => ipcRenderer.invoke("dialog:importFolder"),
  updateBook: (id, patch) => ipcRenderer.invoke("library:updateBook", id, patch),
  removeBook: (id) => ipcRenderer.invoke("library:removeBook", id),
  revealBook: (id) => ipcRenderer.invoke("library:revealBook", id),
  getTextUnits: (id) => ipcRenderer.invoke("content:getTextUnits", id),
  getPageUnits: (id) => ipcRenderer.invoke("content:getPageUnits", id),
  getAssetDataUrl: (assetId) => ipcRenderer.invoke("content:getAssetDataUrl", assetId),
  rebuildBook: (id) => ipcRenderer.invoke("cache:rebuildBook", id),
  getDiagnostics: () => ipcRenderer.invoke("diagnostics:summary")
});
