export type BookFormat = "txt" | "pdf" | "epub" | "image-folder";
export type ContentType = "novel" | "comic";
export type PageSpread = "single" | "double";
export type ReadingDirection = "ltr" | "rtl";
export type FitMode = "width" | "height" | "contain";

export interface ReaderPreferences {
  fontSize: number;
  lineHeight: number;
  pageSpread: PageSpread;
  readingDirection: ReadingDirection;
  fitMode: FitMode;
}

export interface ReadingProgress {
  kind: "none" | "scroll" | "page" | "cfi";
  percent?: number;
  page?: number;
  totalPages?: number;
  unitIndex?: number;
  scrollRatio?: number;
  locator?: string;
}

export interface BookItem {
  id: string;
  title: string;
  path: string;
  kind: "file" | "folder";
  format: BookFormat;
  contentType: ContentType;
  addedAt: string;
  updatedAt?: string;
  lastOpenedAt?: string | null;
  size?: number | null;
  sourceExists?: boolean;
  importStatus?: "queued" | "processing" | "ready" | "error" | "stale";
  importProgress?: number;
  importError?: string | null;
  unitCount?: number;
  assetCount?: number;
  progress: ReadingProgress;
  preferences: ReaderPreferences;
}

export interface LibraryStore {
  version: number;
  dbPath?: string;
  books: BookItem[];
}

export interface TextUnit {
  id: number;
  unitIndex: number;
  type: "heading" | "paragraph" | "html" | "image";
  title?: string | null;
  text?: string | null;
  html?: string | null;
  assetId?: number | null;
  mime?: string | null;
  width?: number | null;
  height?: number | null;
  byteLength?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface PageUnit {
  id: number;
  unitIndex: number;
  type: "page";
  title?: string | null;
  assetId: number;
  mime: string;
  width: number;
  height: number;
  byteLength: number;
  metadata?: Record<string, unknown> | null;
}

export interface DiagnosticsSummary {
  dbPath: string;
  stats: {
    books: number;
    units: number;
    assets: number;
    assetBytes: number;
  };
  books: Array<{
    id: string;
    title: string;
    path: string;
    format: BookFormat;
    contentType: ContentType;
    importStatus: string;
    importProgress: number;
    importError?: string | null;
    unitCount: number;
    assetCount: number;
    diagnosticCount: number;
    sourceExists: boolean;
  }>;
  recentDiagnostics: Array<{
    id: number;
    bookId?: string | null;
    title?: string | null;
    level: string;
    message: string;
    details?: Record<string, unknown> | null;
    createdAt: string;
  }>;
}

export type BookPatch = Partial<
  Omit<BookItem, "id" | "path" | "format" | "kind" | "addedAt" | "progress" | "preferences">
> & {
  progress?: Partial<ReadingProgress>;
  preferences?: Partial<ReaderPreferences>;
};
