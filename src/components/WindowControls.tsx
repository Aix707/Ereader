import { Minus, Square, SquareStack, X } from "lucide-react";
import { useWindowState } from "../lib/window";

export function WindowControls() {
  const { isMaximized, isFullScreen, isBusy } = useWindowState();
  const maximizeTitle = isFullScreen ? "请先退出阅读全屏" : isMaximized ? "还原窗口" : "最大化窗口";

  return (
    <div className="window-controls" aria-label="窗口控制">
      <button type="button" disabled={isBusy} onClick={() => window.ereader.windowControls.minimize().catch(() => undefined)} title="最小化" aria-label="最小化">
        <Minus size={16} />
      </button>
      <button
        type="button"
        disabled={isFullScreen || isBusy}
        onClick={() => window.ereader.windowControls.toggleMaximize().catch(() => undefined)}
        title={maximizeTitle}
        aria-label={maximizeTitle}
      >
        {isMaximized ? <SquareStack size={16} /> : <Square size={16} />}
      </button>
      <button type="button" className="close" onClick={() => window.ereader.windowControls.close().catch(console.error)} title="关闭" aria-label="关闭">
        <X size={16} />
      </button>
    </div>
  );
}
