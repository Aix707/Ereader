const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { setImmediate: waitImmediate } = require("node:timers/promises");
const chardet = require("chardet");
const iconv = require("iconv-lite");
const sharp = require("sharp");
const sanitizeHtml = require("sanitize-html");
const { parse } = require("node-html-parser");
const { XMLParser } = require("fast-xml-parser");
const { createCanvas } = require("@napi-rs/canvas");
const {
  arrayify,
  cleanText,
  getNodeAttr: getAttr,
  normalizeZipPath,
  readZipEntries,
  resolveZipHref
} = require("./content-utils.cjs");
const { mobiImageForNode, readMobiFile } = require("./mobi.cjs");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".avif", ".tif", ".tiff"]);
const PDF_MAX_LONG_EDGE = 2800;
const IMAGE_MAX_LONG_EDGE = 3200;
const TXT_UNIT_BATCH_SIZE = 500;

class ImportCancelledError extends Error {
  constructor() {
    super("Import cancelled");
    this.name = "ImportCancelledError";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function naturalSort(values) {
  const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
  return [...values].sort((a, b) => collator.compare(path.basename(a), path.basename(b)));
}

function isImage(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function decodeText(filePath) {
  const buffer = fs.readFileSync(filePath);
  const detected = chardet.detect(buffer) || "utf-8";
  const normalized = String(detected)
    .replace(/^UTF-8$/i, "utf8")
    .replace(/^UTF-16LE$/i, "utf16-le")
    .replace(/^GB2312$/i, "gb18030")
    .replace(/^GBK$/i, "gb18030");
  const encoding = iconv.encodingExists(normalized) ? normalized : "utf8";
  return {
    text: iconv.decode(buffer, encoding).replace(/^\uFEFF/, ""),
    encoding
  };
}

function imageFilesInFolder(folderPath) {
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  return naturalSort(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(folderPath, entry.name))
      .filter(isImage)
  );
}

async function normalizeImage(input, sourceRef, maxLongEdge = IMAGE_MAX_LONG_EDGE) {
  const pipeline = sharp(input, { animated: false })
    .rotate()
    .resize({
      width: maxLongEdge,
      height: maxLongEdge,
      fit: "inside",
      withoutEnlargement: true
    })
    .webp({ quality: 92, effort: 4 });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    data,
    mime: "image/webp",
    width: info.width,
    height: info.height,
    sourceRef
  };
}

function chapterPattern(text) {
  return /^(第[一二三四五六七八九十百千万零〇\d]+[章节卷回部篇].{0,60}|chapter\s+\d+.{0,60}|\d{1,4}[.、]\s*.{1,60})$/i.test(
    text.trim()
  );
}

function sanitizeReadingHtml(value) {
  return sanitizeHtml(value, {
    allowedTags: ["p", "div", "strong", "em", "b", "i", "span", "br", "ruby", "rt", "h1", "h2", "h3", "h4", "h5", "h6"],
    allowedAttributes: {}
  });
}

async function processTxt(repo, book, renditionId, notify, assertActive) {
  const { text, encoding } = decodeText(book.source_path);
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  let index = 0;
  while (index < paragraphs.length) {
    assertActive();
    const batch = paragraphs.slice(index, index + TXT_UNIT_BATCH_SIZE);
    repo.writeTransaction(() => {
      for (const paragraph of batch) {
        const firstLine = paragraph.split("\n")[0]?.trim() || "";
        const isHeading = chapterPattern(firstLine);
        repo.insertUnit(book.id, renditionId, {
          index: index++,
          type: isHeading ? "heading" : "paragraph",
          title: isHeading ? firstLine : null,
          text: paragraph,
          metadata: { encoding }
        });
      }
    });
    notify(0.05 + (index / Math.max(1, paragraphs.length)) * 0.9);
    await waitImmediate();
  }

  if (index === 0) {
    repo.writeTransaction(() => {
      repo.insertUnit(book.id, renditionId, { index: 0, type: "paragraph", text: "", metadata: { encoding } });
    });
  }
  notify(0.95);
}

async function processImageFolder(repo, book, renditionId, notify, assertActive) {
  const files = imageFilesInFolder(book.source_path);
  if (files.length === 0) throw new Error("No supported image files found in folder");
  for (let i = 0; i < files.length; i += 1) {
    assertActive();
    const asset = await normalizeImage(files[i], files[i]);
    assertActive();
    repo.writeTransaction(() => {
      const assetId = repo.insertAsset(book.id, asset);
      repo.insertUnit(book.id, renditionId, {
        index: i,
        type: "page",
        assetId,
        title: path.basename(files[i]),
        metadata: { sourceType: "image-folder", sourcePath: files[i] }
      });
    });
    notify((i + 1) / files.length);
  }
}

async function processPdf(repo, book, renditionId, notify, assertActive) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(book.source_path));
  const doc = await pdfjs.getDocument({ data, disableWorker: true }).promise;
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    assertActive();
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const scale = PDF_MAX_LONG_EDGE / Math.max(viewport.width, viewport.height);
    const scaled = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(scaled.width), Math.ceil(scaled.height));
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context, viewport: scaled }).promise;
    const buffer = canvas.toBuffer("image/webp");
    assertActive();
    repo.writeTransaction(() => {
      const assetId = repo.insertAsset(book.id, {
        data: buffer,
        mime: "image/webp",
        width: canvas.width,
        height: canvas.height,
        sourceRef: `${book.source_path}#page=${pageNumber}`
      });
      repo.insertUnit(book.id, renditionId, {
        index: pageNumber - 1,
        type: "page",
        assetId,
        title: `Page ${pageNumber}`,
        metadata: { sourceType: "pdf", page: pageNumber }
      });
    });
    page.cleanup?.();
    notify(pageNumber / doc.numPages);
  }
  await doc.destroy?.();
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
    .map((item) => byId.get(item["@_idref"]))
    .filter(Boolean);
  const metadata = opf?.package?.metadata || {};
  return { manifestItems, byId, spine, metadata };
}

