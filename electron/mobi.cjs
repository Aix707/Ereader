const fs = require("node:fs");
const iconv = require("iconv-lite");

const MOBI_TEXT_ENCODINGS = new Map([
  [1250, "windows-1250"],
  [1251, "windows-1251"],
  [1252, "windows-1252"],
  [1253, "windows-1253"],
  [1254, "windows-1254"],
  [932, "shift_jis"],
  [936, "gb18030"],
  [949, "euc-kr"],
  [950, "big5"],
  [65001, "utf8"]
]);

function readMobiFile(filePath) {
  return parseMobiBuffer(fs.readFileSync(filePath), filePath);
}

function parseMobiBuffer(buffer, sourceRef = "mobi") {
  const records = readPalmDatabaseRecords(buffer);
  if (records.length < 2) throw new Error("MOBI file does not contain text records");

  const header = parseMobiHeader(records[0], buffer);
  if (header.encryption !== 0) throw new Error("Encrypted MOBI files are not supported");
  if (![1, 2].includes(header.compression)) {
    throw new Error(`Unsupported MOBI compression: ${header.compression}`);
  }

  const textChunks = [];
  const textRecordCount = Math.min(header.textRecordCount, records.length - 1);
  for (let index = 1; index <= textRecordCount; index += 1) {
    const record = records[index];
    textChunks.push(header.compression === 2 ? decompressPalmDoc(record) : record);
  }
  const textBytes = Buffer.concat(textChunks);
  const boundedText = header.textLength > 0 ? textBytes.subarray(0, header.textLength) : textBytes;
  const encoding = MOBI_TEXT_ENCODINGS.get(header.codepage) || "utf8";
  const html = iconv.decode(boundedText, iconv.encodingExists(encoding) ? encoding : "utf8").replace(/\0+$/g, "");

  return {
    html,
    title: header.fullName || header.databaseName || null,
    encoding,
    images: collectImageRecords(records, header.firstImageIndex, sourceRef)
  };
}

function readPalmDatabaseRecords(buffer) {
  if (buffer.length < 78) throw new Error("Invalid MOBI/Palm database header");
  const recordCount = buffer.readUInt16BE(76);
  if (recordCount <= 0) throw new Error("MOBI/Palm database has no records");

  const offsets = [];
  for (let index = 0; index < recordCount; index += 1) {
    const entryOffset = 78 + index * 8;
    if (entryOffset + 8 > buffer.length) throw new Error("Invalid MOBI record table");
    offsets.push(buffer.readUInt32BE(entryOffset));
  }

  return offsets.map((start, index) => {
    const end = offsets[index + 1] || buffer.length;
    if (start >= buffer.length || end > buffer.length || end <= start) throw new Error("Invalid MOBI record offset");
    return buffer.subarray(start, end);
  });
}

function parseMobiHeader(record0, fileBuffer) {
  if (record0.length < 16) throw new Error("Invalid PalmDOC header");
  const databaseName = fileBuffer.subarray(0, 32).toString("ascii").replace(/\0+$/g, "").trim();
  const compression = record0.readUInt16BE(0);
  const textLength = record0.readUInt32BE(4);
  const textRecordCount = record0.readUInt16BE(8);
  const encryption = record0.readUInt16BE(12);
  const mobiOffset = record0.indexOf(Buffer.from("MOBI"));
  if (mobiOffset < 0) {
    return {
      databaseName,
      compression,
      textLength,
      textRecordCount,
      encryption,
      codepage: 1252,
      firstImageIndex: -1,
      fullName: null
    };
  }

  const headerLength = readUInt32BE(record0, mobiOffset + 4, 0);
  const codepage = readUInt32BE(record0, mobiOffset + 12, 1252);
  const fullNameOffset = readUInt32BE(record0, mobiOffset + 68, 0);
  const fullNameLength = readUInt32BE(record0, mobiOffset + 72, 0);
  const firstImageIndex = headerLength >= 96 ? readUInt32BE(record0, mobiOffset + 92, -1) : -1;
  const fullName =
    fullNameOffset > 0 && fullNameLength > 0 && fullNameOffset + fullNameLength <= record0.length
      ? record0.subarray(fullNameOffset, fullNameOffset + fullNameLength).toString("utf8").replace(/\0+$/g, "").trim()
      : null;

  return {
    databaseName,
    compression,
    textLength,
    textRecordCount,
    encryption,
    codepage,
    firstImageIndex,
    fullName
  };
}

function readUInt32BE(buffer, offset, fallback) {
  if (offset < 0 || offset + 4 > buffer.length) return fallback;
  return buffer.readUInt32BE(offset);
}

function decompressPalmDoc(input) {
  const output = [];
  for (let index = 0; index < input.length; index += 1) {
    const byte = input[index];
    if (byte >= 1 && byte <= 8) {
      for (let literal = 0; literal < byte && index + 1 < input.length; literal += 1) {
        output.push(input[++index]);
      }
    } else if (byte >= 0x80 && byte <= 0xbf) {
      if (index + 1 >= input.length) break;
      const pair = (byte << 8) | input[++index];
      const distance = (pair >> 3) & 0x07ff;
      const length = (pair & 0x07) + 3;
      for (let copied = 0; copied < length; copied += 1) {
        const source = output.length - distance;
        output.push(source >= 0 ? output[source] : 0);
      }
    } else if (byte >= 0xc0) {
      output.push(0x20, byte ^ 0x80);
    } else {
      output.push(byte);
    }
  }
  return Buffer.from(output);
}

function collectImageRecords(records, firstImageIndex, sourceRef) {
  const images = new Map();
  if (!Number.isInteger(firstImageIndex) || firstImageIndex <= 0 || firstImageIndex >= records.length) return images;
  for (let recordIndex = firstImageIndex; recordIndex < records.length; recordIndex += 1) {
    const mime = imageMime(records[recordIndex]);
    if (!mime) continue;
    images.set(recordIndex - firstImageIndex, {
      data: records[recordIndex],
      mime,
      sourceRef: `${sourceRef}#record=${recordIndex}`
    });
  }
  return images;
}

function imageMime(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (buffer.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}

function mobiImageForNode(images, node) {
  const candidates = [];
  const recindex = getMobiNodeAttr(node, ["recindex", "data-recindex"]);
  if (recindex) addMobiImageCandidates(candidates, Number.parseInt(recindex, 10));
  const src = getMobiNodeAttr(node, ["src", "href", "xlink:href"]) || "";
  const embed = String(src).match(/kindle:embed:([0-9a-f]+)/i);
  if (embed) {
    addMobiImageCandidates(candidates, Number.parseInt(embed[1], 16));
    addMobiImageCandidates(candidates, Number.parseInt(embed[1], 10));
  }
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate)) continue;
    if (images.has(candidate)) return { ...images.get(candidate), key: candidate, recindex: candidate };
  }
  return null;
}

function getMobiNodeAttr(node, names) {
  for (const name of names) {
    const value = node.getAttribute?.(name);
    if (value) return value;
  }
  return null;
}

function addMobiImageCandidates(candidates, value) {
  if (!Number.isFinite(value)) return;
  if (value > 0) candidates.push(value - 1);
  candidates.push(value);
}

module.exports = {
  decompressPalmDoc,
  mobiImageForNode,
  parseMobiBuffer,
  readMobiFile
};
