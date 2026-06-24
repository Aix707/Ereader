const fs = require("node:fs");
const path = require("node:path");
const { XMLParser } = require("fast-xml-parser");
const { parse } = require("node-html-parser");
const {
  BlobReader,
  TextWriter,
  Uint8ArrayReader,
  ZipReader
} = require("@zip.js/zip.js");
const { readMobiFile } = require("./mobi.cjs");

const EPUB_SAMPLE_MAX = 8;
const PDF_SAMPLE_MAX = 5;

async function detectContentType(absPath, kind, format) {
  if (format === "image-folder" || kind === "folder") return "comic";
  if (format === "txt") return "novel";
  try {
    if (format === "epub") return await detectEpubContentType(absPath);
    if (format === "pdf") return await detectPdfContentType(absPath);
    if (format === "mobi") return detectMobiContentType(absPath);
  } catch {
    return "novel";
  }
  return "novel";
}

function detectMobiContentType(filePath) {
  const mobi = readMobiFile(filePath);
  if (mobi.images.size === 0) return "novel";

  const root = parse(mobi.html || "");
  const body = root.querySelector("body") || root;
  const imageNodes = body.querySelectorAll("img,image");
  const textNodes = body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote");
  const textChars = cleanText(body.textContent).length;
  const paragraphLikeNodes = textNodes
    .map((node) => cleanText(node.textContent))
    .filter((text) => text.length >= 20).length;
  const referencedImages = imageNodes.filter((node) => mobiImageNodeHasImage(mobi.images, node)).length;
  const imageCount = Math.max(referencedImages, mobi.images.size);

  if (textChars >= 1200 || paragraphLikeNodes >= 10) return "novel";
  if (imageCount >= 3 && textChars < 800) return "comic";
  if (imageCount >= 8 && textChars < imageCount * 120) return "comic";
  return "novel";
}

function mobiImageNodeHasImage(images, node) {
  const candidates = [];
  const recindex = getAttr(node, ["recindex", "data-recindex"]);
  if (recindex) candidates.push(Number.parseInt(recindex, 10));
  const src = getAttr(node, ["src", "href", "xlink:href"]) || "";
  const embed = String(src).match(/kindle:embed:([0-9a-f]+)/i);
  if (embed) {
    candidates.push(Number.parseInt(embed[1], 16), Number.parseInt(embed[1], 10));
  }
  return candidates.some((candidate) => Number.isFinite(candidate) && (images.has(candidate) || images.has(candidate - 1)));
}

async function detectPdfContentType(filePath) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument({ data, disableWorker: true }).promise;
  try {
    const pageIndexes = middleSampleIndexes(doc.numPages, PDF_SAMPLE_MAX);
    let textChars = 0;
    let textItems = 0;
    let lowTextPages = 0;
    let imagePages = 0;

    for (const pageIndex of pageIndexes) {
      const page = await doc.getPage(pageIndex + 1);
      try {
        const text = await page.getTextContent().catch(() => null);
        const items = Array.isArray(text?.items) ? text.items : [];
        const pageText = items.map((item) => item.str || "").join("").trim();
        const pageTextItems = items.filter((item) => String(item.str || "").trim()).length;
        textChars += pageText.length;
        textItems += pageTextItems;
        if (pageText.length < 80 && pageTextItems < 12) lowTextPages += 1;
        if (await pageHasImageOps(page, pdfjs)) imagePages += 1;
      } finally {
        page.cleanup?.();
      }
    }

    const sampled = Math.max(1, pageIndexes.length);
    if (textChars / sampled >= 120 || textItems / sampled >= 20) return "novel";
    if (lowTextPages / sampled >= 0.7 && (imagePages > 0 || lowTextPages / sampled >= 0.85)) return "comic";
    return "novel";
  } finally {
    await doc.destroy?.();
  }
}

async function pageHasImageOps(page, pdfjs) {
  const ops = pdfjs.OPS || {};
  const imageOps = new Set([
    ops.paintImageXObject,
    ops.paintImageXObjectRepeat,
    ops.paintInlineImageXObject,
    ops.paintInlineImageXObjectGroup,
    ops.paintJpegXObject
  ].filter((value) => typeof value === "number"));
  if (imageOps.size === 0) return false;
  const operatorList = await page.getOperatorList().catch(() => null);
  return Array.isArray(operatorList?.fnArray) && operatorList.fnArray.some((fn) => imageOps.has(fn));
}

