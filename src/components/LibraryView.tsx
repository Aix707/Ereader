import {
  BookOpen,
  CircleStop,
  Clock3,
  Database,
  FileArchive,
  FileText,
  FolderOpen,
  Images,
  Import,
  Library,
  Play,
  RefreshCw,
  Search,
  Trash2,
  X
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { DragEvent, MouseEvent } from "react";
import type { BookItem, BookPatch, LibraryStore } from "../types";
import { formatPercent, formatRelativeDate, labelForContentType, labelForFormat } from "../lib/format";
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
  onOpenDiagnostics: () => void;
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
  onOpenDiagnostics
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

  const readyBooks = store.books.filter((book) => isReady(book)).length;
  const recent = store.books.filter((book) => book.lastOpenedAt).length;
  const novels = store.books.filter((book) => book.contentType === "novel").length;
  const comics = store.books.filter((book) => book.contentType === "comic").length;
  const continueBook = useMemo(
    () =>
      [...store.books]
        .filter((book) => isReady(book) && book.lastOpenedAt)
        .sort((a, b) => new Date(b.lastOpenedAt || 0).getTime() - new Date(a.lastOpenedAt || 0).getTime())[0] || null,
    [store.books]
  );

  function handleTitlebarDoubleClick(event: MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("button, .window-controls")) return;
    window.ereader.windowControls.toggleMaximize().catch(() => undefined);
  }

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
        <WindowControls />
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
          <button className="nav-item" onClick={onOpenDiagnostics}>
            <Database size={17} />
            诊断 <span>SQLite</span>
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
            <p>{query ? "换一个关键词，或清除搜索查看全部书籍。" : "导入 txt、pdf、epub，或选择一个漫画图片文件夹开始。"}</p>
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
            <span>支持 txt、pdf、epub 和图片文件夹</span>
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

