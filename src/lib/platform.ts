import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppSettings, EreaderApi, ImportStateChange, NativeDrop, WindowState } from "../types";
import { interactiveSelector, publishWindowState } from "./window";

const pending = new Set<Promise<unknown>>();
function trackWrite<T>(promise: Promise<T>): Promise<T> {
  pending.add(promise);
  promise.then(() => pending.delete(promise), () => pending.delete(promise));
  return promise;
}
const writes = new Set(["updateBook", "updateAppSettings", "removeBook", "resetBackground", "removeBackground"]);
export function callNative<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const promise = invoke<T>("api", { method, args });
  return writes.has(method) ? trackWrite(promise) : promise;
}
function signal<T>() {
  const callbacks = new Set<(value: T) => void>();
  return {
    subscribe(callback: (value: T) => void) { callbacks.add(callback); return () => { callbacks.delete(callback); }; },
    emit(value: T) { for (const callback of callbacks) callback(value); }
  };
}

export async function initializePlatform(): Promise<void> {
  const imports = signal<ImportStateChange>();
  const drops = signal<NativeDrop>();
  const windows = signal<WindowState>();
  let windowQueue: Promise<unknown> = Promise.resolve();
  let windowRequests = 0;
  function applyWindowState(state: WindowState) { publishWindowState(state); windows.emit(state); return state; }
  function windowAction(method: string, args: Record<string, unknown> = {}): Promise<WindowState> {
    windowRequests++;
    publishWindowState({ isBusy: true });
    const result = windowQueue.then(() => callNative<WindowState>(method, args)).then(applyWindowState);
    windowQueue = result.catch(() => undefined);
    return result.finally(() => { windowRequests--; publishWindowState({ isBusy: windowRequests > 0 }); });
  }
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    window.dispatchEvent(new Event("beforeunload"));
    await Promise.allSettled([...pending]);
    await windowQueue;
    await invoke("api", { method: "close", args: {} });
  }
  await Promise.all([
    listen<ImportStateChange>("import-state", ({ payload }) => imports.emit(payload)),
    listen<NativeDrop>("native-drop", ({ payload }) => drops.emit(payload)),
    listen<WindowState>("window-state", ({ payload }) => applyWindowState(payload)),
    listen("closing", () => { close().catch(console.error); })
  ]);
  const api: EreaderApi = {
    listLibrary: () => callNative("listLibrary"),
    getBook: (id) => callNative("getBook", { id }),
    importFiles: () => callNative("importFiles"),
    importFolder: () => callNative("importFolder"),
    importDroppedPaths: (paths) => callNative("importDroppedPaths", { paths }),
    onNativeDrop: drops.subscribe,
    updateBook: (id, patch) => callNative("updateBook", { id, patch }),
    removeBook: (id) => callNative("removeBook", { id }),
    revealBook: (id) => callNative("revealBook", { id }),
    getTextUnits: (id) => callNative("getTextUnits", { id }),
    getPageUnits: (id) => callNative("getPageUnits", { id }),
    getAssetUrl: (id) => `${convertFileSrc("", "ereader-asset")}asset/${id}`,
    rebuildBook: (id) => callNative("rebuildBook", { id }),
    cancelImport: (id) => callNative("cancelImport", { id }),
    getDiagnostics: () => callNative("getDiagnostics"),
    getStats: () => callNative("getStats"),
    getAppSettings: () => callNative("getAppSettings"),
    updateAppSettings: (patch) => callNative("updateAppSettings", { patch }),
    chooseBackgroundImage: () => trackWrite((async () => {
      const source = await callNative<{ name: string; size: number } | null>("chooseBackgroundImage");
      if (!source) return callNative("getAppSettings");
      const { NativeReader } = await import("../import/source");
      const { normalizeImage } = await import("../import/image");
      const image = await normalizeImage(await new NativeReader("background", 0, source.size).all(), "background", 2400, 0.88);
      return invoke<AppSettings>("write_asset", image.bytes, { headers: { "x-meta": JSON.stringify({ job: "background", ...image.meta }) } });
    })()),
    resetBackground: () => callNative("resetBackground"),
    removeBackground: () => callNative("removeBackground"),
    getBackgroundImageUrl: () => `${convertFileSrc("", "ereader-asset")}background`,
    listSystemFonts: () => callNative("listSystemFonts"),
    onImportStateChanged: imports.subscribe,
    windowControls: {
      minimize: () => windowAction("minimize").then(() => undefined),
      toggleMaximize: () => windowAction("toggleMaximize"),
      toggleFullScreen: () => windowAction("toggleFullScreen"),
      setFullScreen: (enabled) => windowAction("setFullScreen", { enabled }),
      close,
      getState: () => callNative<WindowState>("windowState").then(applyWindowState),
      onStateChanged: windows.subscribe
    }
  };
  window.ereader = api;
  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.detail > 1 || !(event.target instanceof Element)) return;
    if (event.target.closest(".app-titlebar,.reader-toolbar") && !event.target.closest(interactiveSelector)) {
      getCurrentWindow().startDragging().catch(console.error);
    }
  });
  await api.windowControls.getState();
  await callNative("ready");
}