async function buildEpubImageAsset(zip, opfPath, href, sourceRef) {
  const assetPath = resolveZipHref(opfPath, href);
  const imageBuffer = await zip.bytes(assetPath);
  const asset = await normalizeImage(imageBuffer, assetPath);
  return { ...asset, sourceRef: sourceRef || assetPath };
}

async function processEpubComic(repo, book, renditionId, zip, opfPath, spine, notify, assertActive) {
  let unitIndex = 0;
  for (let spineIndex = 0; spineIndex < spine.length; spineIndex += 1) {
    assertActive();
    const item = spine[spineIndex];
    const xhtmlPath = resolveZipHref(opfPath, item.href);
    const html = await zip.text(xhtmlPath);
    const root = parse(html);
    const imageNodes = root.querySelectorAll("img,image");
    const imageHrefs = imageNodes
      .map((node) => getAttr(node, ["src", "href", "xlink:href"]))
      .filter(Boolean);
    const pending = [];
    for (const href of imageHrefs.length ? imageHrefs : []) {
      assertActive();
      const asset = await buildEpubImageAsset(zip, xhtmlPath, href, `${xhtmlPath} -> ${href}`);
      pending.push({
        asset,
        unit: {
          index: unitIndex,
          type: "page",
          title: `Page ${unitIndex + 1}`,
          metadata: { sourceType: "epub", spine: spineIndex, href }
        }
      });
      unitIndex += 1;
    }
    if (pending.length) {
      repo.writeTransaction(() => {
        for (const item of pending) {
          const assetId = repo.insertAsset(book.id, item.asset);
          repo.insertUnit(book.id, renditionId, { ...item.unit, assetId });
        }
      });
    }
    notify((spineIndex + 1) / Math.max(1, spine.length));
  }
  if (unitIndex === 0) throw new Error("No image pages found in comic EPUB spine");
}

