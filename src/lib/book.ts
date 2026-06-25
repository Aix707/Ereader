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
  return book.importStatus === "ready" || !book.importStatus;
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
  const readyBooks = books.filter((book) => isBookReady(book));
  return {
    total: books.length,
    ready: readyBooks.length,
    recent: books.filter((book) => book.lastOpenedAt).length,
    novels: books.filter((book) => book.contentType === "novel").length,
    comics: books.filter((book) => book.contentType === "comic").length,
    continueBook:
      [...readyBooks]
        .filter((book) => book.lastOpenedAt)
        .sort((a, b) => new Date(b.lastOpenedAt || 0).getTime() - new Date(a.lastOpenedAt || 0).getTime())[0] || null
  };
}

export function importStatusLabel(status?: string | null, labels: Partial<Record<ImportStatus, string>> = {}) {
  const normalized = status || "ready";
  if (isImportStatus(normalized)) return labels[normalized] || IMPORT_STATUS_LABELS[normalized];
  return normalized;
}

function isImportStatus(value: string): value is ImportStatus {
  return value in IMPORT_STATUS_LABELS;
}
