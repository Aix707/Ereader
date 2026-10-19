import type { BookFormat, BookItem, ImportStatus } from "../types";

const IMPORT_STATUS_LABELS: Record<ImportStatus, string> = {
  queued: "排队",
  processing: "处理中",
  ready: "就绪",
  error: "错误",
  stale: "需重建",
  cancelled: "已取消"
};

export function isBookReady(book: BookItem) {
  return (book.unitCount || 0) > 0 || book.importStatus === "ready" || !book.importStatus;
}

export function isImportInProgress(status?: ImportStatus | null) {
  return status === "queued" || status === "processing";
}

export function canRebuildImport(status?: ImportStatus | null) {
  return status === "error" || status === "stale" || status === "cancelled";
}

export function canToggleContentType(format: BookFormat) {
  return format === "pdf" || format === "epub" || format === "mobi";
}

export function canUseComicMode(format: BookFormat) {
  return canToggleContentType(format) || format === "image-folder";
}

export function usesPageReader(book: BookItem) {
  return book.contentType === "comic" || book.format === "pdf" || book.format === "image-folder";
}

export function usesGeneratedTextCover(format: BookFormat) {
  return format === "txt" || format === "mobi";
}

export function summarizeLibrary(books: BookItem[]) {
  const summary = {
    total: books.length,
    ready: 0, recent: 0, novels: 0, comics: 0,
    continueBook: null as BookItem | null
  };
  for (const book of books) {
    const ready = isBookReady(book);
    if (ready) summary.ready += 1;
    if (book.contentType === "novel") summary.novels += 1;
    if (book.contentType === "comic") summary.comics += 1;
    if (book.lastOpenedAt) {
      summary.recent += 1;
      if (ready && book.lastOpenedAt > (summary.continueBook?.lastOpenedAt || "")) summary.continueBook = book;
    }
  }
  return summary;
}

export function importStatusLabel(status?: string | null, labels: Partial<Record<ImportStatus, string>> = {}) {
  const normalized = status || "ready";
  if (isImportStatus(normalized)) return labels[normalized] || IMPORT_STATUS_LABELS[normalized];
  return normalized;
}

function isImportStatus(value: string): value is ImportStatus {
  return value in IMPORT_STATUS_LABELS;
}
