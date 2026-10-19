import { decodeBytes, chapterPattern } from "./text";
import { cleanText, parseHtml, sanitizeReadingHtml } from "./markup";
import type { ByteReader } from "./source";
import type { UnitSink } from "./units";

const encodings = new Map([[1250,"windows-1250"],[1251,"windows-1251"],[1252,"windows-1252"],[1253,"windows-1253"],[1254,"windows-1254"],[932,"shift_jis"],[936,"gb18030"],[949,"euc-kr"],[950,"big5"],[65001,"utf-8"]]);
export function decompressPalmDoc(input: Uint8Array): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < input.length; index++) {
    const byte = input[index];
    if (byte >= 1 && byte <= 8) {
      if (index + byte >= input.length) throw new Error("Truncated PalmDOC literal");
      for (let n = 0; n < byte; n++) output.push(input[++index]);
    }
    else if (byte >= 0x80 && byte <= 0xbf) {
      if (index + 1 >= input.length) throw new Error("Truncated PalmDOC reference");
      const pair = (byte << 8) | input[++index], distance = (pair >> 3) & 0x7ff, length = (pair & 7) + 3;
      if (!distance || distance > output.length) throw new Error("Invalid PalmDOC reference");
      for (let n = 0; n < length; n++) output.push(output[output.length - distance]);
    } else if (byte >= 0xc0) output.push(0x20, byte ^ 0x80);
    else output.push(byte);
    if (output.length > 16 * 1024 * 1024) throw new Error("PalmDOC record exceeds decoding budget");
  }
  return new Uint8Array(output);
}
function textRecord(bytes: Uint8Array, flags: number): Uint8Array {
  let end = bytes.length;
  // MOBI trailers are outside the compressed stream; each length includes its own suffix.
  for (let entries = flags >>> 1; entries; entries >>>= 1) {
    if (!(entries & 1)) continue;
    let length = 0, digits = 0;
    for (; digits < Math.min(4, end); digits++) {
      const byte = bytes[end - 1 - digits];
      length += (byte & 0x7f) * 128 ** digits;
      if (byte & 0x80) break;
    }
    if (digits >= Math.min(4, end) || length < digits + 1 || length > end) throw new Error("Invalid MOBI trailing data length");
    end -= length;
  }
  // Bit zero describes duplicated bytes from the next UTF-8 record plus a size byte.
  if (flags & 1) {
    if (!end) throw new Error("Missing MOBI multibyte overlap");
    const length = (bytes[end - 1] & 3) + 1;
    if (length > end) throw new Error("Invalid MOBI multibyte overlap");
    end -= length;
  }
  return bytes.subarray(0, end);
}
function imageMime(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const ascii = new TextDecoder("ascii").decode(bytes);
  return (bytes[0] === 0xff && bytes[1] === 0xd8) || (bytes[0] === 0x89 && ascii.slice(1, 4) === "PNG") || ascii.startsWith("GIF") || (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") || ascii.startsWith("BM");
}
interface MobiImage { key: number; read(): Promise<Uint8Array> }
export async function parseMobi(source: ByteReader) {
  if (source.size < 78) throw new Error("Invalid MOBI/Palm database header");
  const header = await source.read(0, 78), count = new DataView(header.buffer, header.byteOffset).getUint16(76);
  if (count < 2 || 78 + count * 8 > source.size) throw new Error("Invalid MOBI record table");
  const table = await source.read(78, count * 8), view = new DataView(table.buffer, table.byteOffset);
  const offsets = Array.from({ length: count }, (_, i) => view.getUint32(i * 8));
  offsets.forEach((offset, i) => { if (offset < 78 + count * 8 || offset >= source.size || (i && offset <= offsets[i - 1])) throw new Error("Invalid MOBI record offset"); });
  const record = (index: number) => source.read(offsets[index], (offsets[index + 1] || source.size) - offsets[index]);
  const record0 = await record(0); if (record0.length < 16) throw new Error("Invalid PalmDOC header");
  const palm = new DataView(record0.buffer, record0.byteOffset);
  const compression = palm.getUint16(0), textLength = palm.getUint32(4), records = Math.min(palm.getUint16(8), count - 1);
  if (palm.getUint16(12) !== 0) throw new Error("Encrypted MOBI files are not supported");
  if (![1, 2].includes(compression)) throw new Error(`Unsupported MOBI compression: ${compression}`);
  if (textLength > 256 * 1024 * 1024) throw new Error("MOBI text exceeds decoding budget");
  let mobi = -1;
  for (let i = 0; i + 4 <= record0.length; i++) { if (record0[i] === 77 && record0[i + 1] === 79 && record0[i + 2] === 66 && record0[i + 3] === 73) { mobi = i; break; } }
  const u32 = (offset: number, fallback: number) => offset >= 0 && offset + 4 <= record0.length ? palm.getUint32(offset) : fallback;
  const headerLength = mobi < 0 ? 0 : u32(mobi + 4, 0);
  let trailingFlags = 0;
  if (headerLength >= 0xe4 && u32(mobi + 20, 0) >= 5) {
    if (mobi + 0xe4 > record0.length) throw new Error("Truncated MOBI header");
    trailingFlags = palm.getUint16(mobi + 0xe2);
  }
  const encoding = encodings.get(mobi < 0 ? 1252 : u32(mobi + 12, 1252)) || "utf-8";
  const chunks: Uint8Array[] = []; let size = 0;
  for (let i = 1; i <= records; i++) { const bytes = textRecord(await record(i), trailingFlags); const text = compression === 2 ? decompressPalmDoc(bytes) : bytes; size += text.length; if (size > 256 * 1024 * 1024) throw new Error("MOBI text exceeds decoding budget"); chunks.push(text); }
  const bytes = new Uint8Array(size); let cursor = 0; for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.length; }
  const html = decodeBytes(textLength ? bytes.subarray(0, textLength) : bytes, encoding).replace(/\0+$/g, "");
  const images = new Map<number, MobiImage>();
  const firstImage = headerLength < 96 ? -1 : u32(mobi + 92, -1);
  if (firstImage > 0 && firstImage < count) for (let i = firstImage; i < count; i++) {
    const size = (offsets[i + 1] || source.size) - offsets[i];
    if (imageMime(await source.read(offsets[i], Math.min(size, 12)))) images.set(i - firstImage, { key: i - firstImage, read: () => record(i) });
  }
  return { html, images, encoding };
}
function imageForNode(images: Map<number, MobiImage>, node: Element): MobiImage | undefined {
  const candidates: number[] = [];
  const add = (n: number) => { if (Number.isFinite(n)) { if (n > 0) candidates.push(n - 1); candidates.push(n); } };
  add(Number.parseInt(node.getAttribute("recindex") || node.getAttribute("data-recindex") || "", 10));
  const src = node.getAttribute("src") || node.getAttribute("href") || node.getAttribute("xlink:href") || "";
  const embed = src.match(/kindle:embed:([0-9a-f]+)/i); if (embed) { add(Number.parseInt(embed[1], 16)); add(Number.parseInt(embed[1], 10)); }
  for (const index of candidates) if (images.has(index)) return images.get(index);
  return undefined;
}
export async function processMobi(source: ByteReader, sink: UnitSink, override: string | null, configure: (kind: "novel" | "comic") => Promise<unknown>): Promise<void> {
  const mobi = await parseMobi(source), body = parseHtml(mobi.html);
  const imageNodes = [...body.querySelectorAll("img,image")];
  const characters = cleanText(body.textContent).length;
  const paragraphs = [...body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote")].filter((n) => cleanText(n.textContent).length >= 20).length;
  const count = Math.max(mobi.images.size, imageNodes.filter((n) => imageForNode(mobi.images, n)).length);
  const kind = override || (characters >= 1200 || paragraphs >= 10 ? "novel" : count >= 3 && characters < 800 || count >= 8 && characters < count * 120 ? "comic" : "novel");
  await configure(kind === "comic" ? "comic" : "novel");
  let index = 0; const used = new Set<number>();
  if (kind === "comic") {
    let images = imageNodes.map((node) => imageForNode(mobi.images, node)).filter((image): image is MobiImage => !!image);
    if (!images.length) images = [...mobi.images.values()];
    for (const image of images) {
      if (used.has(image.key)) continue; used.add(image.key);
      const assetId = await sink.image(await image.read());
      await sink.add({ unitIndex: index++, type: "page", assetId, metadata: { sourceType: "mobi", recindex: image.key } });
      await sink.flush(); await sink.progress(used.size / Math.max(1, images.length));
    }
  } else {
    let nodes = [...body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,img,image")];
    if (nodes.length < 3) nodes = [...nodes, ...[...body.querySelectorAll("div")].filter((node) => !node.querySelector("h1,h2,h3,h4,h5,h6,p,li,blockquote,img,image,div"))];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i], tag = node.localName.toLowerCase();
      if (["img", "image"].includes(tag)) {
        const image = imageForNode(mobi.images, node); if (!image || used.has(image.key)) continue; used.add(image.key);
        const assetId = await sink.image(await image.read());
        await sink.add({ unitIndex: index++, type: "image", assetId, metadata: { sourceType: "mobi", recindex: image.key } });
      } else {
        const text = cleanText(node.textContent); if (!text) continue;
        const heading = /^h[1-6]$/.test(tag) || chapterPattern(text);
        await sink.add({ unitIndex: index++, type: heading ? "heading" : "paragraph", title: heading ? text : undefined, text, html: sanitizeReadingHtml(node.outerHTML), metadata: { sourceType: "mobi", encoding: mobi.encoding } });
      }
      await sink.progress((i + 1) / Math.max(1, nodes.length));
    }
    if (!index && cleanText(body.textContent)) await sink.add({ unitIndex: index++, type: "paragraph", text: cleanText(body.textContent), metadata: { encoding: mobi.encoding } });
  }
  if (!index) throw new Error("No readable MOBI content found");
  await sink.flush();
}
