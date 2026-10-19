import {
  BookOpen,
  ChartNoAxesCombined,
  Clock3,
  FileArchive,
  FileText,
  FolderOpen,
  Images,
  Import,
  Library,
  Play,
  Search,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AppSettings, BookItem, BookPatch, LibraryStore } from "../types";
import { globalBackgroundStyle } from "../lib/appearance";
import { summarizeLibrary } from "../lib/book";
import { useTitlebarDoubleClick } from "../lib/ui";
import { AppearanceSettingsMenu } from "./AppearanceSettingsMenu";
import { BookCard } from "./BookCard";
import { WindowControls } from "./WindowControls";

type FilterKey = "all" | "recent" | "novel" | "comic";

interface LibraryViewProps {
  store: LibraryStore;
  isLoading: boolean;
  error: string | null;
  onImportFiles: () => Promise<void>;
  onImportFolder: () => Promise<void>;
  onImportDroppedPaths: (paths: string[]) => Promise<void>;
  onOpenBook: (book: BookItem) => void;
  onRemoveBook: (id: string) => Promise<void>;
  onUpdateBook: (id: string, patch: BookPatch) => Promise<BookItem>;
  onRebuildBook: (id: string) => Promise<void>;
  onCancelImport: (id: string) => Promise<void>;
  onOpenStats: () => void;
  appSettings: AppSettings;
  onUpdateAppSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  onChooseBackgroundImage: () => Promise<AppSettings>;
  onResetBackground: () => Promise<AppSettings>;
  onRemoveBackground: () => Promise<AppSettings>;
}
export function LibraryView({
  store,
  isLoading,
  error,
  onImportFiles,
  onImportFolder,
  onImportDroppedPaths,
  onOpenBook,
  onRemoveBook,
  onUpdateBook,
  onRebuildBook,
  onCancelImport,
  onOpenStats,
  appSettings,
  onUpdateAppSettings,
  onChooseBackgroundImage,
  onResetBackground,
  onRemoveBackground
}: LibraryViewProps) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [isDragActive, setIsDragActive] = useState(false);
  useEffect(() => window.ereader.onNativeDrop((event) => {
    setIsDragActive(event.type === "enter");
    if (event.type === "drop") onImportDroppedPaths(event.paths).catch(() => undefined);
  }), [onImportDroppedPaths]);

  const books = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return store.books
      .filter((book) => {
        if (filter === "recent" && !book.lastOpenedAt) return false;
        if (filter === "novel" && book.contentType !== "novel") return false;
        if (filter === "comic" && book.contentType !== "comic") return false;
        return !normalizedQuery || `${book.title} ${book.path}`.toLowerCase().includes(normalizedQuery);
      });
  }, [filter, query, store.books]);

  const librarySummary = useMemo(() => summarizeLibrary(store.books), [store.books]);
  const continueBook = librarySummary.continueBook;
  const shellStyle = useMemo(() => globalBackgroundStyle(appSettings.appearance), [appSettings.appearance]);
  const handleTitlebarDoubleClick = useTitlebarDoubleClick("button, .window-controls");

  return (
    <main
      className={`app-shell${isDragActive ? " drag-active" : ""}`}
      style={shellStyle}
    >
      <header className="app-titlebar" onDoubleClick={handleTitlebarDoubleClick}>
        <div className="app-titlebar-brand">
          <BookOpen size={15} />
          <span>Ereader</span>
        </div>
        <div className="titlebar-actions">
          <AppearanceSettingsMenu
            backgroundOpacity={appSettings.appearance.backgroundOpacity}
            onChange={(backgroundOpacity) =>
              onUpdateAppSettings({ appearance: { ...appSettings.appearance, backgroundOpacity } }).catch(() => undefined)
            }
            onChooseImage={onChooseBackgroundImage}
            onReset={onResetBackground}
            onRemove={onRemoveBackground}
          />
          <WindowControls />
        </div>
      </header>

      <aside className="library-sidebar">
        <nav className="nav-stack" aria-label="书库筛选">
          <FilterButton icon={<Library size={17} />} active={filter === "all"} onClick={() => setFilter("all")}>
            全部 <span>{librarySummary.total}</span>
          </FilterButton>
          <FilterButton icon={<Clock3 size={17} />} active={filter === "recent"} onClick={() => setFilter("recent")}>
            最近 <span>{librarySummary.recent}</span>
          </FilterButton>
          <FilterButton icon={<FileText size={17} />} active={filter === "novel"} onClick={() => setFilter("novel")}>
            小说 <span>{librarySummary.novels}</span>
          </FilterButton>
          <FilterButton icon={<Images size={17} />} active={filter === "comic"} onClick={() => setFilter("comic")}>
            漫画 <span>{librarySummary.comics}</span>
          </FilterButton>
          <button className="nav-item" onClick={onOpenStats}>
            <ChartNoAxesCombined size={17} />
            统计
          </button>
        </nav>

        <div className="import-panel">
          <button className="primary-action" onClick={onImportFiles}>
            <Import size={17} />
            导入文件
          </button>
          <button className="secondary-action" onClick={onImportFolder}>
            <FolderOpen size={17} />
            导入文件夹
          </button>
        </div>
      </aside>

      <section className="library-main">
        <header className="library-header">
          <div className="library-heading">
            <h2>书架</h2>
            <div className="library-stats" aria-label="书库统计">
              <span>{librarySummary.total} 本</span>
              {store.books.some((book) => book.importStatus === "queued" || book.importStatus === "processing") && <span>处理中</span>}
            </div>
          </div>

          <div className="library-command-bar">
            {continueBook && (
              <button className="continue-action" onClick={() => onOpenBook(continueBook)} title={`继续阅读：${continueBook.title}`}>
                <Play size={16} />
                继续阅读
                <span>{continueBook.title}</span>
              </button>
            )}

            <div className="search-box">
              <Search size={17} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={store.books.length ? "搜索标题或路径" : "导入后可搜索书库"}
                aria-label="搜索书库"
              />
              {query && (
                <button className="search-clear" onClick={() => setQuery("")} title="清除搜索">
                  <X size={15} />
                </button>
              )}
            </div>
          </div>
        </header>

        {error && <div className="error-banner">{error}</div>}

        {isLoading ? (
          <div className="empty-state">正在载入书库...</div>
        ) : books.length === 0 ? (
          <div className="empty-state">
            <FileArchive size={34} />
            <h3>{query ? "没有匹配的书籍" : "还没有可阅读内容"}</h3>
            <p>{query ? "换一个关键词，或清除搜索查看全部书籍。" : "导入 txt、pdf、epub、mobi，或选择一个漫画图片文件夹开始。"}</p>
            <div className="empty-actions">
              {query ? (
                <button className="secondary-action" onClick={() => setQuery("")}>
                  <X size={17} />
                  清除搜索
                </button>
              ) : (
                <>
                  <button className="primary-action" onClick={onImportFiles}>
                    <Import size={17} />
                    导入文件
                  </button>
                  <button className="secondary-action" onClick={onImportFolder}>
                    <FolderOpen size={17} />
                    导入文件夹
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="book-grid">
            {books.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                onOpen={onOpenBook}
                onRemove={onRemoveBook}
                onUpdateBook={onUpdateBook}
                onRebuild={onRebuildBook}
                onCancelImport={onCancelImport}
              />
            ))}
          </div>
        )}

        {isDragActive && (
          <div className="drag-import-overlay">
            <Import size={28} />
            <strong>释放以导入</strong>
            <span>支持 txt、pdf、epub、mobi 和图片文件夹</span>
          </div>
        )}
      </section>
    </main>
  );
}

function FilterButton({
  active,
  icon,
  children,
  onClick
}: {
  active: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button className={active ? "nav-item active" : "nav-item"} onClick={onClick} aria-pressed={active}>
      {icon}
      {children}
    </button>
  );
}
