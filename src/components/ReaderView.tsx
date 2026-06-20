import {
  ArrowLeft,
  BookText,
  ChevronsLeft,
  ChevronsRight,
  Columns2,
  Images,
  Minus,
  PanelLeftOpen,
  PanelLeftClose,
  Plus,
  RectangleHorizontal
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { PageFlowReader } from "./readers/PageFlowReader";
import { TextFlowReader } from "./readers/TextFlowReader";
import { WindowControls } from "./WindowControls";
import type { BookItem, BookPatch, ContentType, PageSpread, ReaderPreferences, ReadingDirection, ReadingProgress } from "../types";
import { formatPercent, labelForContentType, labelForFormat } from "../lib/format";

interface ReaderViewProps {
  book: BookItem;
  onBack: () => void;
  onUpdateBook: (id: string, patch: BookPatch) => Promise<BookItem>;
}

export function ReaderView({ book, onBack, onUpdateBook }: ReaderViewProps) {
  const [progressPercent, setProgressPercent] = useState(book.progress.percent || 0);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [showToc, setShowToc] = useState(true);
  const saveTimer = useRef<number | null>(null);
  const pendingProgress = useRef<Partial<ReadingProgress> | null>(null);
  const chromeTimer = useRef<number | null>(null);

  const persistProgress = useCallback(
    (progress: Partial<ReadingProgress>) => {
      onUpdateBook(book.id, {
        progress,
        lastOpenedAt: new Date().toISOString()
      }).catch(() => undefined);
    },
    [book.id, onUpdateBook]
  );

  const flushPendingProgress = useCallback(() => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const progress = pendingProgress.current;
    pendingProgress.current = null;
    if (progress) persistProgress(progress);
  }, [persistProgress]);

  const saveProgress = useCallback(
    (progress: Partial<ReadingProgress>) => {
      if (typeof progress.percent === "number") setProgressPercent(progress.percent);
      pendingProgress.current = progress;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        const nextProgress = pendingProgress.current;
        pendingProgress.current = null;
        saveTimer.current = null;
        if (nextProgress) persistProgress(nextProgress);
      }, 350);
    },
    [persistProgress]
  );

  const clearChromeHideTimer = useCallback(() => {
    if (chromeTimer.current) {
      window.clearTimeout(chromeTimer.current);
      chromeTimer.current = null;
    }
  }, []);

  const scheduleChromeHide = useCallback(() => {
    if (!isFullScreen) return;
    clearChromeHideTimer();
    chromeTimer.current = window.setTimeout(() => setChromeVisible(false), 1800);
  }, [clearChromeHideTimer, isFullScreen]);

  const revealChrome = useCallback(() => {
    if (!isFullScreen) return;
    setChromeVisible(true);
    scheduleChromeHide();
  }, [isFullScreen, scheduleChromeHide]);

  const updatePreference = useCallback(
    (preferences: Partial<ReaderPreferences>) => {
      onUpdateBook(book.id, { preferences }).catch(() => undefined);
    },
    [book.id, onUpdateBook]
  );

  const updateContentType = useCallback(
    (contentType: ContentType) => {
      onUpdateBook(book.id, { contentType }).catch(() => undefined);
    },
    [book.id, onUpdateBook]
  );

  const ignoreProgressLabel = useCallback(() => undefined, []);

  const handleToolbarDoubleClick = useCallback((event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, .segmented-control, .window-controls")) return;
    window.ereader.windowControls.toggleMaximize().catch(() => undefined);
  }, []);

  useEffect(() => {
    setProgressPercent(book.progress.percent || 0);
  }, [book.id, book.progress.percent]);

  useEffect(() => {
    return () => {
      flushPendingProgress();
      clearChromeHideTimer();
    };
  }, [clearChromeHideTimer, flushPendingProgress]);

  useEffect(() => {
    let cleanup: () => void = () => undefined;
    window.ereader.windowControls.getState().then((state) => setIsFullScreen(state.isFullScreen)).catch(() => undefined);
    cleanup = window.ereader.windowControls.onStateChanged((state) => setIsFullScreen(state.isFullScreen));
    return cleanup;
  }, []);

  useEffect(() => {
    if (!isFullScreen) {
      setChromeVisible(true);
      clearChromeHideTimer();
      return;
    }
    revealChrome();
  }, [clearChromeHideTimer, isFullScreen, revealChrome]);

  const canBeComic = book.format === "pdf" || book.format === "epub" || book.format === "image-folder";
  const isComic = book.contentType === "comic";
  const isReady = book.importStatus === "ready" || !book.importStatus;
  const usePageReader = book.contentType === "comic" || book.format === "pdf" || book.format === "image-folder";

  return (
    <main
      className={`reader-shell${isFullScreen ? " fullscreen" : ""}${isFullScreen && !chromeVisible ? " chrome-hidden" : ""}`}
      onMouseMove={revealChrome}
      onFocusCapture={revealChrome}
    >
      <header
        className="reader-toolbar"
        onDoubleClick={handleToolbarDoubleClick}
        onMouseEnter={clearChromeHideTimer}
        onMouseLeave={scheduleChromeHide}
      >
        <div className="reader-left-tools">
          <div className="topbar-title-island reader-title" title={`${book.title} · ${labelForFormat(book.format)} · ${labelForContentType(book.contentType)}`}>
            <button className="topbar-island-button" onClick={onBack} title="返回书架" aria-label="返回书架">
              <ArrowLeft size={17} />
            </button>
            <h1>{book.title}</h1>
          </div>
        </div>

        <div className="reader-tools">
          {canBeComic && (
            <SegmentedControl
              value={book.contentType}
              options={[
                { value: "novel", label: "小说模式", icon: <BookText size={15} /> },
                { value: "comic", label: "漫画模式", icon: <Images size={15} /> }
              ]}
              onChange={(value) => updateContentType(value as ContentType)}
            />
          )}

          {isComic && (
            <>
              <SegmentedControl
                value={book.preferences.pageSpread}
                options={[
                  { value: "single", label: "单页", icon: <RectangleHorizontal size={15} /> },
                  { value: "double", label: "双页", icon: <Columns2 size={15} /> }
                ]}
                onChange={(value) => updatePreference({ pageSpread: value as PageSpread })}
              />
              <SegmentedControl
                value={book.preferences.readingDirection}
                options={[
                  { value: "ltr", label: "左到右阅读", icon: <ChevronsRight size={15} /> },
                  { value: "rtl", label: "右到左阅读", icon: <ChevronsLeft size={15} /> }
                ]}
                onChange={(value) => updatePreference({ readingDirection: value as ReadingDirection })}
              />
            </>
          )}

          {!isComic && (
            <div className="size-tools">
              <button
                className="toolbar-button"
                onClick={() => updatePreference({ fontSize: Math.max(14, book.preferences.fontSize - 1) })}
                title="减小字号"
              >
                <Minus size={16} />
              </button>
              <span>{book.preferences.fontSize}px</span>
              <button
                className="toolbar-button"
                onClick={() => updatePreference({ fontSize: Math.min(28, book.preferences.fontSize + 1) })}
                title="增大字号"
              >
                <Plus size={16} />
              </button>
            </div>
          )}
          <WindowControls />
        </div>
      </header>

      <section className="reader-stage">
        {!isReady ? (
          <div className="reader-processing">
            <h2>{book.importStatus === "error" ? "处理失败" : "正在处理导入内容"}</h2>
            <p>{book.importError || "导入内容会写入 SQLite 数据库，完成后即可阅读。"}</p>
            <div className="processing-meter">
              <span style={{ width: `${Math.round((book.importProgress || 0) * 100)}%` }} />
            </div>
          </div>
        ) : usePageReader ? (
          <PageFlowReader
            book={book}
            onProgress={saveProgress}
            onProgressLabel={ignoreProgressLabel}
          />
        ) : (
          <TextFlowReader
            book={book}
            showToc={showToc}
            onProgress={saveProgress}
            onProgressLabel={ignoreProgressLabel}
          />
        )}
      </section>

      {!usePageReader && (
        <footer className="reader-status">
          <div className="reader-status-group">
            <button
              className="reader-status-button"
              onClick={() => setShowToc((value) => !value)}
              title={showToc ? "隐藏目录" : "显示目录"}
              aria-label={showToc ? "隐藏目录" : "显示目录"}
            >
              {showToc ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
            </button>
            <span>{formatPercent(progressPercent)}</span>
          </div>
        </footer>
      )}
    </main>
  );
}

function SegmentedControl({
  value,
  options,
  onChange
}: {
  value: string;
  options: Array<{ value: string; label: string; icon: React.ReactNode }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="segmented-control">
      {options.map((option) => (
        <button
          key={option.value}
          className={option.value === value ? "active" : ""}
          onClick={() => onChange(option.value)}
          title={option.label}
          aria-label={option.label}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}
