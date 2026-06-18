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
  MoreHorizontal,
  Search,
  Trash2
} from "lucide-react";
import { useMemo, useState } from "react";
import type { MouseEvent } from "react";
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
  onOpenBook,
  onRemoveBook,
  onUpdateBook,
  onRebuildBook,
  onCancelImport,
  onOpenDiagnostics
}: LibraryViewProps) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");

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

  const recent = store.books.filter((book) => book.lastOpenedAt).length;
  const novels = store.books.filter((book) => book.contentType === "novel").length;
  const comics = store.books.filter((book) => book.contentType === "comic").length;

  function handleTitlebarDoubleClick(event: MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("button, .window-controls")) return;
    window.ereader.windowControls.toggleMaximize().catch(() => undefined);
  }

  return (
    <main className="app-shell">
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
          <div>
            <p className="eyebrow">Library</p>
            <h2>阅读书架</h2>
          </div>
          <div className="search-box">
            <Search size={17} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题或路径"
            />
          </div>
        </header>

        {error && <div className="error-banner">{error}</div>}

        {isLoading ? (
          <div className="empty-state">正在载入书库...</div>
        ) : books.length === 0 ? (
          <div className="empty-state">
            <FileArchive size={34} />
            <h3>还没有可阅读内容</h3>
            <p>导入 txt、pdf、epub，或选择一个漫画图片文件夹开始。</p>
            <div className="empty-actions">
              <button className="primary-action" onClick={onImportFiles}>
                <Import size={17} />
                导入文件
              </button>
              <button className="secondary-action" onClick={onImportFolder}>
                <FolderOpen size={17} />
                导入文件夹
              </button>
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
  const icon = book.format === "image-folder" ? <Images size={24} /> : <BookOpen size={24} />;
  const progress = formatPercent(book.progress.percent || 0);
  const importStatus = book.importStatus || "ready";
  const canOpen = importStatus === "ready";

  return (
    <article className="book-card">
      <button className="book-open-area" onClick={onOpen} disabled={!canOpen}>
        <div className={`book-cover ${book.contentType}`}>
          {icon}
          <span>{labelForFormat(book.format)}</span>
        </div>
        <div className="book-meta">
          <div className="book-title-row">
            <h3 title={book.title}>{book.title}</h3>
          </div>
          <p title={book.path}>{book.path}</p>
          {importStatus !== "ready" && (
            <div className="card-import-status">
              <span>{statusLabel(importStatus)}</span>
              <div className="mini-meter">
                <i style={{ width: `${Math.round((book.importProgress || 0) * 100)}%` }} />
              </div>
            </div>
          )}
          {book.importError && <p className="card-error">{book.importError}</p>}
        </div>
      </button>
      <div className="book-footer">
        <div>
          <span className="pill">{labelForContentType(book.contentType)}</span>
          <span className={`status-pill ${importStatus}`}>{statusLabel(importStatus)}</span>
          <span className="progress-text">{book.unitCount || 0} 单元 · {progress}</span>
        </div>
        <div className="card-actions">
          {(book.format === "pdf" || book.format === "epub") && (
            <button
              className="icon-text-button"
              onClick={() =>
                onUpdateBook({ contentType: book.contentType === "novel" ? "comic" : "novel" })
              }
              title="切换小说/漫画模式"
            >
              <MoreHorizontal size={16} />
              {book.contentType === "novel" ? "转漫画" : "转小说"}
            </button>
          )}
          {(importStatus === "queued" || importStatus === "processing") && (
            <button className="icon-text-button" onClick={onCancelImport} title="取消导入">
              <CircleStop size={16} />
              取消
            </button>
          )}
          {(importStatus === "error" || importStatus === "stale" || importStatus === "cancelled") && (
            <button className="icon-text-button" onClick={onRebuild} title="重建数据库内容">
              <Import size={16} />
              重建
            </button>
          )}
          <button className="icon-button" onClick={onRemove} title="从书库移除">
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      <div className="book-subline">
        <span>{book.lastOpenedAt ? `最近 ${formatRelativeDate(book.lastOpenedAt)}` : "尚未阅读"}</span>
      </div>
    </article>
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
