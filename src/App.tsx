import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { LibraryView } from "./components/LibraryView";
import { DEFAULT_APP_SETTINGS } from "./types";
import type { AppSettings, BookItem, ImportStateChange, LibraryStore } from "./types";
import { getWindowSnapshot } from "./lib/window";

const ReaderView = lazy(() => import("./components/ReaderView").then((module) => ({ default: module.ReaderView })));
const StatsView = lazy(() => import("./components/StatsView").then((module) => ({ default: module.StatsView })));

export function App() {
  const [store, setStore] = useState<LibraryStore>({ version: 1, books: [] });
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [screen, setScreen] = useState<"library" | "stats">("library");
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshRequest = useRef<Promise<void> | null>(null);
  const activeBook = store.books.find((book) => book.id === activeBookId);

  useEffect(() => {
    if (!activeBook) window.ereader.windowControls.setFullScreen(false).catch(() => undefined);
    function handleKey(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const state = getWindowSnapshot();
      if (event.key === "F11") {
        event.preventDefault();
        if (activeBook && !event.repeat && !state.isBusy) {
          window.ereader.windowControls.setFullScreen(!state.isFullScreen).catch(() => undefined);
        }
      } else if (event.key === "Escape" && activeBook && state.isFullScreen && !state.isBusy && !document.querySelector("[data-ui-popover]")) {
        event.preventDefault();
        window.ereader.windowControls.setFullScreen(false).catch(() => undefined);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [activeBook?.id]);

  const leaveReader = useCallback(async () => {
    try {
      await window.ereader.windowControls.setFullScreen(false);
      setActiveBookId(null);
    } catch (reason) { setError(String(reason)); }
  }, []);

  const replaceBook = useCallback((updated: BookItem) => {
    setStore((current) => {
      const index = current.books.findIndex((book) => book.id === updated.id);
      if (index < 0) return current;
      const books = current.books.slice();
      books[index] = updated;
      if (index > 0 && (updated.lastOpenedAt || updated.addedAt) > (books[0].lastOpenedAt || books[0].addedAt)) {
        books.splice(index, 1);
        books.unshift(updated);
      }
      return { ...current, books };
    });
  }, []);

  const refreshLibrary = useCallback(() => {
    if (refreshRequest.current) return refreshRequest.current;
    refreshRequest.current = window.ereader.listLibrary()
      .then(setStore)
      .catch((reason) => setError(String(reason)))
      .finally(() => {
        refreshRequest.current = null;
        setIsLoading(false);
      });
    return refreshRequest.current;
  }, []);

  useEffect(() => {
    function handleImportState(state: ImportStateChange) {
      if (state.type === "queued" || state.type === "started" || state.type === "progress") {
        const importStatus = state.type === "queued" ? "queued" : "processing";
        setStore((current) => ({
          ...current,
          books: current.books.map((book) => book.id === state.bookId ? {
            ...book, importStatus, importProgress: state.progress ?? 0, importError: null
          } : book)
        }));
      } else {
        window.ereader.getBook(state.bookId).then((book) => {
          if (book) replaceBook(book);
        }).catch((reason) => setError(String(reason)));
      }
    }
    const unsubscribe = window.ereader.onImportStateChanged(handleImportState);
    refreshLibrary();
    window.ereader.getAppSettings().then(setAppSettings).catch(() => undefined);
    window.addEventListener("focus", refreshLibrary);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", refreshLibrary);
    };
  }, [refreshLibrary, replaceBook]);

  const runImport = useCallback(async (action: () => Promise<LibraryStore>) => {
    setError(null);
    try {
      setStore(await action());
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  const importFiles = useCallback(() => runImport(window.ereader.importFiles), [runImport]);
  const importFolder = useCallback(() => runImport(window.ereader.importFolder), [runImport]);
  const importDroppedPaths = useCallback((paths: string[]) =>
    paths.length ? runImport(() => window.ereader.importDroppedPaths(paths)) : Promise.resolve(), [runImport]);

  const updateBook = useCallback(async (id: string, patch: Parameters<typeof window.ereader.updateBook>[1]) => {
    const updated = await window.ereader.updateBook(id, patch);
    replaceBook(updated);
    return updated;
  }, [replaceBook]);

  const updateAppSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const updated = await window.ereader.updateAppSettings(patch);
    setAppSettings(updated);
    return updated;
  }, []);

  const chooseBackgroundImage = useCallback(async () => {
    const updated = await window.ereader.chooseBackgroundImage();
    setAppSettings(updated);
    return updated;
  }, []);

  const resetBackground = useCallback(async () => {
    const updated = await window.ereader.resetBackground();
    setAppSettings(updated);
    return updated;
  }, []);

  const removeBackground = useCallback(async () => {
    const updated = await window.ereader.removeBackground();
    setAppSettings(updated);
    return updated;
  }, []);

  const removeBook = useCallback(async (id: string) => {
    setStore(await window.ereader.removeBook(id));
    setActiveBookId((current) => current === id ? null : current);
  }, []);

  const rebuildBook = useCallback(async (id: string) => {
    replaceBook(await window.ereader.rebuildBook(id));
  }, [replaceBook]);

  const cancelImport = useCallback(async (id: string) => {
    replaceBook(await window.ereader.cancelImport(id));
  }, [replaceBook]);

  const openBook = useCallback(async (book: BookItem) => {
    try {
      await updateBook(book.id, { lastOpenedAt: new Date().toISOString() });
      setActiveBookId(book.id);
    } catch (reason) {
      setError(String(reason));
    }
  }, [updateBook]);

  if (activeBook) {
    return (
      <Suspense fallback={<div className="reader-loading">正在打开阅读器...</div>}>
        <ReaderView
          book={activeBook}
          onBack={leaveReader}
          onUpdateBook={updateBook}
          appSettings={appSettings}
          onUpdateAppSettings={updateAppSettings}
        />
      </Suspense>
    );
  }

  if (screen === "stats") {
    return (
      <Suspense fallback={<div className="reader-loading">正在打开统计...</div>}>
        <StatsView
          onBack={() => setScreen("library")}
          onRebuild={rebuildBook}
          appSettings={appSettings}
        />
      </Suspense>
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
      onChooseBackgroundImage={chooseBackgroundImage}
      onResetBackground={resetBackground}
      onRemoveBackground={removeBackground}
    />
  );
}
