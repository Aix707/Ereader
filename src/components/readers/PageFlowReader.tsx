import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { BookItem, PageUnit, ReadingProgress } from "../../types";

interface PageFlowReaderProps {
  book: BookItem;
  onProgress: (progress: Partial<ReadingProgress>) => void;
  onProgressLabel: (label: string) => void;
}

export function PageFlowReader({ book, onProgress, onProgressLabel }: PageFlowReaderProps) {
  const [pages, setPages] = useState<PageUnit[]>([]);
  const [currentIndex, setCurrentIndex] = useState(Math.max(0, (book.progress.page || 1) - 1));
  const [error, setError] = useState<string | null>(null);

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
      <div className={`comic-pages ${book.preferences.fitMode}`}>
        {visiblePages.map((page) => (
          <PageImage key={page.id} page={page} fitMode={book.preferences.fitMode} />
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

function PageImage({ page, fitMode }: { page: PageUnit; fitMode: string }) {
  const [src, setSrc] = useState("");

  useEffect(() => {
    let cancelled = false;
    setSrc("");
    window.ereader.getAssetDataUrl(page.assetId).then((dataUrl) => {
      if (!cancelled) setSrc(dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [page.assetId]);

  return (
    <div className="image-page-holder">
      {src ? (
        <img
          className={`comic-image ${fitMode}`}
          src={src}
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
