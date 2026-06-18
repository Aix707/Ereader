import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BookItem, PageUnit, ReadingProgress } from "../../types";

interface PageFlowReaderProps {
  book: BookItem;
  onProgress: (progress: Partial<ReadingProgress>) => void;
  onProgressLabel: (label: string) => void;
}

const PAGE_GAP = 12;

export function PageFlowReader({ book, onProgress, onProgressLabel }: PageFlowReaderProps) {
  const [pages, setPages] = useState<PageUnit[]>([]);
  const [currentIndex, setCurrentIndex] = useState(Math.max(0, (book.progress.page || 1) - 1));
  const [error, setError] = useState<string | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    setError(null);
    setPages([]);
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
    function handleKey(event: KeyboardEvent) {
      if (event.key === "ArrowRight") {
        book.preferences.readingDirection === "rtl" ? goPrevious() : goNext();
      }
      if (event.key === "ArrowLeft") {
        book.preferences.readingDirection === "rtl" ? goNext() : goPrevious();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  function goNext() {
    setCurrentIndex((index) => Math.min(Math.max(0, pages.length - 1), index + spreadSize));
  }

  function goPrevious() {
    setCurrentIndex((index) => Math.max(0, index - spreadSize));
  }

  if (error) return <div className="reader-error">{error}</div>;
  if (!pages.length) return <div className="reader-loading">正在读取页面缓存...</div>;

  return (
    <div className="comic-reader">
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
        {currentIndex + 1}/{pages.length}
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