async function processEpubNovel(repo, book, renditionId, zip, opfPath, spine, notify, assertActive) {
  let unitIndex = 0;
  for (let spineIndex = 0; spineIndex < spine.length; spineIndex += 1) {
    assertActive();
    const item = spine[spineIndex];
    const xhtmlPath = resolveZipHref(opfPath, item.href);
    const html = await zip.text(xhtmlPath);
    const root = parse(html);
    const body = root.querySelector("body") || root;
    const nodes = body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,img,image");
    const pending = [];
    for (const node of nodes) {
      assertActive();
      const tagName = String(node.tagName || "").toLowerCase();
      if (tagName === "img" || tagName === "image") {
        const href = getAttr(node, ["src", "href", "xlink:href"]);
        if (!href) continue;
        const asset = await buildEpubImageAsset(zip, xhtmlPath, href, `${xhtmlPath} -> ${href}`);
        pending.push({
          asset,
          unit: {
            index: unitIndex++,
            type: "image",
            title: node.getAttribute?.("alt") || null,
            metadata: { sourceType: "epub", spine: spineIndex, href }
          }
        });
        continue;
      }
      const text = cleanText(node.textContent);
      if (!text) continue;
      const safeHtml = sanitizeReadingHtml(node.toString());
      pending.push({
        unit: {
          index: unitIndex++,
          type: /^h[1-6]$/.test(tagName) || chapterPattern(text) ? "heading" : "paragraph",
          title: /^h[1-6]$/.test(tagName) || chapterPattern(text) ? text : null,
          text,
          html: safeHtml,
          metadata: { sourceType: "epub", spine: spineIndex, tagName }
        }
      });
    }
    if (pending.length) {
      repo.writeTransaction(() => {
        for (const item of pending) {
          const assetId = item.asset ? repo.insertAsset(book.id, item.asset) : null;
          repo.insertUnit(book.id, renditionId, assetId ? { ...item.unit, assetId } : item.unit);
        }
      });
    }
    notify((spineIndex + 1) / Math.max(1, spine.length));
  }
  if (unitIndex === 0) throw new Error("No readable text or image units found in EPUB spine");
}

async function processMobi(repo, book, renditionId, notify, assertActive) {
  if (book.content_type === "comic") {
    await processMobiComic(repo, book, renditionId, notify, assertActive);
  } else {
    await processMobiNovel(repo, book, renditionId, notify, assertActive);
  }
}

async function processMobiComic(repo, book, renditionId, notify, assertActive) {
  const mobi = readMobiFile(book.source_path);
  const root = parse(mobi.html || "");
  const body = root.querySelector("body") || root;
  const orderedImages = orderedMobiImages(mobi, body.querySelectorAll("img,image"));
  if (orderedImages.length === 0) throw new Error("No image pages found in MOBI file");

  for (let index = 0; index < orderedImages.length; index += 1) {
    assertActive();
    const image = orderedImages[index];
    const asset = await normalizeImage(image.data, image.sourceRef);
    repo.writeTransaction(() => {
      const assetId = repo.insertAsset(book.id, asset);
      repo.insertUnit(book.id, renditionId, {
        index,
        type: "page",
        assetId,
        title: `Page ${index + 1}`,
        metadata: { sourceType: "mobi", recindex: image.recindex }
      });
    });
    notify((index + 1) / orderedImages.length);
    await waitImmediate();
  }
}

