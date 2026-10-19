import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { encodeCanvas } from "./image";
import type { NativeReader } from "./source";
import type { UnitSink } from "./units";
import { sampleIndexes } from "./markup";

GlobalWorkerOptions.workerSrc = workerUrl;
class NativePdfTransport extends PDFDataRangeTransport {
  private stopped = false;
  constructor(readonly source: NativeReader) { super(source.size, new Uint8Array(), false); }
  requestDataRange(begin: number, end: number) {
    this.source.read(begin, end - begin).then((bytes) => { if (!this.stopped) this.onDataRange(begin, bytes); }).catch((error: unknown) => { this.onError?.(error); });
  }
  onError?: (error: unknown) => void;
  abort() { this.stopped = true; }
}
export async function processPdf(source: NativeReader, sink: UnitSink, override: string | null, configure: (kind: "novel" | "comic") => Promise<unknown>): Promise<void> {
  const transport = new NativePdfTransport(source);
  const base = new URL("./pdf/", location.href).href;
  const task = getDocument({ range: transport, rangeChunkSize: 256 * 1024, disableStream: true, disableAutoFetch: true, cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`, isEvalSupported: false });
  transport.onError = () => { task.destroy().catch(console.error); };
  const document = await task.promise;
  try {
    let kind: "novel" | "comic" = override === "comic" ? "comic" : "novel";
    if (!override) {
      let characters = 0, items = 0;
      const samples = sampleIndexes(document.numPages, 5);
      for (const index of samples) { const page = await document.getPage(index + 1); try { const text = await page.getTextContent(); const strings = text.items.flatMap((item) => "str" in item ? [item.str.trim()] : []); characters += strings.join("").length; items += strings.filter(Boolean).length; } finally { page.cleanup(); } }
      kind = characters / Math.max(1, samples.length) >= 120 || items / Math.max(1, samples.length) >= 20 ? "novel" : "comic";
    }
    await configure(kind);
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber), canvas = window.document.createElement("canvas");
      try {
        const viewport = page.getViewport({ scale: 1 });
        const scaled = page.getViewport({ scale: 2800 / Math.max(viewport.width, viewport.height) });
        canvas.width = Math.ceil(scaled.width); canvas.height = Math.ceil(scaled.height);
        await page.render({ canvasContext: canvas.getContext("2d")!, viewport: scaled }).promise;
        const assetId = await sink.encoded(await encodeCanvas(canvas));
        await sink.add({ unitIndex: pageNumber - 1, type: "page", assetId, title: `Page ${pageNumber}`, metadata: { sourceType: "pdf", page: pageNumber } });
        await sink.flush(); await sink.progress(pageNumber / document.numPages);
      } finally { page.cleanup(); canvas.width = 0; canvas.height = 0; }
    }
  } finally { transport.abort(); await task.destroy(); }
}
