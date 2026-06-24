import { Settings } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { AppSettings } from "../types";
import { useDismissablePopover } from "../lib/ui";

interface AppearanceSettingsMenuProps {
  backgroundOpacity: number;
  onChange: (backgroundOpacity: number) => void;
  onChooseImage: () => Promise<AppSettings>;
  onReset: () => Promise<AppSettings>;
  onRemove: () => Promise<AppSettings>;
}

export function AppearanceSettingsMenu({
  backgroundOpacity,
  onChange,
  onChooseImage,
  onReset,
  onRemove
}: AppearanceSettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const dismiss = useCallback(() => setOpen(false), []);

  useDismissablePopover(open, menuRef, dismiss);

  return (
    <div className="appearance-settings-menu" ref={menuRef}>
      <button
        className={open ? "toolbar-button active" : "toolbar-button"}
        type="button"
        onClick={() => setOpen((value) => !value)}
        title="外观设置"
        aria-label="外观设置"
      >
        <Settings size={16} />
      </button>
      {open && (
        <div className="appearance-settings-popover">
          <header>
            <strong>外观设置</strong>
            <span>{Math.round(backgroundOpacity * 100)}%</span>
          </header>
          <label className="appearance-setting-range">
            <span>白蓝渐变透明度</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(backgroundOpacity * 100)}
              onChange={(event) => onChange(Number(event.target.value) / 100)}
            />
          </label>
          <div className="appearance-background-actions" aria-label="底层背景">
            <button type="button" onClick={() => onChooseImage().catch(() => undefined)}>
              更换
            </button>
            <button type="button" onClick={() => onReset().catch(() => undefined)}>
              默认
            </button>
            <button type="button" onClick={() => onRemove().catch(() => undefined)}>
              删除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
