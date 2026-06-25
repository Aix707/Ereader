const fs = require("node:fs");
const path = require("node:path");
const {
  BlobReader,
  TextWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader
} = require("@zip.js/zip.js");

function arrayify(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getNodeAttr(node, names) {
  for (const name of names) {
    const value = node.getAttribute?.(name);
    if (value) return value;
  }
  return null;
}

function normalizeZipPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function resolveZipHref(baseFile, href) {
  const cleanHref = decodeURIComponent(String(href || "").split("#")[0]).replace(/\\/g, "/");
  return path.posix.normalize(path.posix.join(path.posix.dirname(baseFile), cleanHref));
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
  async function bytes(name) {
    const entry = map.get(normalizeZipPath(name));
    if (!entry) throw new Error(`Missing EPUB entry: ${name}`);
    const data = await entry.getData(new Uint8ArrayWriter());
    return Buffer.from(data);
  }
  return { reader, map, text, bytes };
}

module.exports = {
  arrayify,
  cleanText,
  getNodeAttr,
  normalizeZipPath,
  readZipEntries,
  resolveZipHref
};
