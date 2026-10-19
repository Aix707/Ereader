import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader, TextReader } from "@zip.js/zip.js";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

export async function createFixtures(root) {
  mkdirSync(root, { recursive: true });
  const file = (name, bytes) => { const target = path.join(root, name); writeFileSync(target, bytes); return target; };
  const image = readFileSync(new URL("../tests/fixtures/image.png", import.meta.url));
  const text = `第一章 阅读测试\n中文 UTF-8 编码。\n\n${Array.from({ length: 5000 }, (_, i) => `第 ${i} 段：这是本地阅读器的长篇测试内容，用于验证滚动、进度恢复和虚拟列表。`).join("\n\n")}`;
  const txt = file("novel.txt", text);
  const gbk = file("gbk.txt", Buffer.concat([Buffer.from([0xd5,0xe2,0xca,0xc7,0xd2,0xbb,0xb6,0xce,0xd6,0xd0,0xce,0xc4,0xb2,0xe2,0xca,0xd4,0xa3,0xac,0xd4,0xc4,0xb6,0xc1,0xd5,0xfd,0xb3,0xa3,0xa1,0xa3]), Buffer.from("\n\n"), ...Array.from({ length: 20 }, () => Buffer.from([0xd6,0xd0,0xce,0xc4]))]));
  const utf16 = file("utf16.txt", Buffer.concat([Buffer.from([0xff,0xfe]), Buffer.from("第一章 测试\n\n中文 UTF-16 内容", "utf16le")]));
  const utf32Bytes = Buffer.alloc(4 + [..."第一章 测试\n\n中文 UTF-32 内容"].length * 4); utf32Bytes.writeUInt32LE(0xfeff);
  [..."第一章 测试\n\n中文 UTF-32 内容"].forEach((character, i) => utf32Bytes.writeUInt32LE(character.codePointAt(0), 4 + i * 4));
  const utf32 = file("utf32.txt", utf32Bytes);
  async function epub(name, comic) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
    const files = {
      "META-INF/container.xml": '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
      "OEBPS/book.opf": '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="chapter" href="chapter.xhtml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
      "OEBPS/chapter.xhtml": comic ? `<html><body>${'<img src="image.png"/>'.repeat(3)}</body></html>` : `<html><body><h1>第一章 EPUB</h1>${'<p onclick="danger()">这是安全的中文段落<script>danger()</script><ruby>字<rt>zi</rt></ruby></p>'.repeat(650)}</body></html>`
    };
    for (const [key, value] of Object.entries(files)) await writer.add(key, new TextReader(value));
    if (comic) await writer.add("OEBPS/image.png", new Uint8ArrayReader(image));
    return file(name, await writer.close());
  }
  function mobi(name, comic) {
    const html = Buffer.from(comic ? '<html><body><img recindex="1"/><img recindex="2"/><img recindex="3"/></body></html>' : '<html><body><h1>第一章 MOBI</h1><p>中文 MOBI 内容。</p><p>Another local paragraph.</p></body></html>');
    const encoded = [];
    for (let offset = 0; offset < html.length; offset += 8) encoded.push(Math.min(8, html.length - offset), ...html.subarray(offset, offset + 8));
    // Include a real compression mode and TBS/multibyte trailers, outside the PalmDOC stream.
    const text = comic ? Buffer.from([...encoded, 0, 0xbe, 0x80, 2, 0x84]) : html;
    const header = Buffer.alloc(244); header.writeUInt16BE(comic ? 2 : 1); header.writeUInt32BE(html.length, 4); header.writeUInt16BE(1, 8); header.write("MOBI", 16); header.writeUInt32BE(228, 20); header.writeUInt32BE(65001, 28); header.writeUInt32BE(6, 36); header.writeUInt32BE(comic ? 2 : 0xffffffff, 108); header.writeUInt16BE(comic ? 3 : 0, 242);
    const records = [header, text, ...(comic ? [image, image, image] : [])];
    const database = Buffer.alloc(78 + records.length * 8); database.write("Fixture"); database.write("BOOKMOBI", 60); database.writeUInt16BE(records.length, 76); let offset = database.length;
    records.forEach((record, index) => { database.writeUInt32BE(offset, 78 + index * 8); offset += record.length; });
    return file(name, Buffer.concat([database, ...records]));
  }
  const images = path.join(root, "images"); mkdirSync(images, { recursive: true });
  for (const [i, extension] of ["png", "jpg", "webp", "bmp", "gif", "avif", "tiff"].entries()) copyFileSync(new URL(`../tests/fixtures/image.${extension}`, import.meta.url), path.join(images, `page${i + 1}.${extension}`));
  const pdf = await PDFDocument.create();
  let font = await pdf.embedFont(StandardFonts.Helvetica);
  let chinese = false;
  for (const fontPath of ["C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/msyh.ttc"]) {
    try { const bytes = readFileSync(fontPath); pdf.registerFontkit({ create(data) { const parsed = fontkit.create(data); return parsed.fonts ? parsed.fonts[0] : parsed; } }); font = await pdf.embedFont(bytes, { subset: true }); chinese = true; break; } catch { /* Use Latin fixture on systems without Chinese fonts. */ }
  }
  for (let i = 0; i < 2; i++) {
    const page = pdf.addPage([420, 594]); page.drawRectangle({ x: 20, y: 20, width: 380, height: 554, color: rgb(0.95, 0.97, 1) });
    for (let row = 0; row < 18; row++) page.drawText(chinese ? `中文嵌入字体测试 ${i + 1}-${row + 1}` : `Embedded font page ${i + 1} row ${row + 1}`, { x: 35, y: 550 - row * 26, size: 14, font });
  }
  const manifest = { root, txt, gbk, utf16, utf32, epub: await epub("novel.epub", false), comicEpub: await epub("comic.epub", true), mobi: mobi("novel.mobi", false), comicMobi: mobi("comic.mobi", true), pdf: file("document.pdf", await pdf.save()), pdfHasChineseFont: chinese, images, broken: file("broken.epub", "This is not a ZIP archive") };
  file("manifest.json", JSON.stringify(manifest, null, 2));
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1").replaceAll("/", path.sep)) console.log(JSON.stringify(await createFixtures(path.resolve(process.argv[2] || "output/migration/fixtures")), null, 2));
