import { Fullscreen, Minus, Shrink, Square, SquareStack, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);

  const toggleFullScreen = useCallback(() => {
    window.ereader.windowControls
      .toggleFullScreen()
      .then((state) => setIsFullScreen(state.isFullScreen))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cleanup: () => void = () => undefined;
    const applyState = (state: { isMaximized: boolean; isFullScreen: boolean }) => {
      setIsMaximized(state.isMaximized);
      setIsFullScreen(state.isFullScreen);
    };
    window.ereader.windowControls.getState().then(applyState).catch(() => undefined);
    cleanup = window.ereader.windowControls.onStateChanged(applyState);
    return cleanup;
  }, []);

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
        onClick={() => window.ereader.windowControls.toggleMaximize().then((state) => setIsMaximized(state.isMaximized))}
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
