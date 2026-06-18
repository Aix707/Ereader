import { useEffect, useMemo, useRef, useState } from "react";
import type { BookItem, ReadingProgress, TextUnit } from "../../types";
import { formatPercent } from "../../lib/format";

interface TextFlowReaderProps {
  book: BookItem;
  onProgress: (progress: Partial<ReadingProgress>) => void;
  onProgressLabel: (label: string) => void;
}

export function TextFlowReader({ book, onProgress, onProgressLabel }: TextFlowReaderProps) {
  const [units, setUnits] = useState<TextUnit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const restoredRef = useRef(false);

  useEffect(() => {
    restoredRef.current = false;
    setUnits([]);
    setError(null);
    window.ereader
      .getTextUnits(book.id)
      .then(setUnits)
      .catch((reason) => setError(String(reason)));
  }, [book.id]);

  const headings = useMemo(
    () => units.filter((unit) => unit.type === "heading" && (unit.title || unit.text)).slice(0, 400),
    [units]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container || restoredRef.current || units.length === 0) return;
    requestAnimationFrame(() => {
      const ratio = book.progress.scrollRatio || 0;
      container.scrollTop = ratio * Math.max(0, container.scrollHeight - container.clientHeight);
      restoredRef.current = true;
    });
  }, [book.progress.scrollRatio, units.length]);

  function handleScroll() {
    const container = containerRef.current;
    if (!container) return;
    const scrollable = Math.max(1, container.scrollHeight - container.clientHeight);
    const ratio = Math.max(0, Math.min(1, container.scrollTop / scrollable));
    onProgressLabel(formatPercent(ratio));
    onProgress({ kind: "scroll", scrollRatio: ratio, percent: ratio });
  }

  function jumpTo(unitIndex: number) {
    document.getElementById(`unit-${unitIndex}`)?.scrollIntoView({ block: "start" });
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
          {units.map((unit) => (
            <TextUnitBlock key={unit.id} unit={unit} />
          ))}
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
  const [src, setSrc] = useState("");

  useEffect(() => {
    let cancelled = false;
    setSrc("");
    window.ereader.getAssetDataUrl(assetId).then((dataUrl) => {
      if (!cancelled) setSrc(dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  return src ? <img src={src} alt={alt} /> : <div className="inline-image-loading">载入插图...</div>;
}
