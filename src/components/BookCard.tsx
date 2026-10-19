import { CircleStop, FileText, Images, RefreshCw, Trash2 } from "lucide-react";
import { memo, useRef, useState } from "react";
import type { BookItem, BookPatch } from "../types";
import {
  canRebuildImport,
  canToggleContentType,
  importStatusLabel,
  isBookReady,
  isImportInProgress,
  usesGeneratedTextCover
} from "../lib/book";
import { formatPercent, formatRelativeDate, labelForContentType, labelForFormat } from "../lib/format";
import { widthPercentStyle } from "../lib/style";

interface BookCardProps {
  book: BookItem;
  onOpen: (book: BookItem) => void;
  onRemove: (id: string) => Promise<void>;
  onUpdateBook: (id: string, patch: BookPatch) => Promise<BookItem>;
  onRebuild: (id: string) => Promise<void>;
  onCancelImport: (id: string) => Promise<void>;
}

export const BookCard = memo(function BookCard({ book, onOpen, onRemove, onUpdateBook, onRebuild, onCancelImport }: BookCardProps) {
  const progress = formatPercent(book.progress.percent || 0);
  const importStatus = book.importStatus || "ready";
  const canOpen = isBookReady(book);
  const processing = isImportInProgress(importStatus);
  const summaryLabel = processing ? "处理中" : importStatus === "ready"
    ? `${labelForContentType(book.contentType)}·${progress}`
    : importStatusLabel(importStatus, { error: "处理失败" });
  const canToggleContent = canToggleContentType(book.format);
  const cardRef = useRef<HTMLElement>(null);
  const [panelPosition, setPanelPosition] = useState<{ left: number; top: number; maxHeight?: number }>({ left: 0, top: 0 });
  const lastReadText = book.lastOpenedAt ? `最近 ${formatRelativeDate(book.lastOpenedAt)}` : "尚未阅读";

  function updatePanelSide() {
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const panel = cardRef.current?.querySelector<HTMLElement>(".book-hover-panel");
    const boundary = cardRef.current?.closest(".library-main")?.getBoundingClientRect();
    if (!panel || !boundary) return;
    const panelWidth = panel.offsetWidth, gap = 0;
    const rightSpace = boundary.right - rect.right, leftSpace = rect.left - boundary.left;
    const naturalHeight = panel.scrollHeight + 2;
    if (rightSpace < panelWidth && leftSpace < panelWidth) {
      const above = rect.top - 52, below = window.innerHeight - rect.bottom - 12;
      const showBelow = below >= above;
      const maxHeight = Math.min(naturalHeight, Math.max(80, showBelow ? below : above));
      const left = Math.max(boundary.left + 8, Math.min(rect.left + (rect.width - panelWidth) / 2, boundary.right - panelWidth - 8));
      setPanelPosition({ left: left - rect.left, top: showBelow ? rect.height : -maxHeight, maxHeight });
      return;
    }
    const preferred = rightSpace < panelWidth + gap && leftSpace > rightSpace ? rect.left - panelWidth - gap : rect.right + gap;
    const left = Math.max(boundary.left + 8, Math.min(preferred, boundary.right - panelWidth - 8));
    const maxHeight = Math.min(naturalHeight, window.innerHeight - 64);
    const top = Math.max(52, Math.min(rect.top, window.innerHeight - maxHeight - 12));
    setPanelPosition({ left: left - rect.left, top: top - rect.top, maxHeight });
  }

  return (
    <article
      ref={cardRef}
      className="book-card"
      onFocus={updatePanelSide}
      onMouseEnter={updatePanelSide}
    >
      <button className="book-open-area" onClick={() => onOpen(book)} disabled={!canOpen} title={book.path}>
        <div className="book-cover-row">
          <BookCover book={book} progressRatio={book.progress.percent || 0} />
          <div className="book-title-rail">
            <h3 title={book.title}>{book.title}</h3>
          </div>
        </div>
        <div className="book-card-summary">
          <span className={`book-summary-island ${importStatus}`}>{summaryLabel}</span>
        </div>
        {processing && (
          <div className="card-import-meter" role="progressbar" aria-label="导入进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((book.importProgress || 0) * 100)}>
            <i style={widthPercentStyle(book.importProgress || 0)} />
          </div>
        )}
      </button>

      <div className="book-hover-panel" style={panelPosition} aria-label={`${book.title} 详情`}>
        <div className="book-hover-heading">
          <strong title={book.title}>{book.title}</strong>
          <span className={`status-pill ${importStatus}`}>{importStatusLabel(importStatus)}</span>
        </div>
        <p className="book-hover-path" title={book.path}>{book.path}</p>
        <div className="book-detail-grid">
          <span>格式</span>
          <strong>{labelForFormat(book.format)}</strong>
          <span>模式</span>
          <strong>{labelForContentType(book.contentType)}</strong>
          <span>内容</span>
          <strong>{book.unitCount || 0} {book.contentType === "comic" || book.format === "pdf" ? "页" : "段"}</strong>
          <span>进度</span>
          <strong>{progress}</strong>
          {processing && <><span>导入进度</span><strong>{formatPercent(book.importProgress || 0)}</strong></>}
          <span>阅读</span>
          <strong>{lastReadText}</strong>
          <span>源文件</span>
          <strong>{book.sourceExists === false ? "缺失" : "存在"}</strong>
          <span>添加</span>
          <strong>{formatRelativeDate(book.addedAt)}</strong>
        </div>
        {book.importError && <p className="card-error">{book.importError}</p>}
      </div>

      <div className="card-floating-actions" aria-label={`${book.title} 操作`}>
        {isImportInProgress(importStatus) ? (
          <button className="card-action-button left" onClick={() => onCancelImport(book.id).catch(() => undefined)} title="取消导入" aria-label="取消导入">
            <CircleStop size={16} />
          </button>
        ) : canRebuildImport(importStatus) ? (
          <button className="card-action-button left" onClick={() => onRebuild(book.id).catch(() => undefined)} title="重新处理" aria-label="重新处理">
            <RefreshCw size={16} />
          </button>
        ) : canToggleContent ? (
          <button
            className="card-action-button left"
            onClick={() => onUpdateBook(book.id, { contentType: book.contentType === "novel" ? "comic" : "novel" }).catch(() => undefined)}
            title={book.contentType === "novel" ? "切换为漫画模式" : "切换为小说模式"}
            aria-label={book.contentType === "novel" ? "切换为漫画模式" : "切换为小说模式"}
          >
            {book.contentType === "novel" ? <Images size={16} /> : <FileText size={16} />}
          </button>
        ) : null}
        <button className="card-action-button right" onClick={() => onRemove(book.id).catch(() => undefined)} title="从书库移除" aria-label="从书库移除">
          <Trash2 size={16} />
        </button>
      </div>
    </article>
  );
});

function BookCover({ book, progressRatio }: { book: BookItem; progressRatio: number }) {
  const assetUrl = book.coverAssetId ? window.ereader.getAssetUrl(book.coverAssetId) : null;
  const isTextCover = !assetUrl && usesGeneratedTextCover(book.format);

  return (
    <div
      className={`book-cover ${book.contentType} ${assetUrl ? "asset-cover" : "generated-cover"}${isTextCover ? " txt-cover" : ""}`}
    >
      {assetUrl ? (
        <img src={assetUrl} alt={`${book.title} 封面`} loading="lazy" />
      ) : (
        <div className="generated-cover-content">
          {isTextCover ? (
            <>
              <strong>{book.title}</strong>
              {book.coverExcerpt && <p>{book.coverExcerpt}</p>}
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
        <i style={widthPercentStyle(progressRatio)} />
      </div>
    </div>
  );
}

function titleMark(title: string) {
  const compact = title.trim().replace(/\s+/g, "");
  return Array.from(compact || "书").slice(0, 2).join("");
}
