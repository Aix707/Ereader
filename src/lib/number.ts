export function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export function clampUnit(value: unknown, fallback = 0) {
  return clampNumber(value, 0, 1, fallback);
}
