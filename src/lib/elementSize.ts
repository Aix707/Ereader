import { type RefObject, useLayoutEffect, useState } from "react";

export interface ElementSize {
  width: number;
  height: number;
}

const EMPTY_SIZE: ElementSize = { width: 0, height: 0 };

export function useElementSize<T extends HTMLElement>(ref: RefObject<T>, refreshKey?: unknown) {
  const [size, setSize] = useState<ElementSize>(EMPTY_SIZE);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      setSize(EMPTY_SIZE);
      return;
    }

    const measure = () => {
      const next = {
        width: Math.max(1, element.clientWidth),
        height: Math.max(1, element.clientHeight)
      };
      setSize((current) => (current.width === next.width && current.height === next.height ? current : next));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, refreshKey]);

  return size;
}
