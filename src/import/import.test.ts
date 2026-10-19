import { describe, expect, it } from "vitest";
import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { processTxt, decodeBytes } from "./text";
import { processEpub } from "./epub";
import { decompressPalmDoc, parseMobi } from "./mobi";
import { resolveZipHref, sanitizeReadingHtml, sampleIndexes } from "./markup";
import type { ByteReader } from "./source";
import type { ImportUnit, UnitSink } from "./units";

function memory(bytes: Uint8Array): ByteReader { return { size: bytes.length, async read(offset, length) { return bytes.slice(offset, offset + length); } }; }
function mobi(records: number[][], flags = 0, compression = 2, headerLength = 0xe4): ByteReader {
  const header = new Uint8Array(0xf4), view = new DataView(header.buffer);
  view.setUint16(0, compression); view.setUint16(8, records.length); view.setUint16(10, 4096);
  header.set(new TextEncoder().encode("MOBI"), 16);
  view.setUint32(20, headerLength); view.setUint32(28, 65001); view.setUint32(36, 6);
  view.setUint32(108, 0xffffffff); view.setUint16(0xf2, flags);
  const parts = [header, ...records.map((record) => new Uint8Array(record))];
  const table = new Uint8Array(78 + parts.length * 8), database = new DataView(table.buffer);
  table.set(new TextEncoder().encode("BOOKMOBI"), 60); database.setUint16(76, parts.length);
  let offset = table.length;
  parts.forEach((part, index) => { database.setUint32(78 + index * 8, offset); offset += part.length; });
  const bytes = new Uint8Array(offset); bytes.set(table); offset = table.length;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return memory(bytes);
}
function recording() {
  const units: ImportUnit[] = []; let flushes = 0;
  const sink: UnitSink = { async add(unit) { units.push(unit); if (units.length % 300 === 0) await sink.flush(); }, async flush() { flushes++; }, async progress() {}, async image() { return 1; }, async encoded() { return 1; } };
  return { units, sink, get flushes() { return flushes; } };
}
async function epub(text: string, image = false) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, value] of Object.entries({ "META-INF/container.xml": '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>', "OEBPS/book.opf": '<package><manifest><item id="text" href="text.xhtml"/></manifest><spine><itemref idref="text"/></spine></package>', "OEBPS/text.xhtml": text })) await writer.add(name, new TextReader(value));
  if (image) await writer.add("OEBPS/image.png", new Uint8ArrayReader(new Uint8Array([1,2,3])));
  return memory(await writer.close());
}
describe("portable import pipeline", () => {
  it("decodes Chinese and Unicode encodings", () => {
    expect(decodeBytes(new Uint8Array([0xd6,0xd0,0xce,0xc4]), "gb18030")).toBe("中文");
    expect(decodeBytes(new Uint8Array([0xff,0xfe,0,0,0x2d,0x4e,0,0]), "UTF-32LE")).toBe("中");
    expect(decodeBytes(new Uint8Array([0xfe,0xff,0x4e,0x2d]), "UTF-16BE")).toBe("中");
  });
  it("streams TXT paragraphs over byte boundaries and retains empty input", async () => {
    const record = recording();
    await processTxt(memory(new TextEncoder().encode(`${"a".repeat(262143)}\r\n\r\n第二章 测试\n中文内容`)), record.sink);
    expect(record.units).toHaveLength(2); expect(record.units[0].text).toHaveLength(262143); expect(record.units[1].type).toBe("heading");
    const empty = recording(); await processTxt(memory(new Uint8Array()), empty.sink); expect(empty.units[0].text).toBe("");
  });
  it("sanitizes markup including SVG, handlers, styles and data attributes", () => {
    const html = sanitizeReadingHtml('<p id="x" data-x="a" onclick="alert(1)">Safe<script>bad()</script><svg onload="bad()"></svg><a href="https://remote">text</a><ruby>字<rt>zi</rt></ruby></p>');
    expect(html).toBe("<p>Safetext<ruby>字<rt>zi</rt></ruby></p>");
  });
  it("imports 650 EPUB paragraphs with namespace-safe XML and clean HTML", async () => {
    const record = recording(); const kinds: string[] = [];
    await processEpub(await epub(`<h1>Chapter 1</h1>${'<p onclick="bad()">Readable paragraph<script>bad()</script></p>'.repeat(650)}`), record.sink, null, async (kind) => { kinds.push(kind); });
    expect(record.units).toHaveLength(651); expect(record.flushes).toBeGreaterThan(1); expect(kinds).toEqual(["novel"]); expect(record.units[1].html).toBe("<p>Readable paragraph</p>");
  });
  it("retains repeated comic pages", async () => {
    const record = recording();
    const source = await epub('<img src="image.png"/><img src="image.png"/><img src="image.png"/>', true);
    await processEpub(source, record.sink, "comic", async () => {});
    expect(record.units.map((unit) => [unit.unitIndex, unit.assetId])).toEqual([[0,1],[1,1],[2,1]]);
  });
  it("rejects malformed archives and ZIP paths escaping the root", async () => {
    await expect(processEpub(memory(new Uint8Array([1,2,3])), recording().sink, null, async () => {})).rejects.toThrow();
    expect(resolveZipHref("OEBPS/text/chapter.xhtml", "../images/图.png#x")).toBe("OEBPS/images/图.png");
    expect(() => resolveZipHref("book.opf", "../../outside")).toThrow();
  });
  it("validates PalmDOC references and malformed MOBI headers", async () => {
    expect([...decompressPalmDoc(new Uint8Array([65,66,67,0x80,0x18]))]).toEqual([65,66,67,65,66,67]);
    expect([...decompressPalmDoc(new Uint8Array([65,0x80,0x0b]))]).toEqual(Array(7).fill(65));
    expect([...decompressPalmDoc(new Uint8Array([3,0x80,0xc0,0,0xc1]))]).toEqual([0x80,0xc0,0,32,65]);
    expect(() => decompressPalmDoc(new Uint8Array([0x80,0]))).toThrow();
    expect(() => decompressPalmDoc(new Uint8Array([0x80]))).toThrow("Truncated");
    expect(() => decompressPalmDoc(new Uint8Array([3,65]))).toThrow("Truncated");
    await expect(parseMobi(memory(new Uint8Array(50)))).rejects.toThrow("header");
  });
  it("strips MOBI trailers and multibyte overlap before decompressing each record", async () => {
    const book = mobi([
      [65,66,67,0x80,0x18,3,0xe4,0xb8,0xad,0xe6,0x96,2,0xbe,0x80,2,0x84],
      [3,0xe6,0x96,0x87,0,0xbe,0x80,2,0x84]
    ], 3);
    expect((await parseMobi(book)).html).toBe("ABCABC中文");
  });
  it("handles multiple sparse trailer flags and multibyte trailer lengths", async () => {
    // A 130-byte trailer ends in the big-endian variable integer 0x81 0x02.
    const book = mobi([[65,66,67,0x80,0x18,0,...Array(128).fill(0xbe),0x81,2,0x81,0,0x82]], 0x800b);
    expect((await parseMobi(book)).html).toBe("ABCABC");
  });
  it("strips trailers from uncompressed MOBI and leaves older headers intact", async () => {
    expect((await parseMobi(mobi([[65,0,0x81],[66,0,0x81]], 3, 1))).html).toBe("AB");
    expect((await parseMobi(mobi([[65,66,67,0x80,0x18]], 0))).html).toBe("ABCABC");
    expect((await parseMobi(mobi([[65,66,67,0x80,0x18]], 3, 2, 128))).html).toBe("ABCABC");
  });
  it("rejects malformed MOBI trailer lengths and overlaps", async () => {
    for (const record of [[0x80],[0x89],[0,0,0,0],[0x81,0],[0x80,1]]) {
      await expect(parseMobi(mobi([record], 2))).rejects.toThrow("trailing data length");
    }
    await expect(parseMobi(mobi([[3]], 1))).rejects.toThrow("multibyte overlap");
    await expect(parseMobi(mobi([[0x81]], 3))).rejects.toThrow("multibyte overlap");
    await expect(parseMobi(mobi([[0x80,0,0,0x81]], 3))).rejects.toThrow("Invalid PalmDOC reference");
  });
  it("samples inside the book rather than only the cover", () => {
    expect(sampleIndexes(100, 5)).toHaveLength(5); expect(sampleIndexes(100,5)[0]).toBeGreaterThan(0);
  });
});
