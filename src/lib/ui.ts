import { useCallback, useEffect } from "react";
import type { MouseEvent, RefObject } from "react";
import { getWindowSnapshot, interactiveSelector } from "./window";

export function useDismissablePopover(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void
) {
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (ref.current?.contains(event.target as Node)) return;
      onDismiss();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
        ref.current?.querySelector("button")?.focus();
      }
    }
    window.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onDismiss, open, ref]);
}

export function useTitlebarDoubleClick(ignoreSelector: string) {
  return useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest(`${interactiveSelector},${ignoreSelector}`)) return;
      const state = getWindowSnapshot();
      if (state.isFullScreen || state.isBusy) return;
      window.ereader.windowControls.toggleMaximize().catch(() => undefined);
    },
    [ignoreSelector]
  );
}
