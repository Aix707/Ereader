import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { BookItem, NovelReadingSettings, ReadingProgress, TextUnit } from "../../types";
import { formatPercent } from "../../lib/format";
import { useElementSize } from "../../lib/elementSize";
import { clampUnit } from "../../lib/number";
import { type CssVariableStyle, heightPercentStyle, topPercentStyle } from "../../lib/style";
import { cssFontFamily, estimateTextUnitHeight, findUnitAtOffset } from "../../lib/textReading";

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
type TextPageStyle = CssVariableStyle<"novel-paragraph-spacing" | "novel-page-width">;

export function TextFlowReader({ book, showToc, novelSettings, onProgress, onProgressLabel }: TextFlowReaderProps) {
  const [units, setUnits] = useState<TextUnit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewportSize = useElementSize(containerRef, units.length);
  const restoredRef = useRef(false);
  const ignoreScrollProgressRef = useRef(false);

  useEffect(() => {
    restoredRef.current = false;
    setUnits([]);
    setError(null);
    setScrollTop(0);
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
        estimateTextUnitHeight(
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
    return clampUnit(scrollTop / scrollable);
  }, [scrollTop, viewportSize.height, virtualHeight]);
  const spacerHeight = virtualHeight + TEXT_PAGE_BOTTOM_SAFETY;
  const textPageStyle = useMemo<TextPageStyle>(
    () => ({
      "--novel-paragraph-spacing": `${novelSettings.paragraphSpacing}em`,
      "--novel-page-width": `${novelSettings.pageWidth}px`,
      fontFamily: cssFontFamily(novelSettings.fontFamily),
      fontSize: novelSettings.fontSize,
      lineHeight: novelSettings.lineHeight
    }),
    [
      novelSettings.fontFamily,
      novelSettings.fontSize,
      novelSettings.lineHeight,
      novelSettings.pageWidth,
      novelSettings.paragraphSpacing
    ]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container || restoredRef.current || units.length === 0 || viewportSize.width <= 0 || viewportSize.height <= 0) return;
    requestAnimationFrame(() => {
      const ratio = clampUnit(book.progress.scrollRatio ?? book.progress.percent);
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

  function handleScroll() {
    const container = containerRef.current;
    if (!container) return;
    setScrollTop(container.scrollTop);
    const scrollable = Math.max(1, virtualHeight - container.clientHeight);
    const ratio = clampUnit(container.scrollTop / scrollable);
    onProgressLabel(formatPercent(ratio));
    if (!restoredRef.current || ignoreScrollProgressRef.current) return;
    onProgress({ kind: "scroll", scrollRatio: ratio, percent: ratio });
  }

  function scrollToRatio(ratio: number) {
    const container = containerRef.current;
    if (!container) return;
    const scrollable = Math.max(0, virtualHeight - container.clientHeight);
    const nextScrollTop = clampUnit(ratio) * scrollable;
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
        <div className="text-page" style={textPageStyle}>
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
          <i style={heightPercentStyle(progressRatio)} />
          <b style={topPercentStyle(progressRatio)} />
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
