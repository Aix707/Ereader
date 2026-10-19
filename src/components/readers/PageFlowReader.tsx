import { ChevronLeft, ChevronRight } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, WheelEvent } from "react";
import {
  clampAndAlignIndex,
  getContainedSize,
  lastSpreadStartIndex,
  nextSpreadStart,
  pageIndexFromProgress,
  pageIndexesForPreload,
  pageIndexesForSpread,
  previousSpreadStart,
  spreadDisplayWidth
} from "../../lib/comicReading";
import { type ElementSize, useElementSize } from "../../lib/elementSize";
import type { CssVariableStyle } from "../../lib/style";
import type { BookItem, PageUnit, ReadingProgress } from "../../types";

interface PageFlowReaderProps {
  book: BookItem;
  showThumbnails: boolean;
  onProgress: (progress: Partial<ReadingProgress>) => void;
}

const PRELOAD_SPREAD_RADIUS = 1;
const DECODE_CACHE_MAX_ASSETS = 8;
const DECODE_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const WHEEL_PAGE_THRESHOLD = 48;
const WHEEL_COOLDOWN_MS = 180;
const THUMBNAIL_OVERSCAN_ITEMS = 8;
const COMIC_LAYOUT = {
  pageGap: 12,
  sideGutter: 48,
  verticalGutter: 12,
  thumbnailInset: 12,
  thumbnailWidth: 128,
  thumbnailBottomReserve: 58,
  thumbnailItemHeight: 112,
  thumbnailGap: 8,
  safeGap: 12,
  pageTurnLeft: 18,
  pageTurnWidth: 42
} as const;
const THUMBNAIL_RESERVE = COMIC_LAYOUT.thumbnailInset + COMIC_LAYOUT.thumbnailWidth + COMIC_LAYOUT.safeGap;
const CONTENT_SAFE_LEFT_WITH_THUMBNAILS =
  THUMBNAIL_RESERVE + COMIC_LAYOUT.pageTurnLeft + COMIC_LAYOUT.pageTurnWidth + COMIC_LAYOUT.safeGap;

interface DecodeCacheEntry {
  image: HTMLImageElement;
  byteLength: number;
  lastUsed: number;
}

type ComicCssVariables = CssVariableStyle<`comic-${string}`>;

