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
  getAssetUrl: (assetId) => `ereader-asset://asset/${assetId}`,
  getAssetDataUrl: (assetId) => ipcRenderer.invoke("content:getAssetDataUrl", assetId),
  rebuildBook: (id) => ipcRenderer.invoke("cache:rebuildBook", id),
  cancelImport: (id) => ipcRenderer.invoke("cache:cancelImport", id),
  getDiagnostics: () => ipcRenderer.invoke("diagnostics:summary"),
  onImportStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("import:stateChanged", listener);
    return () => ipcRenderer.removeListener("import:stateChanged", listener);
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
    toggleFullScreen: () => ipcRenderer.invoke("window:toggleFullScreen"),
    close: () => ipcRenderer.invoke("window:close"),
    getState: () => ipcRenderer.invoke("window:getState"),
    onStateChanged: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("window:stateChanged", listener);
      return () => ipcRenderer.removeListener("window:stateChanged", listener);
    }
  }
});
