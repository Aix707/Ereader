import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { BookItem, NovelReadingSettings, ReadingProgress, TextUnit } from "../../types";
import { formatPercent } from "../../lib/format";

interface TextFlowReaderProps {
  book: BookItem;
  showToc: boolean;
  novelSettings: NovelReadingSettings;
  onProgress: (progress: Partial<ReadingProgress>) => void;
  onProgressLabel: (label: string) => void;
}

const VIRTUAL_OVERSCAN_UNITS = 36;
const TEXT_PAGE_HORIZONTAL_PADDING = 128;
const TEXT_PAGE_BOTTOM_SAFETY = 180;

export function TextFlowReader({ book, showToc, novelSettings, onProgress, onProgressLabel }: TextFlowReaderProps) {
  const [units, setUnits] = useState<TextUnit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const restoredRef = useRef(false);
  const ignoreScrollProgressRef = useRef(false);

  useEffect(() => {
    restoredRef.current = false;
    setUnits([]);
    setError(null);
    setScrollTop(0);
    setViewportSize({ width: 0, height: 0 });
    ignoreScrollProgressRef.current = false;
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
        Math.min(novelSettings.pageWidth, Math.max(320, viewportSize.width - 72)) - TEXT_PAGE_HORIZONTAL_PADDING
      ),
    [novelSettings.pageWidth, viewportSize.width]
  );

  const estimatedHeights = useMemo(
    () =>
      units.map((unit) =>
        estimateUnitHeight(
          unit,
          contentWidth,
          novelSettings.fontSize,
          novelSettings.lineHeight,
          novelSettings.paragraphSpacing,
          viewportSize.height
        )
      ),
    [contentWidth, novelSettings.fontSize, novelSettings.lineHeight, novelSettings.paragraphSpacing, units, viewportSize.height]
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
  const progressRatio = useMemo(() => {
    const scrollable = Math.max(1, virtualHeight - viewportSize.height);
    return clamp(scrollTop / scrollable);
  }, [scrollTop, viewportSize.height, virtualHeight]);
  const spacerHeight = virtualHeight + TEXT_PAGE_BOTTOM_SAFETY;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || restoredRef.current || units.length === 0 || viewportSize.width <= 0 || viewportSize.height <= 0) return;
    requestAnimationFrame(() => {
      const ratio = clamp(Number(book.progress.scrollRatio ?? book.progress.percent ?? 0));
      const nextScrollTop = ratio * Math.max(0, virtualHeight - container.clientHeight);
      ignoreScrollProgressRef.current = true;
      restoredRef.current = true;
      container.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
      requestAnimationFrame(() => {
        ignoreScrollProgressRef.current = false;
      });
    });
  }, [book.progress.percent, book.progress.scrollRatio, units.length, viewportSize.height, viewportSize.width, virtualHeight]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () =>
      setViewportSize((current) => {
        const next = {
          width: Math.max(1, container.clientWidth),
          height: Math.max(1, container.clientHeight)
        };
        return current.width === next.width && current.height === next.height ? current : next;
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
    if (!restoredRef.current || ignoreScrollProgressRef.current) return;
    onProgress({ kind: "scroll", scrollRatio: ratio, percent: ratio });
  }

  function scrollToRatio(ratio: number) {
    const container = containerRef.current;
    if (!container) return;
    const scrollable = Math.max(0, virtualHeight - container.clientHeight);
    const nextScrollTop = clamp(ratio) * scrollable;
    container.scrollTop = nextScrollTop;
    setScrollTop(nextScrollTop);
  }

  function updateProgressFromPointer(event: ReactPointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.height <= 0) return;
    scrollToRatio((event.clientY - rect.top) / rect.height);
  }

  function handleProgressPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    updateProgressFromPointer(event);
  }

  function handleProgressPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.buttons & 1) !== 1) return;
    updateProgressFromPointer(event);
  }

  function handleProgressKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Home") {
      event.preventDefault();
      scrollToRatio(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      scrollToRatio(1);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "PageDown") {
      event.preventDefault();
      scrollToRatio(progressRatio + (event.key === "PageDown" ? 0.08 : 0.02));
      return;
    }
    if (event.key === "ArrowUp" || event.key === "PageUp") {
      event.preventDefault();
      scrollToRatio(progressRatio - (event.key === "PageUp" ? 0.08 : 0.02));
    }
  }

  function jumpTo(unitIndex: number) {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = Math.max(0, virtualOffsets[Math.min(unitIndex, virtualOffsets.length - 1)] || 0);
  }

  if (error) return <div className="reader-error">{error}</div>;
  if (!units.length) return <div className="reader-loading">正在读取数据库内容...</div>;

  return (
    <div className={`text-reader-layout${showToc ? "" : " toc-hidden"}`}>
      {showToc && (
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
      )}
      <article className="text-reader-scroll" ref={containerRef} onScroll={handleScroll}>
        <div
          className="text-page"
          style={{
            "--novel-paragraph-spacing": `${novelSettings.paragraphSpacing}em`,
            "--novel-page-width": `${novelSettings.pageWidth}px`,
            fontFamily: cssFontFamily(novelSettings.fontFamily),
            fontSize: novelSettings.fontSize,
            lineHeight: novelSettings.lineHeight
          } as CSSProperties}
        >
          <div className="text-virtual-spacer" style={{ height: spacerHeight }}>
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
      <div
        className="text-progress-slider"
        role="slider"
        tabIndex={0}
        aria-label="阅读进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progressRatio * 100)}
        title={`阅读进度 ${formatPercent(progressRatio)}`}
        onPointerDown={handleProgressPointerDown}
        onPointerMove={handleProgressPointerMove}
        onKeyDown={handleProgressKeyDown}
      >
        <span className="text-progress-track">
          <i style={{ height: `${progressRatio * 100}%` }} />
          <b style={{ top: `${progressRatio * 100}%` }} />
        </span>
      </div>
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
  paragraphSpacing: number,
  viewportHeight: number
) {
  const linePx = Math.max(18, fontSize * lineHeight);
  const paragraphPx = Math.max(8, fontSize * paragraphSpacing);
  const blockMargin = Math.max(14, paragraphPx);

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
  const charsPerLine = Math.max(12, Math.floor(contentWidth / Math.max(10, fontSize * 0.98)));
  const lines = text
    .split(/\n/)
    .map((line) => Math.max(1, Math.ceil(measureTextUnits(line.trim()) / charsPerLine)))
    .reduce((sum, count) => sum + count, 0);
  return Math.ceil(Math.max(1, lines) * linePx + paragraphPx);
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function measureTextUnits(value: string) {
  let units = 0;
  for (const char of value) {
    units += /[\u1100-\u11ff\u2e80-\ua4cf\uf900-\ufaff\uff00-\uffef]/.test(char) ? 1 : 0.58;
  }
  return units;
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function cssFontFamily(value: string) {
  const family = String(value || "").replace(/[\u0000-\u001f;"{}]/g, "").trim();
  if (!family || family === "serif") return '"Times New Roman", SimSun, serif';
  if (family === "system-ui") return 'system-ui, "Segoe UI", "Microsoft YaHei UI", sans-serif';
  return `"${family.replace(/\\/g, "")}", "Microsoft YaHei", SimSun, serif`;
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
