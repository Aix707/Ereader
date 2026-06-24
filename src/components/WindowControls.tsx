import { Fullscreen, Minus, Shrink, Square, SquareStack, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type WindowState = {
  isMaximized: boolean;
  isFullScreen: boolean;
};

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);

  const applyState = useCallback((state: WindowState) => {
    setIsMaximized(state.isMaximized);
    setIsFullScreen(state.isFullScreen);
  }, []);

  const toggleMaximize = useCallback(() => {
    window.ereader.windowControls
      .toggleMaximize()
      .then(applyState)
      .catch(() => undefined);
  }, [applyState]);

  const toggleFullScreen = useCallback(() => {
    window.ereader.windowControls
      .toggleFullScreen()
      .then(applyState)
      .catch(() => undefined);
  }, [applyState]);

  useEffect(() => {
    let cleanup: () => void = () => undefined;
    window.ereader.windowControls.getState().then(applyState).catch(() => undefined);
    cleanup = window.ereader.windowControls.onStateChanged(applyState);
    return cleanup;
  }, [applyState]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.key === "F11") {
        event.preventDefault();
        toggleFullScreen();
      }
      if (event.key === "Escape" && isFullScreen && !target.closest("input, textarea")) {
        event.preventDefault();
        toggleFullScreen();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isFullScreen, toggleFullScreen]);

  return (
    <div className="window-controls" aria-label="窗口控制">
      <button type="button" onClick={() => window.ereader.windowControls.minimize()} title="最小化">
        <Minus size={15} />
      </button>
      <button
        type="button"
        onClick={toggleMaximize}
        title={isMaximized ? "还原窗口" : "最大化窗口"}
      >
        {isMaximized ? <SquareStack size={14} /> : <Square size={14} />}
      </button>
      <button
        type="button"
        onClick={toggleFullScreen}
        title={isFullScreen ? "退出全屏 (F11)" : "系统全屏 (F11)"}
      >
        {isFullScreen ? <Shrink size={15} /> : <Fullscreen size={15} />}
      </button>
      <button type="button" className="close" onClick={() => window.ereader.windowControls.close()} title="关闭">
        <X size={16} />
      </button>
    </div>
  );
}
