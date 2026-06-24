import { CircleStop, FileText, Images, RefreshCw, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { BookItem, BookPatch } from "../types";
import { formatPercent, formatRelativeDate, labelForContentType, labelForFormat } from "../lib/format";
import { clampUnit } from "../lib/number";

interface BookCardProps {
  book: BookItem;
  onOpen: () => void;
  onRemove: () => Promise<void>;
  onUpdateBook: (patch: BookPatch) => Promise<BookItem>;
  onRebuild: () => Promise<void>;
  onCancelImport: () => Promise<void>;
}

export function BookCard({ book, onOpen, onRemove, onUpdateBook, onRebuild, onCancelImport }: BookCardProps) {
  const progress = formatPercent(book.progress.percent || 0);
  const progressValue = Math.round(clampUnit(book.progress.percent) * 100);
  const importStatus = book.importStatus || "ready";
  const canOpen = isBookReady(book);
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
          <span className="book-summary-island">
            <span>{labelForContentType(book.contentType)}</span>
            <i aria-hidden="true" />
            <span>{statusLabel(importStatus)}</span>
            <i aria-hidden="true" />
            <span>{progress}</span>
          </span>
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
          <span>源文件</span>
          <strong>{book.sourceExists === false ? "缺失" : "存在"}</strong>
          <span>添加</span>
          <strong>{formatRelativeDate(book.addedAt)}</strong>
        </div>
        {book.importError && <p className="card-error">{book.importError}</p>}
      </div>

      <div className="card-floating-actions" aria-label={`${book.title} 操作`}>
        {importStatus === "queued" || importStatus === "processing" ? (
          <button className="card-action-button left" onClick={onCancelImport} title="取消导入" aria-label="取消导入">
            <CircleStop size={16} />
          </button>
        ) : importStatus === "error" || importStatus === "stale" || importStatus === "cancelled" ? (
          <button className="card-action-button left" onClick={onRebuild} title="重建数据库内容" aria-label="重建数据库内容">
            <RefreshCw size={16} />
          </button>
        ) : canToggleContent ? (
          <button
            className="card-action-button left"
            onClick={() => onUpdateBook({ contentType: book.contentType === "novel" ? "comic" : "novel" })}
            title={book.contentType === "novel" ? "切换为漫画模式" : "切换为小说模式"}
            aria-label={book.contentType === "novel" ? "切换为漫画模式" : "切换为小说模式"}
          >
            {book.contentType === "novel" ? <Images size={16} /> : <FileText size={16} />}
          </button>
        ) : null}
        <button className="card-action-button right" onClick={onRemove} title="从书库移除" aria-label="从书库移除">
          <Trash2 size={16} />
        </button>
      </div>
    </article>
  );
}

export function isBookReady(book: BookItem) {
  return book.importStatus === "ready" || !book.importStatus;
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

function titleMark(title: string) {
  const compact = title.trim().replace(/\s+/g, "");
  return Array.from(compact || "书").slice(0, 2).join("");
}
