import { Maximize2, Minimize2, Minus, X } from "lucide-react";
import { useEffect, useState } from "react";

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let cleanup: () => void = () => undefined;
    window.ereader.windowControls.getState().then((state) => setIsMaximized(state.isMaximized)).catch(() => undefined);
    cleanup = window.ereader.windowControls.onStateChanged((state) => setIsMaximized(state.isMaximized));
    return cleanup;
  }, []);

  return (
    <div className="window-controls" aria-label="窗口控制">
      <button type="button" onClick={() => window.ereader.windowControls.minimize()} title="最小化">
        <Minus size={15} />
      </button>
      <button
        type="button"
        onClick={() => window.ereader.windowControls.toggleMaximize().then((state) => setIsMaximized(state.isMaximized))}
        title={isMaximized ? "还原" : "最大化"}
      >
        {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      </button>
      <button type="button" className="close" onClick={() => window.ereader.windowControls.close()} title="关闭">
        <X size={16} />
      </button>
    </div>
  );
}
