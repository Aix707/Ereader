import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, WheelEvent } from "react";
import type { BookItem, PageUnit, ReadingProgress } from "../../types";

interface PageFlowReaderProps {
  book: BookItem;
  onProgress: (progress: Partial<ReadingProgress>) => void;
  onProgressLabel: (label: string) => void;
}

const PAGE_GAP = 12;
const WHEEL_PAGE_THRESHOLD = 70;
const WHEEL_COOLDOWN_MS = 260;

export function PageFlowReader({ book, onProgress, onProgressLabel }: PageFlowReaderProps) {
  const [pages, setPages] = useState<PageUnit[]>([]);
  const [currentIndex, setCurrentIndex] = useState(Math.max(0, (book.progress.page || 1) - 1));
  const [isJumping, setIsJumping] = useState(false);
  const [jumpValue, setJumpValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const jumpInputRef = useRef<HTMLInputElement | null>(null);
  const wheelDeltaRef = useRef(0);
  const lastWheelAtRef = useRef(0);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    setError(null);
    setPages([]);
    setCurrentIndex(Math.max(0, (book.progress.page || 1) - 1));
    setIsJumping(false);
    window.ereader
      .getPageUnits(book.id)
      .then(setPages)
      .catch((reason) => setError(String(reason)));
  }, [book.id]);

  const spreadSize = book.preferences.pageSpread === "double" ? 2 : 1;
  const visiblePages = useMemo(() => {
    const spread = pages.slice(currentIndex, currentIndex + spreadSize);
    return book.preferences.readingDirection === "rtl" ? [...spread].reverse() : spread;
  }, [book.preferences.readingDirection, currentIndex, pages, spreadSize]);

  const goNext = useCallback(() => {
    setCurrentIndex((index) => Math.min(Math.max(0, pages.length - 1), index + spreadSize));
  }, [pages.length, spreadSize]);

  const goPrevious = useCallback(() => {
    setCurrentIndex((index) => Math.max(0, index - spreadSize));
  }, [spreadSize]);

  const openPageJump = useCallback(() => {
    setJumpValue(String(currentIndex + 1));
    setIsJumping(true);
  }, [currentIndex]);

  const applyPageJump = useCallback(() => {
    const parsed = Number.parseInt(jumpValue, 10);
    if (Number.isFinite(parsed)) {
      const nextPage = Math.max(1, Math.min(pages.length, parsed));
      setCurrentIndex(alignToSpreadStart(nextPage - 1, spreadSize));
    }
    setIsJumping(false);
  }, [jumpValue, pages.length, spreadSize]);

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
    setCurrentIndex((index) => alignToSpreadStart(index, spreadSize));
  }, [spreadSize]);

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
    const preloadIndexes = new Set<number>();
    for (let index = currentIndex - spreadSize; index < currentIndex; index += 1) {
      if (index >= 0) preloadIndexes.add(index);
    }
    for (let index = currentIndex + spreadSize; index < currentIndex + spreadSize * 2; index += 1) {
      if (index < pages.length) preloadIndexes.add(index);
    }
    for (const index of preloadIndexes) {
      const page = pages[index];
      if (!page?.assetId) continue;
      const image = new window.Image();
      image.src = window.ereader.getAssetUrl(page.assetId);
    }
  }, [currentIndex, pages, spreadSize]);

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
    <div className="comic-reader" onWheel={handleWheel} title="滚轮上下翻页，方向键左右翻页">
      <button className="page-turn left" onClick={goPrevious} disabled={currentIndex <= 0}>
        <ChevronLeft size={22} />
      </button>
      <div ref={pagesRef} className={`comic-pages ${visiblePages.length > 1 ? "double-spread" : "single-spread"}`}>
        {visiblePages.map((page) => (
          <PageImage key={page.id} page={page} maxWidth={pageBounds.width} maxHeight={pageBounds.height} />
        ))}
      </div>
      <button className="page-turn right" onClick={goNext} disabled={currentIndex >= pages.length - 1}>
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
        />
      ) : (
        <span>载入中</span>
      )}
    </div>
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

function alignToSpreadStart(index: number, spreadSize: number) {
  if (spreadSize <= 1) return index;
  return Math.max(0, Math.floor(index / spreadSize) * spreadSize);
}
