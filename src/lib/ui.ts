import { useCallback, useEffect } from "react";
import type { MouseEvent, RefObject } from "react";

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
      if (event.key === "Escape") onDismiss();
    }
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onDismiss, open, ref]);
}

export function useTitlebarDoubleClick(ignoreSelector: string) {
  return useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest(ignoreSelector)) return;
      window.ereader.windowControls
        .getState()
        .then((state) => state.isFullScreen
          ? window.ereader.windowControls.toggleFullScreen()
          : window.ereader.windowControls.toggleMaximize())
        .catch(() => undefined);
    },
    [ignoreSelector]
  );
}
