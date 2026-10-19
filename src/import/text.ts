import { detect } from "chardet";
import type { ByteReader } from "./source";
import { tick } from "./source";
import type { UnitSink } from "./units";

export function chapterPattern(text: string): boolean {
  return /^(第[一二三四五六七八九十百千万零〇\d]+[章节卷回部篇].{0,60}|chapter\s+\d+.{0,60}|\d{1,4}[.、]\s*.{1,60})$/i.test(text.trim());
}
export function detectEncoding(bytes: Uint8Array): string {
  if (bytes.every((byte) => byte > 0 && byte < 128)) return "utf-8";
  return (detect(bytes) || "utf-8").replace(/^GB2312$|^GBK$/i, "gb18030");
}
export function decodeBytes(bytes: Uint8Array, encoding: string): string {
  if (/utf-?32/i.test(encoding)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = !/BE$/i.test(encoding); let output = "";
    for (let i = 0; i + 3 < bytes.length; i += 4) { const code = view.getUint32(i, little); output += String.fromCodePoint(code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? code : 0xfffd); }
    return output.replace(/^\uFEFF/, "");
  }
  return new TextDecoder(encoding).decode(bytes).replace(/^\uFEFF/, "");
}
export async function processTxt(source: ByteReader, sink: UnitSink): Promise<void> {
  const sample = await source.read(0, Math.min(source.size, 64 * 1024));
  let encoding = detectEncoding(sample);
  let ambiguous = sample.every((byte) => byte > 0 && byte < 128);
  const utf32 = /utf-?32/i.test(encoding);
  let decoder = utf32 ? null : new TextDecoder(encoding);
  let remainder = "", index = 0;
  async function paragraph(text: string) {
    text = text.trim(); if (!text) return;
    const first = text.split("\n")[0]; const heading = chapterPattern(first);
    await sink.add({ unitIndex: index++, type: heading ? "heading" : "paragraph", title: heading ? first : undefined, text, metadata: { encoding } });
  }
  for (let offset = 0; offset < source.size; offset += 256 * 1024) {
    const length = Math.min(256 * 1024, source.size - offset); const bytes = await source.read(offset, length);
    if (ambiguous && bytes.some((byte) => byte >= 128)) { encoding = detectEncoding(bytes); decoder = new TextDecoder(encoding); ambiguous = false; }
    remainder += utf32 ? decodeBytes(bytes, encoding) : decoder!.decode(bytes, { stream: offset + length < source.size });
    // Keep the final paragraph and a trailing CR across byte boundaries.
    const parts = remainder.replace(/\r\n/g, "\n").split(/\n{2,}/);
    remainder = parts.pop() || "";
    for (const text of parts) await paragraph(text);
    await sink.progress((offset + length) / Math.max(1, source.size)); await tick();
  }
  await paragraph(remainder);
  if (index === 0) await sink.add({ unitIndex: 0, type: "paragraph", text: "", metadata: { encoding } });
  await sink.flush();
}
