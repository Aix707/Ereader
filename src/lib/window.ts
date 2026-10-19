import { useSyncExternalStore } from "react";
import type { WindowState } from "../types";

interface WindowSnapshot extends WindowState { isBusy: boolean }
let snapshot: WindowSnapshot = { isMaximized: false, isFullScreen: false, isBusy: false };
const listeners = new Set<() => void>();

export function publishWindowState(patch: Partial<WindowSnapshot>): void {
  const next = { ...snapshot, ...patch };
  if (next.isMaximized === snapshot.isMaximized && next.isFullScreen === snapshot.isFullScreen && next.isBusy === snapshot.isBusy) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getWindowSnapshot(): WindowSnapshot { return snapshot; }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useWindowState(): WindowSnapshot { return useSyncExternalStore(subscribe, getWindowSnapshot); }

export const interactiveSelector = "button,input,select,textarea,a,[role='button'],[role='slider'],[contenteditable='true'],[data-ui-popover],.window-controls,.segmented-control";