export const PageFlowReader = memo(function PageFlowReader({ book, showThumbnails, onProgress }: PageFlowReaderProps) {
  const [pages, setPages] = useState<PageUnit[]>([]);
  const [currentIndex, setCurrentIndex] = useState(() => pageIndexFromProgress(book.progress));
  const [isJumping, setIsJumping] = useState(false);
  const [jumpValue, setJumpValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const readerRef = useRef<HTMLDivElement | null>(null);
  const jumpInputRef = useRef<HTMLInputElement | null>(null);
  const wheelDeltaRef = useRef(0);
  const lastWheelDirectionRef = useRef(0);
  const lastWheelAtRef = useRef(0);
  const decodeCacheRef = useRef<Map<number, DecodeCacheEntry>>(new Map());
  const didRestoreProgressRef = useRef(false);
  const readerSize = useElementSize(readerRef, pages.length);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPages([]);
    setCurrentIndex(pageIndexFromProgress(book.progress));
    setIsJumping(false);
    didRestoreProgressRef.current = false;
    clearDecodeCache(decodeCacheRef.current);
    wheelDeltaRef.current = 0;
    lastWheelDirectionRef.current = 0;
    window.ereader
      .getPageUnits(book.id)
      .then((items) => { if (!cancelled) setPages(items); })
      .catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => {
      cancelled = true;
      clearDecodeCache(decodeCacheRef.current);
    };
  }, [book.id, book.renditionVersion]);

  const spreadSize = book.preferences.pageSpread === "double" ? 2 : 1;
  const lastSpreadStart = useMemo(
    () => lastSpreadStartIndex(pages.length, spreadSize),
    [pages.length, spreadSize]
  );
  const visiblePages = useMemo(() => {
    const indexes = pageIndexesForSpread(currentIndex, spreadSize, pages.length);
    const spread = indexes.map((index) => pages[index]).filter((page): page is PageUnit => Boolean(page));
    return book.preferences.readingDirection === "rtl" ? [...spread].reverse() : spread;
  }, [book.preferences.readingDirection, currentIndex, pages, spreadSize]);

  const activePageIndexes = useMemo(
    () => new Set(pageIndexesForSpread(currentIndex, spreadSize, pages.length)),
    [currentIndex, pages.length, spreadSize]
  );

  const preloadAroundIndex = useCallback(
    (targetIndex: number, radius = PRELOAD_SPREAD_RADIUS) => {
      if (!pages.length) return;
      const cache = decodeCacheRef.current;
      const protectedAssetIds = new Set(pageIndexesForSpread(targetIndex, spreadSize, pages.length)
        .map((index) => pages[index].assetId));
      const indexes = pageIndexesForPreload(targetIndex, spreadSize, pages.length, radius)
        .sort((left, right) => Math.abs(right - targetIndex) - Math.abs(left - targetIndex));
      for (const index of indexes) {
        const page = pages[index];
        if (!page?.assetId) continue;
        warmDecodePage(cache, page);
      }
      pruneDecodeCache(cache, protectedAssetIds);
    },
    [pages, spreadSize]
  );

  const goToIndex = useCallback(
    (targetIndex: number) => {
      const nextIndex = clampAndAlignIndex(targetIndex, pages.length, spreadSize);
      setCurrentIndex(nextIndex);
    },
    [pages.length, spreadSize]
  );

  const goNext = useCallback(() => {
    goToIndex(nextSpreadStart(currentIndex, pages.length, spreadSize));
  }, [currentIndex, goToIndex, pages.length, spreadSize]);

  const goPrevious = useCallback(() => {
    goToIndex(previousSpreadStart(currentIndex, spreadSize));
  }, [currentIndex, goToIndex, spreadSize]);

  const openPageJump = useCallback(() => {
    setJumpValue(String(currentIndex + 1));
    setIsJumping(true);
  }, [currentIndex]);

  const applyPageJump = useCallback(() => {
    const parsed = Number.parseInt(jumpValue, 10);
    if (Number.isFinite(parsed)) {
      const nextPage = Math.max(1, Math.min(pages.length, parsed));
      goToIndex(nextPage - 1);
    }
    setIsJumping(false);
  }, [goToIndex, jumpValue, pages.length]);

  const handleJumpKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        applyPageJump();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setIsJumping(false);
      }
    },
    [applyPageJump]
  );

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (event.ctrlKey || event.metaKey || target.closest("input")) return;
      if (Math.abs(event.deltaY) < 4 || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;

      event.preventDefault();
      const direction = event.deltaY > 0 ? 1 : -1;
      if (lastWheelDirectionRef.current !== 0 && lastWheelDirectionRef.current !== direction) {
        wheelDeltaRef.current = 0;
      }
      lastWheelDirectionRef.current = direction;
      wheelDeltaRef.current += event.deltaY;
      if (Math.abs(wheelDeltaRef.current) < WHEEL_PAGE_THRESHOLD) return;

      const now = Date.now();
      if (now - lastWheelAtRef.current < WHEEL_COOLDOWN_MS) {
        wheelDeltaRef.current = 0;
        return;
      }

      if (wheelDeltaRef.current > 0) {
        goNext();
      } else {
        goPrevious();
      }
      lastWheelAtRef.current = now;
      wheelDeltaRef.current = 0;
    },
    [goNext, goPrevious]
  );

  useEffect(() => {
    if (!pages.length) return;
    setCurrentIndex((index) => {
      const nextIndex = clampAndAlignIndex(index, pages.length, spreadSize);
      return nextIndex;
    });
  }, [pages.length, spreadSize]);

  const fullPageBounds = useMemo(
    () => comicPageBounds(readerSize, visiblePages.length),
    [readerSize.height, readerSize.width, visiblePages.length]
  );

  const sidebarReserve = useMemo(
    () => thumbnailSidebarReserve(showThumbnails, visiblePages, readerSize.width, fullPageBounds),
    [fullPageBounds, readerSize.width, showThumbnails, visiblePages]
  );

  const pageBounds = useMemo(
    () => comicPageBounds(readerSize, visiblePages.length, sidebarReserve),
    [readerSize.height, readerSize.width, sidebarReserve, visiblePages.length]
  );

  const comicLayoutStyle = useMemo(
    () => comicLayoutVariables(showThumbnails, sidebarReserve),
    [showThumbnails, sidebarReserve]
  );

  useEffect(() => {
    if (!pages.length) return;
    const page = Math.min(currentIndex + 1, pages.length);
    const percent = pages.length <= 1 ? 1 : currentIndex / (pages.length - 1);
    if (!didRestoreProgressRef.current) {
      didRestoreProgressRef.current = true;
      return;
    }
    onProgress({ kind: "page", page, totalPages: pages.length, percent });
  }, [currentIndex, pages.length, onProgress]);

  useEffect(() => {
    if (!isJumping) return;
    const frame = window.requestAnimationFrame(() => {
      jumpInputRef.current?.focus();
      jumpInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isJumping]);

  useEffect(() => {
    if (!pages.length) return;
    preloadAroundIndex(currentIndex);
  }, [currentIndex, pages.length, preloadAroundIndex]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (target.closest("input")) return;
      if (event.key === "ArrowRight") {
        book.preferences.readingDirection === "rtl" ? goPrevious() : goNext();
      }
      if (event.key === "ArrowLeft") {
        book.preferences.readingDirection === "rtl" ? goNext() : goPrevious();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [book.preferences.readingDirection, goNext, goPrevious]);

  if (error) return <div className="reader-error">{error}</div>;
  if (!pages.length) return <div className="reader-loading">正在读取页面缓存...</div>;

  return (
    <div className="page-reader-layout" style={comicLayoutStyle}>
      {showThumbnails && (
        <ComicThumbnailPanel
          pages={pages}
          currentIndex={currentIndex}
          activePageIndexes={activePageIndexes}
          onSelect={goToIndex}
        />
      )}
      <div ref={readerRef} className="comic-reader" onWheel={handleWheel}>
        <button className="page-turn left" onClick={goPrevious} disabled={currentIndex <= 0} title="上一页" aria-label="上一页">
          <ChevronLeft size={22} />
        </button>
        <div className={`comic-pages ${visiblePages.length > 1 ? "double-spread" : "single-spread"}`}>
          {visiblePages.map((page) => (
            <PageImage key={page.id} page={page} maxWidth={pageBounds.width} maxHeight={pageBounds.height} />
          ))}
        </div>
        <button className="page-turn right" onClick={goNext} disabled={currentIndex >= lastSpreadStart} title="下一页" aria-label="下一页">
          <ChevronRight size={22} />
        </button>
        <div className="floating-page-indicator" data-ui-popover={isJumping || undefined}>
          {isJumping ? (
            <input
              ref={jumpInputRef}
              value={jumpValue}
              onChange={(event) => setJumpValue(event.target.value)}
              onKeyDown={handleJumpKeyDown}
              onBlur={applyPageJump}
              inputMode="numeric"
              aria-label="跳转页码"
            />
          ) : (
            <button type="button" onClick={openPageJump} title="跳转页码" aria-label="跳转页码">
              {currentIndex + 1}/{pages.length}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

function PageImage({ page, maxWidth, maxHeight }: { page: PageUnit; maxWidth: number; maxHeight: number }) {
  const displaySize = useMemo(
    () => getContainedSize(page.width, page.height, maxWidth, maxHeight),
    [maxHeight, maxWidth, page.height, page.width]
  );

  return (
    <div
      className="image-page-holder"
      style={{
        width: displaySize ? `${displaySize.width}px` : undefined,
        height: displaySize ? `${displaySize.height}px` : undefined,
        aspectRatio: page.width && page.height ? `${page.width} / ${page.height}` : undefined
      }}
    >
      {displaySize ? (
        <img
          className="comic-image"
          src={window.ereader.getAssetUrl(page.assetId)}
          alt={page.title || `第${page.unitIndex + 1}页`}
          width={page.width || undefined}
          height={page.height || undefined}
          loading="eager"
          decoding="async"
        />
      ) : (
        <span>载入中</span>
      )}
    </div>
  );
}

function ComicThumbnailPanel({
  pages,
  currentIndex,
  activePageIndexes,
  onSelect
}: {
  pages: PageUnit[];
  currentIndex: number;
  activePageIndexes: Set<number>;
  onSelect: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [renderRange, setRenderRange] = useState({ start: 0, end: 28 });
  const itemStride = COMIC_LAYOUT.thumbnailItemHeight + COMIC_LAYOUT.thumbnailGap;

  const updateRenderRange = useCallback(() => {
    const element = listRef.current;
    if (!element) return;
    const start = Math.max(
      0,
      Math.floor(element.scrollTop / itemStride) - THUMBNAIL_OVERSCAN_ITEMS
    );
    const visible = Math.ceil(element.clientHeight / itemStride) + THUMBNAIL_OVERSCAN_ITEMS * 2;
    const end = Math.min(pages.length - 1, start + visible);
    setRenderRange((current) => (current.start === start && current.end === end ? current : { start, end }));
  }, [itemStride, pages.length]);

  useEffect(() => {
    updateRenderRange();
    const element = listRef.current;
    if (!element) return;
    const observer = new ResizeObserver(updateRenderRange);
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateRenderRange]);

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const top = currentIndex * itemStride;
    const bottom = top + COMIC_LAYOUT.thumbnailItemHeight + COMIC_LAYOUT.thumbnailGap * 2;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
    updateRenderRange();
  }, [currentIndex, itemStride, updateRenderRange]);

  return (
    <aside className="toc-panel comic-thumbnail-panel">
      <div className="toc-header">
        <strong>缩略图</strong>
        <span>{pages.length} 页</span>
      </div>
      <div ref={listRef} className="comic-thumbnail-list" onScroll={updateRenderRange}>
        <div className="comic-thumbnail-window" style={{ height: Math.max(0, pages.length * itemStride - COMIC_LAYOUT.thumbnailGap) }}>
          {pages.slice(renderRange.start, renderRange.end + 1).map((page, offset) => {
            const index = renderRange.start + offset;
            return (
              <button
                key={page.id}
                className={activePageIndexes.has(index) ? "active" : ""}
                data-page-index={index}
                style={{ top: index * itemStride, height: COMIC_LAYOUT.thumbnailItemHeight }}
                onClick={() => onSelect(index)}
                title={`第 ${index + 1} 页`}
              >
                <span className="comic-thumbnail-card">
                  <span className="comic-thumbnail-frame">
                    <ThumbnailImage page={page} />
                  </span>
                  <strong>{index + 1}</strong>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

function ThumbnailImage({ page }: { page: PageUnit }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <i />;
  return (
    <img
      src={window.ereader.getAssetUrl(page.assetId)}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

function comicPageBounds(readerSize: ElementSize, visiblePageCount: number, sidebarReserve = 0) {
  const columns = visiblePageCount > 1 ? 2 : 1;
  return {
    width: Math.max(
      0,
      (readerSize.width - COMIC_LAYOUT.sideGutter * 2 - sidebarReserve - COMIC_LAYOUT.pageGap * (columns - 1)) /
        columns
    ),
    height: Math.max(0, readerSize.height - COMIC_LAYOUT.verticalGutter)
  };
}

function thumbnailSidebarReserve(showThumbnails: boolean, pages: PageUnit[], readerWidth: number, fullBounds: ElementSize) {
  if (!showThumbnails || !pages.length || readerWidth <= 0) return 0;
  const spreadWidth = spreadDisplayWidth(pages, fullBounds, COMIC_LAYOUT.pageGap);
  if (spreadWidth <= 0) return 0;
  const spreadLeftEdge = (readerWidth - spreadWidth) / 2;
  return spreadLeftEdge < CONTENT_SAFE_LEFT_WITH_THUMBNAILS ? THUMBNAIL_RESERVE : 0;
}

function comicLayoutVariables(showThumbnails: boolean, sidebarReserve: number): ComicCssVariables {
  return {
    "--comic-page-gap": `${COMIC_LAYOUT.pageGap}px`,
    "--comic-side-gutter": `${COMIC_LAYOUT.sideGutter}px`,
    "--comic-vertical-gutter": `${COMIC_LAYOUT.verticalGutter}px`,
    "--comic-control-reserve": `${showThumbnails ? THUMBNAIL_RESERVE : 0}px`,
    "--comic-sidebar-reserve": `${sidebarReserve}px`,
    "--comic-thumbnail-bottom-reserve": `${COMIC_LAYOUT.thumbnailBottomReserve}px`,
    "--comic-thumbnail-item-height": `${COMIC_LAYOUT.thumbnailItemHeight}px`,
    "--comic-thumbnail-inset": `${COMIC_LAYOUT.thumbnailInset}px`,
    "--comic-thumbnail-width": `${COMIC_LAYOUT.thumbnailWidth}px`,
    "--comic-page-turn-left": `${COMIC_LAYOUT.pageTurnLeft}px`,
    "--comic-page-turn-width": `${COMIC_LAYOUT.pageTurnWidth}px`
  };
}

function warmDecodePage(cache: Map<number, DecodeCacheEntry>, page: PageUnit) {
  const now = Date.now();
  const cached = cache.get(page.assetId);
  if (cached) {
    cached.lastUsed = now;
    return;
  }

  const image = new window.Image();
  const url = window.ereader.getAssetUrl(page.assetId);
  image.loading = "eager";
  image.decoding = "async";
  const entry: DecodeCacheEntry = {
    image,
    byteLength: Math.max(page.byteLength || 0, page.width * page.height * 4),
    lastUsed: now
  };
  cache.set(page.assetId, entry);
  decodeImage(image, url).catch(() => undefined);
}

function decodeImage(image: HTMLImageElement, url: string) {
  if (typeof image.decode === "function") {
    image.src = url;
    return image.decode();
  }
  return new Promise<void>((resolve) => {
    image.onload = () => resolve();
    image.onerror = () => resolve();
    image.src = url;
  });
}

function pruneDecodeCache(cache: Map<number, DecodeCacheEntry>, protectedAssetIds: Set<number>) {
  let totalBytes = 0;
  for (const entry of cache.values()) totalBytes += entry.byteLength;

  while (cache.size > DECODE_CACHE_MAX_ASSETS || totalBytes > DECODE_CACHE_MAX_BYTES) {
    const candidate = [...cache.entries()]
      .filter(([assetId]) => !protectedAssetIds.has(assetId))
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
    if (!candidate) break;
    cache.delete(candidate[0]);
    releaseDecodedImage(candidate[1]);
    totalBytes -= candidate[1].byteLength;
  }
}

function releaseDecodedImage(entry: DecodeCacheEntry) {
  entry.image.onload = null;
  entry.image.onerror = null;
  entry.image.removeAttribute("src");
}

function clearDecodeCache(cache: Map<number, DecodeCacheEntry>) {
  for (const entry of cache.values()) releaseDecodedImage(entry);
  cache.clear();
}
