/// <reference types="vite/client" />

import type { BookItem, BookPatch, DiagnosticsSummary, LibraryStore, PageUnit, TextUnit } from "./types";

declare global {
  interface Window {
    ereader: {
      listLibrary: () => Promise<LibraryStore>;
      importFiles: () => Promise<LibraryStore>;
      importFolder: () => Promise<LibraryStore>;
      updateBook: (id: string, patch: BookPatch) => Promise<BookItem>;
      removeBook: (id: string) => Promise<LibraryStore>;
      revealBook: (id: string) => Promise<void>;
      getTextUnits: (id: string) => Promise<TextUnit[]>;
      getPageUnits: (id: string) => Promise<PageUnit[]>;
      getAssetDataUrl: (assetId: number) => Promise<string>;
      rebuildBook: (id: string) => Promise<BookItem>;
      getDiagnostics: () => Promise<DiagnosticsSummary>;
    };
  }
}
