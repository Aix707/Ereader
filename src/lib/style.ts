import type { CSSProperties } from "react";
import { clampUnit } from "./number";

export type CssVariableStyle<Name extends string = string> = CSSProperties & Record<`--${Name}`, string | number>;

export function widthPercentStyle(value: unknown, minPercent = 0): CSSProperties {
  return { width: percentValue(value, minPercent) };
}

export function heightPercentStyle(value: unknown, minPercent = 0): CSSProperties {
  return { height: percentValue(value, minPercent) };
}

export function topPercentStyle(value: unknown): CSSProperties {
  return { top: percentValue(value) };
}

function percentValue(value: unknown, minPercent = 0) {
  return `${Math.max(minPercent, clampUnit(value) * 100)}%`;
}
