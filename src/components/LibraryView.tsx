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
import { useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { AppSettings, BookItem, BookPatch, LibraryStore } from "../types";
import { globalBackgroundStyle } from "../lib/appearance";
import { useTitlebarDoubleClick } from "../lib/ui";
import { AppearanceSettingsMenu } from "./AppearanceSettingsMenu";
import { BookCard, isBookReady } from "./BookCard";
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
  const dragDepth = useRef(0);

  const books = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return [...store.books]
      .filter((book) => {
        if (filter === "recent") return Boolean(book.lastOpenedAt);
        if (filter === "novel") return book.contentType === "novel";
        if (filter === "comic") return book.contentType === "comic";
        return true;
      })
      .filter((book) => {
        if (!normalizedQuery) return true;
        return `${book.title} ${book.path}`.toLowerCase().includes(normalizedQuery);
      })
      .sort((a, b) => {
        const left = new Date(a.lastOpenedAt || a.addedAt).getTime();
        const right = new Date(b.lastOpenedAt || b.addedAt).getTime();
        return right - left;
      });
  }, [filter, query, store.books]);

  const readyBooks = store.books.filter((book) => isBookReady(book)).length;
  const recent = store.books.filter((book) => book.lastOpenedAt).length;
  const novels = store.books.filter((book) => book.contentType === "novel").length;
  const comics = store.books.filter((book) => book.contentType === "comic").length;
  const continueBook = useMemo(
    () =>
      [...store.books]
        .filter((book) => isBookReady(book) && book.lastOpenedAt)
        .sort((a, b) => new Date(b.lastOpenedAt || 0).getTime() - new Date(a.lastOpenedAt || 0).getTime())[0] || null,
    [store.books]
  );
  const shellStyle = useMemo(() => globalBackgroundStyle(appSettings.appearance), [appSettings.appearance]);
  const handleTitlebarDoubleClick = useTitlebarDoubleClick("button, .window-controls");

  function handleDragEnter(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setIsDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setIsDragActive(false);
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => (file as File & { path?: string }).path)
      .filter((path): path is string => Boolean(path));
    onImportDroppedPaths(paths).catch(() => undefined);
  }

  return (
    <main
      className={`app-shell${isDragActive ? " drag-active" : ""}`}
      style={shellStyle}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
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
        <div className="brand-block">
          <div className="brand-mark">
            <BookOpen size={22} />
          </div>
          <div>
            <h1>Ereader</h1>
            <span>本地阅读工作台</span>
          </div>
        </div>

        <nav className="nav-stack" aria-label="书库筛选">
          <FilterButton icon={<Library size={17} />} active={filter === "all"} onClick={() => setFilter("all")}>
            全部 <span>{store.books.length}</span>
          </FilterButton>
          <FilterButton icon={<Clock3 size={17} />} active={filter === "recent"} onClick={() => setFilter("recent")}>
            最近 <span>{recent}</span>
          </FilterButton>
          <FilterButton icon={<FileText size={17} />} active={filter === "novel"} onClick={() => setFilter("novel")}>
            小说 <span>{novels}</span>
          </FilterButton>
          <FilterButton icon={<Images size={17} />} active={filter === "comic"} onClick={() => setFilter("comic")}>
            漫画 <span>{comics}</span>
          </FilterButton>
          <button className="nav-item" onClick={onOpenStats}>
            <ChartNoAxesCombined size={17} />
            统计 <span>阅读</span>
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
            <p className="eyebrow">Library</p>
            <h2>阅读书架</h2>
            <div className="library-stats" aria-label="书库统计">
              <span>{store.books.length} 本</span>
              <span>{readyBooks} 就绪</span>
              <span>{comics} 漫画</span>
              <span>{novels} 小说</span>
            </div>
          </div>

          <div className="library-command-bar">
            {continueBook && (
              <button className="continue-action" onClick={() => onOpenBook(continueBook)}>
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
                onOpen={() => onOpenBook(book)}
                onRemove={() => onRemoveBook(book.id)}
                onUpdateBook={(patch) => onUpdateBook(book.id, patch)}
                onRebuild={() => onRebuildBook(book.id)}
                onCancelImport={() => onCancelImport(book.id)}
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
    <button className={active ? "nav-item active" : "nav-item"} onClick={onClick}>
      {icon}
      {children}
    </button>
  );
}

function hasDraggedFiles(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes("Files");
}
