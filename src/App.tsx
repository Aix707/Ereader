import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiagnosticsView } from "./components/DiagnosticsView";
import { LibraryView } from "./components/LibraryView";
import { ReaderView } from "./components/ReaderView";
import type { BookItem, LibraryStore } from "./types";

export function App() {
  const [store, setStore] = useState<LibraryStore>({ version: 1, books: [] });
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [screen, setScreen] = useState<"library" | "diagnostics">("library");
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

  const activeBook = useMemo(
    () => store.books.find((book) => book.id === activeBookId) || null,
    [activeBookId, store.books]
  );

  async function importFiles() {
    setError(null);
    setStore(await window.ereader.importFiles());
  }

  async function importFolder() {
    setError(null);
    setStore(await window.ereader.importFolder());
  }

  async function updateBook(id: string, patch: Parameters<typeof window.ereader.updateBook>[1]) {
    const updated = await window.ereader.updateBook(id, patch);
    setStore((current) => ({
      ...current,
      books: current.books.map((book) => (book.id === id ? updated : book))
    }));
    return updated;
  }

  async function removeBook(id: string) {
    setStore(await window.ereader.removeBook(id));
    if (activeBookId === id) setActiveBookId(null);
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

  function openBook(book: BookItem) {
    setActiveBookId(book.id);
    updateBook(book.id, { lastOpenedAt: new Date().toISOString() }).catch(() => undefined);
  }

  if (activeBook) {
    return (
      <ReaderView
        book={activeBook}
        onBack={() => setActiveBookId(null)}
        onUpdateBook={updateBook}
      />
    );
  }

  if (screen === "diagnostics") {
    return (
      <DiagnosticsView
        onBack={() => setScreen("library")}
        onRebuild={rebuildBook}
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
      onOpenBook={openBook}
      onRemoveBook={removeBook}
      onUpdateBook={updateBook}
      onRebuildBook={rebuildBook}
      onCancelImport={cancelImport}
      onOpenDiagnostics={() => setScreen("diagnostics")}
    />
  );
}

function isActiveImportStatus(status?: string) {
  return status === "queued" || status === "processing";
}
