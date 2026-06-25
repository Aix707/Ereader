/// <reference types="vite/client" />

import type {
  AppSettings,
  BookItem,
  BookPatch,
  DiagnosticsSummary,
  ImportStateChange,
  LibraryStore,
  PageUnit,
  StatsSummary,
  SystemFontItem,
  TextUnit,
  WindowState
} from "./types";

declare global {
  interface Window {
    ereader: {
      listLibrary: () => Promise<LibraryStore>;
      importFiles: () => Promise<LibraryStore>;
      importFolder: () => Promise<LibraryStore>;
      importDroppedPaths: (paths: string[]) => Promise<LibraryStore>;
      updateBook: (id: string, patch: BookPatch) => Promise<BookItem>;
      removeBook: (id: string) => Promise<LibraryStore>;
      revealBook: (id: string) => Promise<void>;
      getTextUnits: (id: string) => Promise<TextUnit[]>;
      getPageUnits: (id: string) => Promise<PageUnit[]>;
      getAssetUrl: (assetId: number) => string;
      rebuildBook: (id: string) => Promise<BookItem>;
      cancelImport: (id: string) => Promise<BookItem>;
      getDiagnostics: () => Promise<DiagnosticsSummary>;
      getStats: () => Promise<StatsSummary>;
      getAppSettings: () => Promise<AppSettings>;
      updateAppSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
      chooseBackgroundImage: () => Promise<AppSettings>;
      resetBackground: () => Promise<AppSettings>;
      removeBackground: () => Promise<AppSettings>;
      getBackgroundImageUrl: () => string;
      listSystemFonts: () => Promise<SystemFontItem[]>;
      onImportStateChanged: (callback: (state: ImportStateChange) => void) => () => void;
      windowControls: {
        minimize: () => Promise<void>;
        toggleMaximize: () => Promise<WindowState>;
        toggleFullScreen: () => Promise<WindowState>;
        close: () => Promise<void>;
        getState: () => Promise<WindowState>;
        onStateChanged: (callback: (state: WindowState) => void) => () => void;
      };
    };
  }
}
