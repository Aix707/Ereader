import type { TextUnit } from "../types";

export function estimateTextUnitHeight(
  unit: TextUnit,
  contentWidth: number,
  fontSize: number,
  lineHeight: number,
  paragraphSpacing: number,
  viewportHeight: number
) {
  const linePx = Math.max(18, fontSize * lineHeight);
  const paragraphPx = Math.max(8, fontSize * paragraphSpacing);
  const blockMargin = Math.max(14, paragraphPx);

  if (unit.type === "heading") {
    return Math.ceil(linePx * 1.7 + blockMargin * 1.8);
  }

  if (unit.type === "image") {
    const maxImageHeight = Math.max(220, viewportHeight * 0.72);
    if (unit.width && unit.height) {
      const scale = Math.min(1, contentWidth / unit.width, maxImageHeight / unit.height);
      return Math.ceil(unit.height * scale + blockMargin * 2.4);
    }
    return Math.ceil(Math.min(460, maxImageHeight) + blockMargin * 2.4);
  }

  const text = unit.text || stripHtml(unit.html || "");
  const charsPerLine = Math.max(12, Math.floor(contentWidth / Math.max(10, fontSize * 0.98)));
  const lines = text
    .split(/\n/)
    .map((line) => Math.max(1, Math.ceil(measureTextUnits(line.trim()) / charsPerLine)))
    .reduce((sum, count) => sum + count, 0);
  return Math.ceil(Math.max(1, lines) * linePx + paragraphPx);
}

export function cssFontFamily(value: string) {
  const family = String(value || "").replace(/[\u0000-\u001f;"{}]/g, "").trim();
  if (!family || family === "serif") return '"Times New Roman", SimSun, serif';
  if (family === "system-ui") return 'system-ui, "Segoe UI", "Microsoft YaHei UI", sans-serif';
  return `"${family.replace(/\\/g, "")}", "Microsoft YaHei", SimSun, serif`;
}

export function findUnitAtOffset(offsets: number[], target: number) {
  let low = 0;
  let high = Math.max(0, offsets.length - 1);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function measureTextUnits(value: string) {
  let units = 0;
  for (const char of value) {
    units += /[\u1100-\u11ff\u2e80-\ua4cf\uf900-\ufaff\uff00-\uffef]/.test(char) ? 1 : 0.58;
  }
  return units;
}
