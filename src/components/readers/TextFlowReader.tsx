import { useEffect, useMemo, useRef, useState } from "react";
import type { BookItem, ReadingProgress, TextUnit } from "../../types";
import { formatPercent } from "../../lib/format";

interface TextFlowReaderProps {
  book: BookItem;
  onProgress: (progress: Partial<ReadingProgress>) => void;
  onProgressLabel: (label: string) => void;
}

const VIRTUAL_OVERSCAN_UNITS = 36;
const TEXT_PAGE_MAX_WIDTH = 800;
const TEXT_PAGE_HORIZONTAL_PADDING = 128;

export function TextFlowReader({ book, onProgress, onProgressLabel }: TextFlowReaderProps) {
  const [units, setUnits] = useState<TextUnit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const restoredRef = useRef(false);

  useEffect(() => {
    restoredRef.current = false;
    setUnits([]);
    setError(null);
    setScrollTop(0);
    window.ereader
      .getTextUnits(book.id)
      .then(setUnits)
      .catch((reason) => setError(String(reason)));
  }, [book.id]);

  const headings = useMemo(
    () => units.filter((unit) => unit.type === "heading" && (unit.title || unit.text)).slice(0, 400),
    [units]
  );

  const contentWidth = useMemo(
    () =>
      Math.max(
        280,
        Math.min(TEXT_PAGE_MAX_WIDTH, Math.max(320, viewportSize.width - 72)) - TEXT_PAGE_HORIZONTAL_PADDING
      ),
    [viewportSize.width]
  );

  const estimatedHeights = useMemo(
    () =>
      units.map((unit) =>
        estimateUnitHeight(
          unit,
          contentWidth,
          book.preferences.fontSize,
          book.preferences.lineHeight,
          viewportSize.height
        )
      ),
    [book.preferences.fontSize, book.preferences.lineHeight, contentWidth, units, viewportSize.height]
  );

  const virtualOffsets = useMemo(() => {
    const offsets = new Array<number>(estimatedHeights.length + 1);
    offsets[0] = 0;
    for (let index = 0; index < estimatedHeights.length; index += 1) {
      offsets[index + 1] = offsets[index] + estimatedHeights[index];
    }
    return offsets;
  }, [estimatedHeights]);

  const virtualHeight = Math.max(estimatedHeights[0] || 42, virtualOffsets[virtualOffsets.length - 1] || 0);

  const visibleRange = useMemo(
    () => {
      const start = Math.max(0, findUnitAtOffset(virtualOffsets, scrollTop) - VIRTUAL_OVERSCAN_UNITS);
      const end = Math.min(
        units.length,
        findUnitAtOffset(virtualOffsets, scrollTop + viewportSize.height) + VIRTUAL_OVERSCAN_UNITS
      );
      return { start, end };
    },
    [scrollTop, units.length, viewportSize.height, virtualOffsets]
  );
  const visibleUnits = useMemo(
    () => units.slice(visibleRange.start, visibleRange.end),
    [units, visibleRange.end, visibleRange.start]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container || restoredRef.current || units.length === 0) return;
    requestAnimationFrame(() => {
      const ratio = book.progress.scrollRatio || 0;
      setViewportSize({
        width: Math.max(1, container.clientWidth),
        height: Math.max(1, container.clientHeight)
      });
      const nextScrollTop = ratio * Math.max(0, virtualHeight - container.clientHeight);
      container.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
      restoredRef.current = true;
    });
  }, [book.progress.scrollRatio, units.length, virtualHeight]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () =>
      setViewportSize({
        width: Math.max(1, container.clientWidth),
        height: Math.max(1, container.clientHeight)
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [units.length]);

  function handleScroll() {
    const container = containerRef.current;
    if (!container) return;
    setScrollTop(container.scrollTop);
    setViewportSize({
      width: Math.max(1, container.clientWidth),
      height: Math.max(1, container.clientHeight)
    });
    const scrollable = Math.max(1, virtualHeight - container.clientHeight);
    const ratio = Math.max(0, Math.min(1, container.scrollTop / scrollable));
    onProgressLabel(formatPercent(ratio));
    onProgress({ kind: "scroll", scrollRatio: ratio, percent: ratio });
  }

  function jumpTo(unitIndex: number) {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = Math.max(0, virtualOffsets[Math.min(unitIndex, virtualOffsets.length - 1)] || 0);
  }

  if (error) return <div className="reader-error">{error}</div>;
  if (!units.length) return <div className="reader-loading">正在读取数据库内容...</div>;

  return (
    <div className="text-reader-layout">
      <aside className="toc-panel">
        <div className="toc-header">
          <strong>目录</strong>
          <span>{units.length} 单元</span>
        </div>
        <div className="toc-list">
          {headings.length === 0 ? (
            <p>未识别到章节标题</p>
          ) : (
            headings.map((unit) => (
              <button key={unit.id} onClick={() => jumpTo(unit.unitIndex)} title={unit.title || unit.text || ""}>
                {unit.title || unit.text}
              </button>
            ))
          )}
        </div>
      </aside>
      <article className="text-reader-scroll" ref={containerRef} onScroll={handleScroll}>
        <div
          className="text-page"
          style={{
            fontSize: book.preferences.fontSize,
            lineHeight: book.preferences.lineHeight
          }}
        >
          <div className="text-virtual-spacer" style={{ height: virtualHeight }}>
            <div
              className="text-virtual-window"
              style={{ transform: `translateY(${virtualOffsets[visibleRange.start] || 0}px)` }}
            >
              {visibleUnits.map((unit) => (
                <TextUnitBlock key={unit.id} unit={unit} />
              ))}
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}

function TextUnitBlock({ unit }: { unit: TextUnit }) {
  if (unit.type === "image" && unit.assetId) {
    return (
      <figure id={`unit-${unit.unitIndex}`} className="text-asset-figure">
        <AssetImage assetId={unit.assetId} alt={unit.title || `插图 ${unit.unitIndex + 1}`} />
        {unit.title && <figcaption>{unit.title}</figcaption>}
      </figure>
    );
  }
  if (unit.type === "heading") {
    return (
      <h2 id={`unit-${unit.unitIndex}`} className="text-heading">
        {unit.title || unit.text}
      </h2>
    );
  }
  if (unit.html) {
    return (
      <div
        id={`unit-${unit.unitIndex}`}
        className="text-rich-unit"
        dangerouslySetInnerHTML={{ __html: unit.html }}
      />
    );
  }
  return (
    <p id={`unit-${unit.unitIndex}`} className="text-paragraph">
      {unit.text}
    </p>
  );
}

function AssetImage({ assetId, alt }: { assetId: number; alt: string }) {
  return <img src={window.ereader.getAssetUrl(assetId)} alt={alt} loading="lazy" />;
}

function estimateUnitHeight(
  unit: TextUnit,
  contentWidth: number,
  fontSize: number,
  lineHeight: number,
  viewportHeight: number
) {
  const linePx = Math.max(18, fontSize * lineHeight);
  const blockMargin = Math.max(14, fontSize * 1.1);

  if (unit.type === "heading") {
    return Math.ceil(linePx * 1.7 + blockMargin * 1.8);
  }

  if (unit.type === "image") {
    const maxImageHeight = Math.max(220, viewportHeight * 0.72);
    if (unit.width && unit.height) {
      const scale = Math.min(1, contentWidth / unit.width, maxImageHeight / unit.height);
      return Math.ceil(unit.height * scale + blockMargin * 2.4);
    }
    return Math.ceil(Math.min(460, maxImageHeight) + blockMargin * 2.4);
  }

  const text = unit.text || stripHtml(unit.html || "");
  const charsPerLine = Math.max(16, Math.floor(contentWidth / Math.max(8, fontSize * 0.58)));
  const lines = text
    .split(/\n/)
    .map((line) => Math.max(1, Math.ceil(line.trim().length / charsPerLine)))
    .reduce((sum, count) => sum + count, 0);
  return Math.ceil(Math.max(1, lines) * linePx + blockMargin);
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function findUnitAtOffset(offsets: number[], target: number) {
  let low = 0;
  let high = Math.max(0, offsets.length - 1);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}
