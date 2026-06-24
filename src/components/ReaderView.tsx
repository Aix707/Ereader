import {
  ArrowLeft,
  BookText,
  ChevronsLeft,
  ChevronsRight,
  Columns2,
  Images,
  PanelLeftOpen,
  PanelLeftClose,
  RectangleHorizontal,
  Search,
  Type
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { PageFlowReader } from "./readers/PageFlowReader";
import { TextFlowReader } from "./readers/TextFlowReader";
import { WindowControls } from "./WindowControls";
import type {
  AppSettings,
  BookItem,
  BookPatch,
  ContentType,
  NovelReadingSettings,
  PageSpread,
  ReaderPreferences,
  ReadingDirection,
  ReadingProgress,
  SystemFontItem
} from "../types";
import { formatPercent, labelForContentType, labelForFormat } from "../lib/format";

interface ReaderViewProps {
  book: BookItem;
  onBack: () => void;
  onUpdateBook: (id: string, patch: BookPatch) => Promise<BookItem>;
  appSettings: AppSettings;
  onUpdateAppSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
}

export function ReaderView({ book, onBack, onUpdateBook, appSettings, onUpdateAppSettings }: ReaderViewProps) {
  const [progressPercent, setProgressPercent] = useState(book.progress.percent || 0);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [showToc, setShowToc] = useState(true);
  const [typographyOpen, setTypographyOpen] = useState(false);
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

  const updateNovelReading = useCallback(
    (patch: Partial<NovelReadingSettings>) => {
      onUpdateAppSettings({
        novelReading: {
          ...appSettings.novelReading,
          ...patch
        }
      }).catch(() => undefined);
    },
    [appSettings.novelReading, onUpdateAppSettings]
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
  const sidePanelVisible = showToc && (!isFullScreen || chromeVisible);
  const sidePanelTitle = isComic
    ? showToc ? "隐藏缩略图" : "显示缩略图"
    : showToc ? "隐藏目录" : "显示目录";

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

          {!usePageReader && (
            <TypographyMenu
              open={typographyOpen}
              settings={appSettings.novelReading}
              onOpenChange={setTypographyOpen}
              onChange={updateNovelReading}
            />
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
            showThumbnails={sidePanelVisible}
            onProgress={saveProgress}
            onProgressLabel={ignoreProgressLabel}
          />
        ) : (
          <TextFlowReader
            book={book}
            showToc={sidePanelVisible}
            novelSettings={appSettings.novelReading}
            onProgress={saveProgress}
            onProgressLabel={ignoreProgressLabel}
          />
        )}
      </section>

      {isReady && (
        <footer className="reader-status">
          <div className="reader-status-group">
            <button
              className="reader-status-button"
              onClick={() => setShowToc((value) => !value)}
              title={sidePanelTitle}
              aria-label={sidePanelTitle}
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

function TypographyMenu({
  open,
  settings,
  onOpenChange,
  onChange
}: {
  open: boolean;
  settings: NovelReadingSettings;
  onOpenChange: (open: boolean) => void;
  onChange: (patch: Partial<NovelReadingSettings>) => void;
}) {
  const [fonts, setFonts] = useState<SystemFontItem[]>([]);
  const [query, setQuery] = useState("");
  const [isLoadingFonts, setIsLoadingFonts] = useState(false);
  const [fontWasReset, setFontWasReset] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setIsLoadingFonts(true);
    window.ereader
      .listSystemFonts()
      .then((items) => {
        if (!cancelled) setFonts(items);
      })
      .catch(() => {
        if (!cancelled) setFonts([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingFonts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current?.contains(event.target as Node)) return;
      onOpenChange(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onOpenChange(false);
    }
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onOpenChange, open]);

  const fontOptions = useMemo(() => {
    const seen = new Set<string>();
    const values: SystemFontItem[] = [{ family: "serif", source: "fallback" }, ...fonts];
    return values.filter((item) => {
      const key = item.family.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [fonts]);

  const selectedFontExists = useMemo(
    () => fontOptions.some((item) => item.family.toLowerCase() === settings.fontFamily.toLowerCase()),
    [fontOptions, settings.fontFamily]
  );

  useEffect(() => {
    if (!open || isLoadingFonts || selectedFontExists || fontWasReset) return;
    setFontWasReset(true);
    onChange({ fontFamily: "serif" });
  }, [fontWasReset, isLoadingFonts, onChange, open, selectedFontExists]);

  const filteredFonts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return fontOptions;
    return fontOptions.filter((item) => item.family.toLowerCase().includes(needle));
  }, [fontOptions, query]);

  return (
    <div className="typography-menu" ref={menuRef}>
      <button
        className={open ? "toolbar-button active" : "toolbar-button"}
        onClick={() => onOpenChange(!open)}
        title="小说排版"
        aria-label="小说排版"
      >
        <Type size={16} />
      </button>
      {open && (
        <div className="typography-popover">
          <header>
            <strong>小说排版</strong>
            <span>{settings.fontSize}px · {settings.lineHeight.toFixed(2)}</span>
          </header>

          <label className="typography-field">
            <span>
              字体
              {settings.fontFamily === "serif" && <em>系统默认衬线</em>}
            </span>
            <div className="font-search">
              <Search size={14} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索系统字体" />
            </div>
            <select
              value={selectedFontExists ? settings.fontFamily : "serif"}
              onChange={(event) => {
                setFontWasReset(false);
                onChange({ fontFamily: event.target.value });
              }}
            >
              {filteredFonts.map((font) => (
                <option key={`${font.source}:${font.family}`} value={font.family}>
                  {font.family === "serif" ? "系统默认衬线" : font.family}
                </option>
              ))}
            </select>
            {isLoadingFonts && <small>正在读取系统字体...</small>}
            {fontWasReset && <small>上次选择的字体不可用，已回退到默认字体。</small>}
          </label>

          <TypographyRange
            label="字号"
            value={settings.fontSize}
            min={16}
            max={28}
            step={1}
            suffix="px"
            onChange={(fontSize) => onChange({ fontSize })}
          />
          <TypographyRange
            label="行距"
            value={settings.lineHeight}
            min={1.45}
            max={2.2}
            step={0.05}
            onChange={(lineHeight) => onChange({ lineHeight })}
          />
          <TypographyRange
            label="段距"
            value={settings.paragraphSpacing}
            min={0.4}
            max={2.2}
            step={0.05}
            suffix="em"
            onChange={(paragraphSpacing) => onChange({ paragraphSpacing })}
          />
        </div>
      )}
    </div>
  );
}

function TypographyRange({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="typography-range">
      <span>
        {label}
        <strong>{formatSettingValue(value, suffix)}</strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function formatSettingValue(value: number, suffix: string) {
  if (suffix === "px") return `${Math.round(value)}px`;
  if (suffix === "em") return `${value.toFixed(2)}em`;
  return value.toFixed(2);
}
