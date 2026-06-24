import type { CSSProperties } from "react";
import type { AppearanceSettings } from "../types";
import { clampUnit } from "./number";

const DEFAULT_BACKGROUND_LAYER = "linear-gradient(#fff, #fff)";

export function globalBackgroundStyle(appearance: AppearanceSettings): CSSProperties {
  const opacity = clampUnit(appearance.backgroundOpacity, 0.18);
  const imageVersion = Number(appearance.backgroundImageVersion || 0);
  const layerMode = appearance.backgroundLayerMode || "default";
  const tintLayer = `linear-gradient(135deg, rgba(255, 255, 255, ${opacity.toFixed(2)}), rgba(232, 243, 255, ${opacity.toFixed(2)}))`;

  if (layerMode === "none") {
    return {
      "--app-background-tint": tintLayer,
      "--app-background-layer": "none",
      "--app-background-fill": "transparent"
    } as CSSProperties;
  }

  return {
    "--app-background-tint": tintLayer,
    "--app-background-layer":
      layerMode === "image"
        ? `url("${window.ereader.getBackgroundImageUrl()}?v=${imageVersion}") center / cover no-repeat`
        : DEFAULT_BACKGROUND_LAYER,
    "--app-background-fill": "transparent"
  } as CSSProperties;
}
