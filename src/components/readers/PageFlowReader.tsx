import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, WheelEvent } from "react";
import type { BookItem, PageUnit, ReadingProgress } from "../../types";

interface PageFlowReaderProps {
  book: BookItem;
  showThumbnails: boolean;
  onProgress: (progress: Partial<ReadingProgress>) => void;
  onProgressLabel: (label: string) => void;
}

const PAGE_GAP = 12;
const PRELOAD_SPREAD_RADIUS = 2;
const HIDDEN_PRELOAD_SPREAD_RADIUS = 1;
const DECODE_CACHE_MAX_ASSETS = 18;
const DECODE_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const WHEEL_PAGE_THRESHOLD = 48;
const WHEEL_COOLDOWN_MS = 180;
const THUMBNAIL_ITEM_HEIGHT = 116;
const THUMBNAIL_OVERSCAN_ITEMS = 8;

interface DecodeCacheEntry {
  image: HTMLImageElement;
  url: string;
  byteLength: number;
  decoded: boolean;
  lastUsed: number;
  promise?: Promise<void>;
}

export function PageFlowReader({ book, showThumbnails, onProgress, onProgressLabel }: PageFlowReaderProps) {
  const [pages, setPages] = useState<PageUnit[]>([]);
  const [currentIndex, setCurrentIndex] = useState(() => pageIndexFromProgress(book.progress));
  const [isJumping, setIsJumping] = useState(false);
  const [jumpValue, setJumpValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const jumpInputRef = useRef<HTMLInputElement | null>(null);
  const wheelDeltaRef = useRef(0);
  const lastWheelDirectionRef = useRef(0);
  const lastWheelAtRef = useRef(0);
  const decodeCacheRef = useRef<Map<number, DecodeCacheEntry>>(new Map());
  const didRestoreProgressRef = useRef(false);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    setError(null);
    setPages([]);
    setCurrentIndex(pageIndexFromProgress(book.progress));
    setIsJumping(false);
    didRestoreProgressRef.current = false;
    decodeCacheRef.current.clear();
    wheelDeltaRef.current = 0;
    lastWheelDirectionRef.current = 0;
    window.ereader
      .getPageUnits(book.id)
      .then(setPages)
      .catch((reason) => setError(String(reason)));
  }, [book.id]);

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

  const hiddenPreloadPages = useMemo(() => {
    const visibleIds = new Set(visiblePages.map((page) => page.id));
    return pageIndexesForPreload(currentIndex, spreadSize, pages.length, HIDDEN_PRELOAD_SPREAD_RADIUS)
      .map((index) => pages[index])
      .filter((page): page is PageUnit => Boolean(page) && !visibleIds.has(page.id));
  }, [currentIndex, pages, spreadSize, visiblePages]);
  const activePageIndexes = useMemo(
    () => new Set(pageIndexesForSpread(currentIndex, spreadSize, pages.length)),
    [currentIndex, pages.length, spreadSize]
  );

  const preloadAroundIndex = useCallback(
    (targetIndex: number, radius = PRELOAD_SPREAD_RADIUS) => {
      if (!pages.length) return;
      const cache = decodeCacheRef.current;
      const protectedAssetIds = new Set<number>();
      for (const index of pageIndexesForPreload(targetIndex, spreadSize, pages.length, radius)) {
        const page = pages[index];
        if (!page?.assetId) continue;
        protectedAssetIds.add(page.assetId);
        warmDecodePage(cache, page);
      }
      pruneDecodeCache(cache, protectedAssetIds);
    },
    [pages, spreadSize]
  );

  const goToIndex = useCallback(
    (targetIndex: number) => {
      const nextIndex = clampAndAlignIndex(targetIndex, pages.length, spreadSize);
      preloadAroundIndex(nextIndex);
      setCurrentIndex(nextIndex);
    },
    [pages.length, preloadAroundIndex, spreadSize]
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
      preloadAroundIndex(nextIndex);
      return nextIndex;
    });
  }, [pages.length, preloadAroundIndex, spreadSize]);

  useEffect(() => {
    const element = pagesRef.current;
    if (!element) return;

    let animationFrame = 0;
    const measure = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        setStageSize({
          width: element.clientWidth,
          height: element.clientHeight
        });
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [pages.length]);

  const pageBounds = useMemo(() => {
    const columns = visiblePages.length > 1 ? 2 : 1;
    return {
      width: Math.max(0, (stageSize.width - PAGE_GAP * (columns - 1)) / columns),
      height: stageSize.height
    };
  }, [stageSize.height, stageSize.width, visiblePages.length]);

  useEffect(() => {
    if (!pages.length) return;
    const page = Math.min(currentIndex + 1, pages.length);
    const percent = pages.length <= 1 ? 1 : currentIndex / (pages.length - 1);
    onProgressLabel(`${page}/${pages.length}`);
    if (!didRestoreProgressRef.current) {
      didRestoreProgressRef.current = true;
      return;
    }
    onProgress({ kind: "page", page, totalPages: pages.length, percent });
  }, [currentIndex, pages.length, onProgress, onProgressLabel]);

  useEffect(() => {
    if (!isJumping) return;
    window.requestAnimationFrame(() => {
      jumpInputRef.current?.focus();
      jumpInputRef.current?.select();
    });
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
    <div className={`page-reader-layout${showThumbnails ? "" : " thumbnails-hidden"}`}>
      {showThumbnails && (
        <ComicThumbnailPanel
          pages={pages}
          currentIndex={currentIndex}
          activePageIndexes={activePageIndexes}
          onSelect={goToIndex}
        />
      )}
      <div className="comic-reader" onWheel={handleWheel} title="滚轮上下翻页，方向键左右翻页">
        <button className="page-turn left" onClick={goPrevious} disabled={currentIndex <= 0}>
          <ChevronLeft size={22} />
        </button>
        <div ref={pagesRef} className={`comic-pages ${visiblePages.length > 1 ? "double-spread" : "single-spread"}`}>
          {visiblePages.map((page) => (
            <PageImage key={page.id} page={page} maxWidth={pageBounds.width} maxHeight={pageBounds.height} />
          ))}
        </div>
        <div className="comic-preload-layer" aria-hidden="true">
          {hiddenPreloadPages.map((page) => (
            <img
              key={page.id}
              src={window.ereader.getAssetUrl(page.assetId)}
              alt=""
              loading="eager"
              decoding="async"
            />
          ))}
        </div>
        <button className="page-turn right" onClick={goNext} disabled={currentIndex >= lastSpreadStart}>
          <ChevronRight size={22} />
        </button>
        <div className="floating-page-indicator">
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
            <button type="button" onClick={openPageJump} title="跳转页码">
              {currentIndex + 1}/{pages.length}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

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
          alt={page.title || `Page ${page.unitIndex + 1}`}
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

  const updateRenderRange = useCallback(() => {
    const element = listRef.current;
    if (!element) return;
    const start = Math.max(0, Math.floor(element.scrollTop / THUMBNAIL_ITEM_HEIGHT) - THUMBNAIL_OVERSCAN_ITEMS);
    const visible = Math.ceil(element.clientHeight / THUMBNAIL_ITEM_HEIGHT) + THUMBNAIL_OVERSCAN_ITEMS * 2;
    const end = Math.min(pages.length - 1, start + visible);
    setRenderRange((current) => (current.start === start && current.end === end ? current : { start, end }));
  }, [pages.length]);

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
    const target = element?.querySelector<HTMLElement>(`[data-page-index="${currentIndex}"]`);
    target?.scrollIntoView({ block: "nearest" });
    window.requestAnimationFrame(updateRenderRange);
  }, [currentIndex, updateRenderRange]);

  return (
    <aside className="toc-panel comic-thumbnail-panel">
      <div className="toc-header">
        <strong>缩略图</strong>
        <span>{pages.length} 页</span>
      </div>
      <div ref={listRef} className="comic-thumbnail-list" onScroll={updateRenderRange}>
        {pages.map((page, index) => {
          const shouldLoad = index >= renderRange.start && index <= renderRange.end || Math.abs(index - currentIndex) <= 5;
          return (
            <button
              key={page.id}
              className={activePageIndexes.has(index) ? "active" : ""}
              data-page-index={index}
              onClick={() => onSelect(index)}
              title={`第 ${index + 1} 页`}
            >
              <span className="comic-thumbnail-frame">
                {shouldLoad ? <ThumbnailImage page={page} /> : <i />}
              </span>
              <strong>{index + 1}</strong>
            </button>
          );
        })}
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

function getContainedSize(sourceWidth: number, sourceHeight: number, maxWidth: number, maxHeight: number) {
  if (sourceWidth <= 0 || sourceHeight <= 0 || maxWidth <= 0 || maxHeight <= 0) return null;
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    width: Math.max(1, Math.floor(sourceWidth * scale)),
    height: Math.max(1, Math.floor(sourceHeight * scale))
  };
}

function pageIndexFromProgress(progress: ReadingProgress) {
  if (typeof progress.page === "number" && progress.page > 0) return Math.max(0, progress.page - 1);
  const percent = Number(progress.percent || 0);
  const totalPages = Number(progress.totalPages || 0);
  if (Number.isFinite(percent) && percent > 0 && totalPages > 1) {
    return Math.max(0, Math.round(Math.min(1, percent) * (totalPages - 1)));
  }
  return 0;
}

function alignToSpreadStart(index: number, spreadSize: number) {
  if (spreadSize <= 1 || index <= 0) return Math.max(0, index);
  return Math.max(1, 1 + Math.floor((index - 1) / spreadSize) * spreadSize);
}

function clampAndAlignIndex(index: number, totalPages: number, spreadSize: number) {
  if (totalPages <= 0) return 0;
  const clamped = Math.max(0, Math.min(totalPages - 1, index));
  return Math.max(0, Math.min(totalPages - 1, alignToSpreadStart(clamped, spreadSize)));
}

function pageIndexesForSpread(startIndex: number, spreadSize: number, totalPages: number) {
  if (totalPages <= 0) return [];
  const aligned = clampAndAlignIndex(startIndex, totalPages, spreadSize);
  if (spreadSize <= 1 || aligned === 0) return [aligned];
  const indexes: number[] = [];
  for (let index = aligned; index < aligned + spreadSize && index < totalPages; index += 1) {
    indexes.push(index);
  }
  return indexes;
}

function spreadStarts(totalPages: number, spreadSize: number) {
  if (totalPages <= 0) return [];
  if (spreadSize <= 1) return Array.from({ length: totalPages }, (_, index) => index);
  const starts = [0];
  for (let index = 1; index < totalPages; index += spreadSize) {
    starts.push(index);
  }
  return starts;
}

function lastSpreadStartIndex(totalPages: number, spreadSize: number) {
  const starts = spreadStarts(totalPages, spreadSize);
  return starts[starts.length - 1] || 0;
}

function nextSpreadStart(currentIndex: number, totalPages: number, spreadSize: number) {
  const starts = spreadStarts(totalPages, spreadSize);
  const current = clampAndAlignIndex(currentIndex, totalPages, spreadSize);
  const position = Math.max(0, starts.indexOf(current));
  return starts[Math.min(starts.length - 1, position + 1)] || current;
}

function previousSpreadStart(currentIndex: number, spreadSize: number) {
  if (spreadSize <= 1) return currentIndex - 1;
  if (currentIndex <= 1) return 0;
  return currentIndex - spreadSize;
}

function pageIndexesForPreload(centerIndex: number, spreadSize: number, totalPages: number, radius: number) {
  if (totalPages <= 0) return [];
  const indexes = new Set<number>();
  const starts = spreadStarts(totalPages, spreadSize);
  const spreadStart = clampAndAlignIndex(centerIndex, totalPages, spreadSize);
  const currentPosition = Math.max(0, starts.indexOf(spreadStart));
  const startPosition = Math.max(0, currentPosition - radius);
  const endPosition = Math.min(starts.length - 1, currentPosition + radius);
  for (let position = startPosition; position <= endPosition; position += 1) {
    for (const index of pageIndexesForSpread(starts[position], spreadSize, totalPages)) indexes.add(index);
  }
  return [...indexes].sort((left, right) => left - right);
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
    url,
    byteLength: page.byteLength || 0,
    decoded: false,
    lastUsed: now
  };
  cache.set(page.assetId, entry);
  entry.promise = decodeImage(image, url)
    .then(() => {
      entry.decoded = true;
      entry.lastUsed = Date.now();
    })
    .catch(() => undefined)
    .finally(() => {
      entry.promise = undefined;
    });
}

function decodeImage(image: HTMLImageElement, url: string) {
  image.src = url;
  if (typeof image.decode === "function") {
    return image.decode();
  }
  return new Promise<void>((resolve) => {
    image.onload = () => resolve();
    image.onerror = () => resolve();
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
    totalBytes -= candidate[1].byteLength;
  }
}
