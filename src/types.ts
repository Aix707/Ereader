export type BookFormat = "txt" | "pdf" | "epub" | "image-folder";
export type ContentType = "novel" | "comic";
export type PageSpread = "single" | "double";
export type ReadingDirection = "ltr" | "rtl";

export interface NovelReadingSettings {
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  paragraphSpacing: number;
}

export interface AppSettings {
  novelReading: NovelReadingSettings;
}

export interface SystemFontItem {
  family: string;
  source: "system" | "fallback";
}

export const DEFAULT_NOVEL_READING_SETTINGS: NovelReadingSettings = {
  fontSize: 18,
  fontFamily: "serif",
  lineHeight: 1.8,
  paragraphSpacing: 1.1
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  novelReading: DEFAULT_NOVEL_READING_SETTINGS
};

export interface ReaderPreferences {
  fontSize: number;
  lineHeight: number;
  pageSpread: PageSpread;
  readingDirection: ReadingDirection;
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
  coverAssetId?: number | null;
  coverWidth?: number | null;
  coverHeight?: number | null;
  coverKind?: "asset" | "generated";
  coverExcerpt?: string | null;
  addedAt: string;
  updatedAt?: string;
  lastOpenedAt?: string | null;
  size?: number | null;
  sourceExists?: boolean;
  importStatus?: "queued" | "processing" | "ready" | "error" | "stale" | "cancelled";
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
    orphanAssets: number;
    missingAssets: number;
    readyWithoutUnits: number;
    largestAssetBytes: number;
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

export interface StatsSummary {
  generatedAt: string;
  overview: {
    totalBooks: number;
    readBooks: number;
    averageProgress: number;
    completedBooks: number;
    activeDays30: number;
    currentStreakDays: number;
  };
  habits: {
    activeDays30: number;
    currentStreakDays: number;
    recentOpenCount: number;
    favoriteContentType?: ContentType | null;
    favoriteFormat?: BookFormat | null;
  };
  progressBands: Array<{
    key: "not-started" | "reading" | "near-done" | "completed";
    label: string;
    count: number;
    ratio: number;
  }>;
  activityByDay: Array<{
    day: string;
    events: number;
    opens: number;
    progressEvents: number;
  }>;
  contentTypes: Array<{
    key: ContentType;
    count: number;
    ratio: number;
  }>;
  formats: Array<{
    key: BookFormat;
    count: number;
    ratio: number;
  }>;
  recentBooks: Array<{
    id: string;
    title: string;
    format: BookFormat;
    contentType: ContentType;
    coverAssetId?: number | null;
    coverKind?: "asset" | "generated";
    coverExcerpt?: string | null;
    progressPercent: number;
    lastOpenedAt?: string | null;
  }>;
  advanced: DiagnosticsSummary;
}

export interface ImportStateChange {
  type: "queued" | "started" | "progress" | "finished" | "error" | "cancelled";
  bookId: string;
  progress?: number;
  message?: string;
}

export type BookPatch = Partial<
  Omit<BookItem, "id" | "path" | "format" | "kind" | "addedAt" | "progress" | "preferences">
> & {
  progress?: Partial<ReadingProgress>;
  preferences?: Partial<ReaderPreferences>;
};
