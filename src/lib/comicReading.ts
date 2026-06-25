import type { PageUnit, ReadingProgress } from "../types";

export interface Size {
  width: number;
  height: number;
}

export function getContainedSize(sourceWidth: number, sourceHeight: number, maxWidth: number, maxHeight: number) {
  if (sourceWidth <= 0 || sourceHeight <= 0 || maxWidth <= 0 || maxHeight <= 0) return null;
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    width: Math.max(1, Math.floor(sourceWidth * scale)),
    height: Math.max(1, Math.floor(sourceHeight * scale))
  };
}

export function spreadDisplayWidth(pages: PageUnit[], bounds: Size, gap: number) {
  const widths = pages
    .map((page) => getContainedSize(page.width, page.height, bounds.width, bounds.height)?.width || 0)
    .filter((width) => width > 0);
  if (!widths.length) return 0;
  return widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
}

export function pageIndexFromProgress(progress: ReadingProgress) {
  if (typeof progress.page === "number" && progress.page > 0) return Math.max(0, progress.page - 1);
  const percent = Number(progress.percent || 0);
  const totalPages = Number(progress.totalPages || 0);
  if (Number.isFinite(percent) && percent > 0 && totalPages > 1) {
    return Math.max(0, Math.round(Math.min(1, percent) * (totalPages - 1)));
  }
  return 0;
}

export function clampAndAlignIndex(index: number, totalPages: number, spreadSize: number) {
  if (totalPages <= 0) return 0;
  const clamped = Math.max(0, Math.min(totalPages - 1, index));
  return Math.max(0, Math.min(totalPages - 1, alignToSpreadStart(clamped, spreadSize)));
}

export function pageIndexesForSpread(startIndex: number, spreadSize: number, totalPages: number) {
  if (totalPages <= 0) return [];
  const aligned = clampAndAlignIndex(startIndex, totalPages, spreadSize);
  if (spreadSize <= 1 || aligned === 0) return [aligned];
  const indexes: number[] = [];
  for (let index = aligned; index < aligned + spreadSize && index < totalPages; index += 1) {
    indexes.push(index);
  }
  return indexes;
}

export function lastSpreadStartIndex(totalPages: number, spreadSize: number) {
  const starts = spreadStarts(totalPages, spreadSize);
  return starts[starts.length - 1] || 0;
}

export function nextSpreadStart(currentIndex: number, totalPages: number, spreadSize: number) {
  const starts = spreadStarts(totalPages, spreadSize);
  const current = clampAndAlignIndex(currentIndex, totalPages, spreadSize);
  const position = Math.max(0, starts.indexOf(current));
  return starts[Math.min(starts.length - 1, position + 1)] || current;
}

export function previousSpreadStart(currentIndex: number, spreadSize: number) {
  if (spreadSize <= 1) return currentIndex - 1;
  if (currentIndex <= 1) return 0;
  return currentIndex - spreadSize;
}

export function pageIndexesForPreload(centerIndex: number, spreadSize: number, totalPages: number, radius: number) {
  if (totalPages <= 0) return [];
  const indexes = new Set<number>();
  const starts = spreadStarts(totalPages, spreadSize);
  const spreadStart = clampAndAlignIndex(centerIndex, totalPages, spreadSize);
  const currentPosition = Math.max(0, starts.indexOf(spreadStart));
  const startPosition = Math.max(0, currentPosition - radius);
  const endPosition = Math.min(starts.length - 1, currentPosition + radius);
  for (let position = startPosition; position <= endPosition; position += 1) {
    for (const index of pageIndexesForSpread(starts[position], spreadSize, totalPages)) indexes.add(index);
  }
  return [...indexes].sort((left, right) => left - right);
}

function alignToSpreadStart(index: number, spreadSize: number) {
  if (spreadSize <= 1 || index <= 0) return Math.max(0, index);
  return Math.max(1, 1 + Math.floor((index - 1) / spreadSize) * spreadSize);
}

function spreadStarts(totalPages: number, spreadSize: number) {
  if (totalPages <= 0) return [];
  if (spreadSize <= 1) return Array.from({ length: totalPages }, (_, index) => index);
  const starts = [0];
  for (let index = 1; index < totalPages; index += spreadSize) {
    starts.push(index);
  }
  return starts;
}
