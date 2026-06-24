import { useCallback, useEffect, useRef, useState } from "react";
import { LibraryView } from "./components/LibraryView";
import { ReaderView } from "./components/ReaderView";
import { StatsView } from "./components/StatsView";
import { DEFAULT_APP_SETTINGS } from "./types";
import type { AppSettings, BookItem, LibraryStore } from "./types";

export function App() {
  const [store, setStore] = useState<LibraryStore>({ version: 1, books: [] });
  const [activeBook, setActiveBook] = useState<BookItem | null>(null);
  const [screen, setScreen] = useState<"library" | "stats">("library");
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshTimer = useRef<number | null>(null);

  const refreshLibrary = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      window.ereader.listLibrary().then(setStore).catch(() => undefined);
    }, 200);
  }, []);

  useEffect(() => {
    window.ereader
      .listLibrary()
      .then(setStore)
      .catch((reason) => setError(String(reason)))
      .finally(() => setIsLoading(false));
    window.ereader.getAppSettings().then(setAppSettings).catch(() => undefined);
  }, []);

  useEffect(() => {
    return window.ereader.onImportStateChanged(refreshLibrary);
  }, [refreshLibrary]);

  useEffect(() => {
    return () => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, []);

  useEffect(() => {
    const hasActiveImports = store.books.some((book) => isActiveImportStatus(book.importStatus));
    if (!hasActiveImports) return;
    const timer = window.setInterval(() => {
      refreshLibrary();
    }, 1200);
    return () => window.clearInterval(timer);
  }, [refreshLibrary, store.books]);

  async function importFiles() {
    setError(null);
    setStore(await window.ereader.importFiles());
  }

  async function importFolder() {
    setError(null);
    setStore(await window.ereader.importFolder());
  }

  async function importDroppedPaths(paths: string[]) {
    setError(null);
    if (paths.length === 0) return;
    setStore(await window.ereader.importDroppedPaths(paths));
  }

  const updateBook = useCallback(async (id: string, patch: Parameters<typeof window.ereader.updateBook>[1]) => {
    const updated = await window.ereader.updateBook(id, patch);
    setStore((current) => ({
      ...current,
      books: current.books.map((book) => (book.id === id ? updated : book))
    }));
    setActiveBook((current) => (current?.id === id ? updated : current));
    return updated;
  }, []);

  const updateAppSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const updated = await window.ereader.updateAppSettings(patch);
    setAppSettings(updated);
    return updated;
  }, []);

  const chooseHomeBackgroundImage = useCallback(async () => {
    const updated = await window.ereader.chooseHomeBackgroundImage();
    setAppSettings(updated);
    return updated;
  }, []);

  const resetHomeBackground = useCallback(async () => {
    const updated = await window.ereader.resetHomeBackground();
    setAppSettings(updated);
    return updated;
  }, []);

  const removeHomeBackground = useCallback(async () => {
    const updated = await window.ereader.removeHomeBackground();
    setAppSettings(updated);
    return updated;
  }, []);

  async function removeBook(id: string) {
    setStore(await window.ereader.removeBook(id));
    setActiveBook((current) => (current?.id === id ? null : current));
  }

  async function rebuildBook(id: string) {
    const updated = await window.ereader.rebuildBook(id);
    setStore((current) => ({
      ...current,
      books: current.books.map((book) => (book.id === id ? updated : book))
    }));
  }

  async function cancelImport(id: string) {
    const updated = await window.ereader.cancelImport(id);
    setStore((current) => ({
      ...current,
      books: current.books.map((book) => (book.id === id ? updated : book))
    }));
  }

  async function openBook(book: BookItem) {
    try {
      const updated = await updateBook(book.id, { lastOpenedAt: new Date().toISOString() });
      setActiveBook(updated);
    } catch {
      setActiveBook(book);
    }
  }

  if (activeBook) {
    return (
      <ReaderView
        book={activeBook}
        onBack={() => setActiveBook(null)}
        onUpdateBook={updateBook}
        appSettings={appSettings}
        onUpdateAppSettings={updateAppSettings}
      />
    );
  }

  if (screen === "stats") {
    return (
      <StatsView
        onBack={() => setScreen("library")}
        onRebuild={rebuildBook}
        appSettings={appSettings}
      />
    );
  }

  return (
    <LibraryView
      store={store}
      isLoading={isLoading}
      error={error}
      onImportFiles={importFiles}
      onImportFolder={importFolder}
      onImportDroppedPaths={importDroppedPaths}
      onOpenBook={openBook}
      onRemoveBook={removeBook}
      onUpdateBook={updateBook}
      onRebuildBook={rebuildBook}
      onCancelImport={cancelImport}
      onOpenStats={() => setScreen("stats")}
      appSettings={appSettings}
      onUpdateAppSettings={updateAppSettings}
      onChooseHomeBackgroundImage={chooseHomeBackgroundImage}
      onResetHomeBackground={resetHomeBackground}
      onRemoveHomeBackground={removeHomeBackground}
    />
  );
}

function isActiveImportStatus(status?: string) {
  return status === "queued" || status === "processing";
}