function BookCard({
  book,
  onOpen,
  onRemove,
  onUpdateBook,
  onRebuild,
  onCancelImport
}: {
  book: BookItem;
  onOpen: () => void;
  onRemove: () => Promise<void>;
  onUpdateBook: (patch: BookPatch) => Promise<BookItem>;
  onRebuild: () => Promise<void>;
  onCancelImport: () => Promise<void>;
}) {
  const progress = formatPercent(book.progress.percent || 0);
  const progressValue = Math.round(Math.max(0, Math.min(1, book.progress.percent || 0)) * 100);
  const importStatus = book.importStatus || "ready";
  const canOpen = isReady(book);
  const canToggleContent = book.format === "pdf" || book.format === "epub";
  const cardRef = useRef<HTMLElement>(null);
  const [panelSide, setPanelSide] = useState<"left" | "right">("right");
  const lastReadText = book.lastOpenedAt ? `最近 ${formatRelativeDate(book.lastOpenedAt)}` : "尚未阅读";

  function updatePanelSide() {
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const panelWidth = 306;
    const gap = 14;
    const rightSpace = window.innerWidth - rect.right;
    const leftSpace = rect.left;
    setPanelSide(rightSpace < panelWidth + gap && leftSpace > rightSpace ? "left" : "right");
  }

  return (
    <article
      ref={cardRef}
      className={`book-card panel-${panelSide} ${importStatus !== "ready" ? "has-import-state" : ""}`}
      onFocus={updatePanelSide}
      onMouseEnter={updatePanelSide}
    >
      <button className="book-open-area" onClick={onOpen} disabled={!canOpen} title={book.path}>
        <div className="book-cover-row">
          <BookCover book={book} progressValue={progressValue} />
          <div className="book-title-rail">
            <h3 title={book.title}>{book.title}</h3>
          </div>
        </div>
        <div className="book-card-summary">
          <span className="pill">{labelForContentType(book.contentType)}</span>
          <span className={`status-pill ${importStatus}`}>{statusLabel(importStatus)}</span>
          <span className="progress-text">{progress}</span>
        </div>
        {importStatus !== "ready" && (
          <div className="card-import-status">
            <span>{statusLabel(importStatus)}</span>
            <div className="mini-meter">
              <i style={{ width: `${Math.round((book.importProgress || 0) * 100)}%` }} />
            </div>
          </div>
        )}
        {book.importError && <p className="card-error">{book.importError}</p>}
      </button>

      <div className="book-hover-panel" aria-label={`${book.title} 详情`}>
        <div className="book-hover-heading">
          <strong title={book.title}>{book.title}</strong>
          <span className={`status-pill ${importStatus}`}>{statusLabel(importStatus)}</span>
        </div>
        <p className="book-hover-path" title={book.path}>{book.path}</p>
        <div className="book-detail-grid">
          <span>格式</span>
          <strong>{labelForFormat(book.format)}</strong>
          <span>模式</span>
          <strong>{labelForContentType(book.contentType)}</strong>
          <span>内容</span>
          <strong>{book.unitCount || 0} 单元 · {book.assetCount || 0} 资产</strong>
          <span>进度</span>
          <strong>{progress}</strong>
          <span>阅读</span>
          <strong>{lastReadText}</strong>
        </div>
        {book.importError && <p className="card-error">{book.importError}</p>}
        <div className="book-card-actions" aria-label={`${book.title} 操作`}>
          {canOpen && (
            <button className="icon-button primary-icon" onClick={onOpen} title="继续阅读">
              <Play size={16} />
            </button>
          )}
          {canToggleContent && (
            <button
              className="icon-button"
              onClick={() =>
                onUpdateBook({ contentType: book.contentType === "novel" ? "comic" : "novel" })
              }
              title={book.contentType === "novel" ? "切换为漫画模式" : "切换为小说模式"}
            >
              {book.contentType === "novel" ? <Images size={16} /> : <FileText size={16} />}
            </button>
          )}
          {(importStatus === "queued" || importStatus === "processing") && (
            <button className="icon-button" onClick={onCancelImport} title="取消导入">
              <CircleStop size={16} />
            </button>
          )}
          {(importStatus === "error" || importStatus === "stale" || importStatus === "cancelled") && (
            <button className="icon-button" onClick={onRebuild} title="重建数据库内容">
              <RefreshCw size={16} />
            </button>
          )}
          <button className="icon-button" onClick={onRemove} title="从书库移除">
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    </article>
  );
}

function BookCover({ book, progressValue }: { book: BookItem; progressValue: number }) {
  const assetUrl = book.coverAssetId ? window.ereader.getAssetUrl(book.coverAssetId) : null;
  const isTxtCover = !assetUrl && book.format === "txt";

  return (
    <div
      className={`book-cover ${book.contentType} ${assetUrl ? "asset-cover" : "generated-cover"}${isTxtCover ? " txt-cover" : ""}`}
    >
      {assetUrl ? (
        <img src={assetUrl} alt={`${book.title} 封面`} loading="lazy" />
      ) : (
        <div className="generated-cover-content">
          {isTxtCover ? (
            <>
              <strong>{book.title}</strong>
              <p>{book.coverExcerpt || "本地文本阅读"}</p>
            </>
          ) : (
            <>
              <span className="generated-cover-mark">{titleMark(book.title)}</span>
              <strong>{book.title}</strong>
              <small>{labelForFormat(book.format)}</small>
            </>
          )}
        </div>
      )}
      <div className="cover-progress" aria-hidden="true">
        <i style={{ width: `${progressValue}%` }} />
      </div>
    </div>
  );
}

function statusLabel(status: string) {
  if (status === "queued") return "排队";
  if (status === "processing") return "处理中";
  if (status === "ready") return "就绪";
  if (status === "error") return "错误";
  if (status === "stale") return "需重建";
  if (status === "cancelled") return "已取消";
  return status;
}

function isReady(book: BookItem) {
  return book.importStatus === "ready" || !book.importStatus;
}

function hasDraggedFiles(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function titleMark(title: string) {
  const compact = title.trim().replace(/\s+/g, "");
  return Array.from(compact || "书").slice(0, 2).join("");
}