async function processMobiNovel(repo, book, renditionId, notify, assertActive) {
  const mobi = readMobiFile(book.source_path);
  const root = parse(mobi.html || "");
  const body = root.querySelector("body") || root;
  let nodes = body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,img,image");
  if (nodes.length < 3) {
    const leafDivs = body
      .querySelectorAll("div")
      .filter((node) => node.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,img,image,div").length === 0);
    nodes = [...nodes, ...leafDivs];
  }

  let unitIndex = 0;
  const pending = [];
  const usedImages = new Set();
  for (const node of nodes) {
    assertActive();
    const tagName = String(node.tagName || "").toLowerCase();
    if (tagName === "img" || tagName === "image") {
      const image = mobiImageForNode(mobi.images, node);
      if (!image || usedImages.has(image.key)) continue;
      usedImages.add(image.key);
      const asset = await normalizeImage(image.data, image.sourceRef);
      pending.push({
        asset,
        unit: {
          index: unitIndex++,
          type: "image",
          title: node.getAttribute?.("alt") || null,
          metadata: { sourceType: "mobi", recindex: image.recindex }
        }
      });
      continue;
    }

    const text = cleanText(node.textContent);
    if (!text) continue;
    pending.push({
      unit: {
        index: unitIndex++,
        type: /^h[1-6]$/.test(tagName) || chapterPattern(text) ? "heading" : "paragraph",
        title: /^h[1-6]$/.test(tagName) || chapterPattern(text) ? text : null,
        text,
        html: sanitizeReadingHtml(node.toString()),
        metadata: { sourceType: "mobi", tagName, encoding: mobi.encoding }
      }
    });
  }

  if (unitIndex === 0) {
    const paragraphs = cleanText(root.textContent || mobi.html)
      .split(/\n{2,}|(?<=。)\s+(?=\S)/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    for (const paragraph of paragraphs) {
      pending.push({
        unit: {
          index: unitIndex++,
          type: chapterPattern(paragraph) ? "heading" : "paragraph",
          title: chapterPattern(paragraph) ? paragraph : null,
          text: paragraph,
          metadata: { sourceType: "mobi", encoding: mobi.encoding }
        }
      });
    }
  }

  if (unitIndex === 0) throw new Error("No readable text found in MOBI file");
  const batchSize = 300;
  for (let start = 0; start < pending.length; start += batchSize) {
    assertActive();
    const batch = pending.slice(start, start + batchSize);
    repo.writeTransaction(() => {
      for (const item of batch) {
        const assetId = item.asset ? repo.insertAsset(book.id, item.asset) : null;
        repo.insertUnit(book.id, renditionId, assetId ? { ...item.unit, assetId } : item.unit);
      }
    });
    notify(0.05 + ((start + batch.length) / Math.max(1, pending.length)) * 0.9);
    await waitImmediate();
  }
}

function orderedMobiImages(mobi, imageNodes) {
  const orderedImages = [];
  const used = new Set();

  for (const node of imageNodes) {
    const image = mobiImageForNode(mobi.images, node);
    if (!image || used.has(image.key)) continue;
    used.add(image.key);
    orderedImages.push(image);
  }

  if (orderedImages.length === 0) {
    for (const [key, image] of mobi.images.entries()) {
      if (used.has(key)) continue;
      used.add(key);
      orderedImages.push({ ...image, key, recindex: key });
    }
  }
  return orderedImages;
}

async function processEpub(repo, book, renditionId, notify, assertActive) {
  const zip = await readZipEntries(book.source_path);
  try {
    const parser = new XMLParser({ ignoreAttributes: false });
    const container = parser.parse(await zip.text("META-INF/container.xml"));
    const rootfile = arrayify(container?.container?.rootfiles?.rootfile)[0]?.["@_full-path"];
    if (!rootfile) throw new Error("EPUB container does not contain a rootfile");
    const opfPath = normalizeZipPath(rootfile);
    const opf = parser.parse(await zip.text(opfPath));
    const { spine } = findOpfParts(opf);
    if (spine.length === 0) throw new Error("EPUB spine is empty");
    if (book.content_type === "comic") {
      await processEpubComic(repo, book, renditionId, zip, opfPath, spine, notify, assertActive);
    } else {
      await processEpubNovel(repo, book, renditionId, zip, opfPath, spine, notify, assertActive);
    }
  } finally {
    await zip.reader.close();
  }
}

function createImporter(repo, options = {}) {
  const queue = [];
  const queued = new Set();
  const cancelled = new Set();
  let active = false;

  async function processBook(bookId) {
    const book = repo.getRawBook(bookId);
    if (!book) return;
    const stats = repo.sourceStats(book.source_path, book.source_kind);
    if (!stats.exists) throw new Error("Source file is missing");
    const renditionKind = book.source_format === "txt" || (book.source_format === "mobi" && book.content_type !== "comic") || (book.source_format === "epub" && book.content_type !== "comic")
      ? "text-flow"
      : "page-flow";
    const assertActive = () => {
      if (cancelled.has(bookId)) {
        cancelled.delete(bookId);
        throw new ImportCancelledError();
      }
    };
    assertActive();
    const renditionId = repo.beginRendition(book.id, renditionKind, stats.fingerprint);
    const notify = (progress) => {
      assertActive();
      const next = Math.max(0, Math.min(0.99, progress));
      repo.setStatus(book.id, "processing", next, null);
      options.onProgress?.(book.id, next);
    };
    notify(0.01);
    if (book.source_format === "txt") await processTxt(repo, book, renditionId, notify, assertActive);
    else if (book.source_format === "mobi") await processMobi(repo, book, renditionId, notify, assertActive);
    else if (book.source_format === "image-folder") await processImageFolder(repo, book, renditionId, notify, assertActive);
    else if (book.source_format === "pdf") await processPdf(repo, book, renditionId, notify, assertActive);
    else if (book.source_format === "epub") await processEpub(repo, book, renditionId, notify, assertActive);
    else throw new Error(`Unsupported format: ${book.source_format}`);
    assertActive();
    repo.finishContent(book.id);
    repo.addDiagnostic(book.id, "info", "Import complete", { finishedAt: nowIso(), renditionKind });
  }

  async function drain() {
    if (active) return;
    active = true;
    while (queue.length) {
      const bookId = queue.shift();
      queued.delete(bookId);
      try {
        options.onStarted?.(bookId);
        repo.setStatus(bookId, "processing", 0, null);
        await processBook(bookId);
        options.onFinished?.(bookId);
      } catch (error) {
        if (error instanceof ImportCancelledError) {
          repo.refreshCounts?.(bookId);
          repo.setStatus(bookId, "cancelled", 0, "Import cancelled");
          repo.addDiagnostic(bookId, "warn", "Import cancelled", { cancelledAt: nowIso() });
          options.onCancelled?.(bookId);
        } else {
          repo.refreshCounts?.(bookId);
          repo.setStatus(bookId, "error", 0, String(error?.message || error));
          repo.addDiagnostic(bookId, "error", String(error?.message || error), {
            stack: error?.stack || null
          });
          options.onError?.(bookId, error);
        }
      }
    }
    active = false;
  }

  function enqueue(bookId) {
    if (queued.has(bookId)) return;
    cancelled.delete(bookId);
    queued.add(bookId);
    queue.push(bookId);
    repo.setStatus(bookId, "queued", 0, null);
    setTimeout(() => drain().catch(() => undefined), 0);
  }

  return {
    enqueue,
    cancel(bookId) {
      if (queued.delete(bookId)) {
        const index = queue.indexOf(bookId);
        if (index >= 0) queue.splice(index, 1);
        repo.setStatus(bookId, "cancelled", 0, "Import cancelled");
        options.onCancelled?.(bookId);
        return true;
      }
      cancelled.add(bookId);
      return true;
    },
    enqueueMany(bookIds) {
      for (const bookId of bookIds) enqueue(bookId);
    },
    isActive() {
      return active || queue.length > 0;
    }
  };
}

module.exports = {
  createImporter,
  isImage,
  imageFilesInFolder,
  naturalSort
};
