import { Reader, ZipReader, TextWriter, Uint8ArrayWriter } from "@zip.js/zip.js";
import type { ByteReader } from "./source";
import type { UnitSink } from "./units";
import { chapterPattern } from "./text";
import { cleanText, imageHref, parseHtml, resolveZipHref, sampleIndexes, sanitizeReadingHtml } from "./markup";

class ArchiveSource extends Reader<Uint8Array> {
  constructor(readonly source: ByteReader) { super(new Uint8Array()); this.size = source.size; }
  readUint8Array(offset: number, length: number) { return this.source.read(offset, length); }
}
function xml(value: string): XMLDocument {
  const result = new DOMParser().parseFromString(value, "application/xml");
  if (result.querySelector("parsererror")) throw new Error("Invalid EPUB XML");
  return result;
}
function elements(document: Document | Element, localName: string): Element[] { return Array.from(document.getElementsByTagNameNS("*", localName)); }
export async function openEpub(source: ByteReader) {
  const reader = new ZipReader(new ArchiveSource(source), { useWebWorkers: false });
  try {
    const entries = new Map((await reader.getEntries()).filter((e) => !e.directory).map((e) => [e.filename.replace(/\\/g, "/").replace(/^\/+/, ""), e]));
    function entry(name: string) { const item = entries.get(name); if (!item?.getData) throw new Error(`Missing EPUB entry: ${name}`); if (item.uncompressedSize > 256 * 1024 * 1024) throw new Error("EPUB entry exceeds decoding budget"); return item; }
    const text = (name: string) => entry(name).getData!(new TextWriter());
    const bytes = (name: string) => entry(name).getData!(new Uint8ArrayWriter());
    const container = xml(await text("META-INF/container.xml"));
    const opfPath = elements(container, "rootfile")[0]?.getAttribute("full-path");
    if (!opfPath) throw new Error("EPUB container has no rootfile");
    const opf = xml(await text(opfPath));
    const manifest = new Map(elements(opf, "item").map((item) => [item.getAttribute("id"), item]));
    const spine = elements(opf, "itemref").map((ref) => ({ ref, item: manifest.get(ref.getAttribute("idref")) })).filter((item) => item.item);
    if (!spine.length) throw new Error("EPUB spine is empty");
    const fixed = elements(opf, "meta").some((meta) => `${meta.getAttribute("property") || meta.getAttribute("name")}`.includes("rendition:layout") && `${meta.textContent || meta.getAttribute("content")}`.includes("pre-paginated")) || spine.some(({ ref, item }) => `${ref.getAttribute("properties")} ${item?.getAttribute("properties")}`.includes("pre-paginated"));
    return { reader, text, bytes, spine, opfPath, fixed };
  } catch (error) { await reader.close(); throw error; }
}
export async function processEpub(source: ByteReader, sink: UnitSink, override: string | null, configure: (kind: "novel" | "comic") => Promise<unknown>): Promise<void> {
  const epub = await openEpub(source);
  try {
    let kind: "novel" | "comic" = override === "comic" ? "comic" : "novel";
    if (!override) {
      let characters = 0, paragraphs = 0, dominant = 0, readable = 0;
      for (const index of sampleIndexes(epub.spine.length, 8)) {
        const href = epub.spine[index].item!.getAttribute("href"); if (!href) continue;
        const body = parseHtml(await epub.text(resolveZipHref(epub.opfPath, href)));
        const length = cleanText(body.textContent).length;
        const nodes = [...body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote")].map((n) => cleanText(n.textContent));
        const images = body.querySelectorAll("img,image,svg").length;
        characters += length; paragraphs += nodes.filter((text) => text.length >= 20).length;
        if (length || images) readable++;
        if (images && length < 160 && nodes.filter((text) => text.length >= 2).length <= 2) dominant++;
      }
      kind = characters >= 1200 || paragraphs >= 10 ? "novel" : epub.fixed || dominant / Math.max(1, readable) >= 0.6 ? "comic" : "novel";
    }
    await configure(kind);
    let index = 0;
    for (let spine = 0; spine < epub.spine.length; spine++) {
      const href = epub.spine[spine].item!.getAttribute("href"); if (!href) continue;
      const path = resolveZipHref(epub.opfPath, href);
      const body = parseHtml(await epub.text(path));
      const nodes = body.querySelectorAll(kind === "comic" ? "img,image" : "h1,h2,h3,h4,h5,h6,p,img,image");
      for (const node of nodes) {
        const tag = node.localName.toLowerCase();
        if (["img", "image"].includes(tag)) {
          const image = imageHref(node); if (!image) continue;
          const assetId = await sink.image(await epub.bytes(resolveZipHref(path, image)));
          await sink.add({ unitIndex: index++, type: kind === "comic" ? "page" : "image", assetId, title: node.getAttribute("alt") || undefined, metadata: { sourceType: "epub", spine, href: image } });
        } else {
          const text = cleanText(node.textContent); if (!text) continue;
          const heading = /^h[1-6]$/.test(tag) || chapterPattern(text);
          await sink.add({ unitIndex: index++, type: heading ? "heading" : "paragraph", title: heading ? text : undefined, text, html: sanitizeReadingHtml(node.outerHTML), metadata: { sourceType: "epub", spine, tagName: tag } });
        }
      }
      await sink.flush(); await sink.progress((spine + 1) / epub.spine.length);
    }
    if (!index) throw new Error("No readable EPUB content found");
  } finally { await epub.reader.close(); }
}
