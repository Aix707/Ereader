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
  const clamped = Math.max(0, Math.min(totalPages - 1, Number.isFinite(index) ? Math.trunc(index) : 0));
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
  return clampAndAlignIndex(totalPages - 1, totalPages, spreadSize);
}

export function nextSpreadStart(currentIndex: number, totalPages: number, spreadSize: number) {
  if (totalPages <= 0) return 0;
  const current = clampAndAlignIndex(currentIndex, totalPages, spreadSize);
  const next = spreadSize <= 1 || current === 0 ? current + 1 : current + spreadSize;
  return Math.min(lastSpreadStartIndex(totalPages, spreadSize), next);
}

export function previousSpreadStart(currentIndex: number, spreadSize: number) {
  const current = alignToSpreadStart(Math.max(0, Math.trunc(currentIndex) || 0), spreadSize);
  return Math.max(0, current - Math.max(1, spreadSize));
}

export function pageIndexesForPreload(centerIndex: number, spreadSize: number, totalPages: number, radius: number) {
  if (totalPages <= 0) return [];
  const indexes = new Set<number>();
  const spreadStart = clampAndAlignIndex(centerIndex, totalPages, spreadSize);
  const currentPosition = spreadSize <= 1 ? spreadStart : spreadStart === 0 ? 0 : 1 + (spreadStart - 1) / spreadSize;
  const spreadCount = spreadSize <= 1 ? totalPages : 1 + Math.ceil((totalPages - 1) / spreadSize);
  const startPosition = Math.max(0, currentPosition - radius);
  const endPosition = Math.min(spreadCount - 1, currentPosition + radius);
  for (let position = startPosition; position <= endPosition; position += 1) {
    const start = spreadSize <= 1 ? position : position === 0 ? 0 : 1 + (position - 1) * spreadSize;
    for (const index of pageIndexesForSpread(start, spreadSize, totalPages)) indexes.add(index);
  }
  return [...indexes].sort((left, right) => left - right);
}

function alignToSpreadStart(index: number, spreadSize: number) {
  if (spreadSize <= 1 || index <= 0) return Math.max(0, index);
  return Math.max(1, 1 + Math.floor((index - 1) / spreadSize) * spreadSize);
}