async function detectEpubContentType(filePath) {
  const zip = await readZipEntries(filePath);
  try {
    const parser = new XMLParser({ ignoreAttributes: false });
    const container = parser.parse(await zip.text("META-INF/container.xml"));
    const rootfile = arrayify(container?.container?.rootfiles?.rootfile)[0]?.["@_full-path"];
    if (!rootfile) return "novel";

    const opfPath = normalizeZipPath(rootfile);
    const opf = parser.parse(await zip.text(opfPath));
    const { spine, metadata } = findOpfParts(opf);
    if (spine.length === 0) return "novel";
    const fixedLayout = hasFixedLayout(metadata, spine);
    const sampleIndexes = middleSampleIndexes(spine.length, EPUB_SAMPLE_MAX);

    let textChars = 0;
    let paragraphLikeNodes = 0;
    let imageDominantPages = 0;
    let readablePages = 0;

    for (const spineIndex of sampleIndexes) {
      const item = spine[spineIndex];
      if (!item?.href) continue;
      const xhtmlPath = resolveZipHref(opfPath, item.href);
      const html = await zip.text(xhtmlPath).catch(() => "");
      if (!html) continue;
      const root = parse(html);
      const body = root.querySelector("body") || root;
      const imageCount = body.querySelectorAll("img,image,svg").length;
      const textNodes = body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote");
      const pageTexts = textNodes
        .map((node) => cleanText(node.textContent))
        .filter((text) => text.length >= 2);
      const pageText = cleanText(body.textContent);
      textChars += pageText.length;
      paragraphLikeNodes += pageTexts.filter((text) => text.length >= 20).length;
      if (pageText.length > 0 || imageCount > 0) readablePages += 1;
      if (imageCount > 0 && pageText.length < 160 && pageTexts.length <= 2) imageDominantPages += 1;
    }

    const sampled = Math.max(1, readablePages || sampleIndexes.length);
    if (textChars >= 1200 || paragraphLikeNodes >= 10) return "novel";
    if (fixedLayout) return "comic";
    if (imageDominantPages / sampled >= 0.6 && textChars < 1200) return "comic";
    return "novel";
  } finally {
    await zip.reader.close();
  }
}

function findOpfParts(opf) {
  const manifestItems = arrayify(opf?.package?.manifest?.item).map((item) => ({
    id: item["@_id"],
    href: item["@_href"],
    mediaType: item["@_media-type"],
    properties: item["@_properties"] || ""
  }));
  const byId = new Map(manifestItems.map((item) => [item.id, item]));
  const spine = arrayify(opf?.package?.spine?.itemref)
    .map((item) => {
      const manifestItem = byId.get(item["@_idref"]);
      return manifestItem ? { ...manifestItem, spineProperties: item["@_properties"] || "" } : null;
    })
    .filter(Boolean);
  return { spine, metadata: opf?.package?.metadata || {} };
}

function hasFixedLayout(metadata, spine) {
  const metas = arrayify(metadata?.meta);
  const metadataFixed = metas.some((item) => {
    const property = String(item["@_property"] || item["@_name"] || "").toLowerCase();
    const value = String(item["#text"] || item["@_content"] || "").toLowerCase();
    return property.includes("rendition:layout") && value.includes("pre-paginated");
  });
  const spineFixed = spine.some((item) =>
    `${item.properties || ""} ${item.spineProperties || ""}`.toLowerCase().includes("pre-paginated")
  );
  return metadataFixed || spineFixed;
}

function middleSampleIndexes(total, maxCount) {
  if (total <= 0) return [];
  if (total === 1) return [0];
  if (total <= maxCount + 2) return Array.from({ length: total - 1 }, (_, index) => index + 1);

  const start = Math.max(2, Math.floor(total * 0.2));
  const end = Math.max(start, Math.floor((total - 1) * 0.7));
  const available = end - start + 1;
  const count = Math.min(maxCount, available);
  if (count <= 1) return [start];

  const indexes = new Set();
  for (let sample = 0; sample < count; sample += 1) {
    indexes.add(Math.round(start + (sample * (available - 1)) / (count - 1)));
  }
  return [...indexes].sort((left, right) => left - right);
}

async function readZipEntries(filePath) {
  const sourceReader =
    typeof fs.openAsBlob === "function"
      ? new BlobReader(await fs.openAsBlob(filePath))
      : new Uint8ArrayReader(new Uint8Array(fs.readFileSync(filePath)));
  const reader = new ZipReader(sourceReader);
  const entries = await reader.getEntries();
  const map = new Map(entries.map((entry) => [normalizeZipPath(entry.filename), entry]));
  async function text(name) {
    const entry = map.get(normalizeZipPath(name));
    if (!entry) throw new Error(`Missing EPUB entry: ${name}`);
    return entry.getData(new TextWriter());
  }
  return { reader, text };
}

function arrayify(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeZipPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function resolveZipHref(baseFile, href) {
  const cleanHref = decodeURIComponent(String(href || "").split("#")[0]).replace(/\\/g, "/");
  return path.posix.normalize(path.posix.join(path.posix.dirname(baseFile), cleanHref));
}

function getAttr(node, names) {
  for (const name of names) {
    const value = node.getAttribute?.(name);
    if (value) return value;
  }
  return null;
}

module.exports = {
  detectContentType,
  middleSampleIndexes
};
