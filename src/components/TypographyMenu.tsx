import { Search, Type } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NovelReadingSettings, SystemFontItem } from "../types";
import { DEFAULT_NOVEL_READING_SETTINGS } from "../types";
import { useDismissablePopover } from "../lib/ui";

interface TypographyMenuProps {
  open: boolean;
  settings: NovelReadingSettings;
  onOpenChange: (open: boolean) => void;
  onChange: (patch: Partial<NovelReadingSettings>) => void;
}

export function TypographyMenu({ open, settings, onOpenChange, onChange }: TypographyMenuProps) {
  const [fonts, setFonts] = useState<SystemFontItem[]>([]);
  const [query, setQuery] = useState("");
  const [isLoadingFonts, setIsLoadingFonts] = useState(false);
  const [fontWasReset, setFontWasReset] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const dismiss = useCallback(() => onOpenChange(false), [onOpenChange]);

  useDismissablePopover(open, menuRef, dismiss);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setIsLoadingFonts(true);
    window.ereader
      .listSystemFonts()
      .then((items) => {
        if (!cancelled) setFonts(items);
      })
      .catch(() => {
        if (!cancelled) setFonts([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingFonts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const fontOptions = useMemo(() => {
    const seen = new Set<string>();
    const values: SystemFontItem[] = [{ family: "serif", source: "fallback" }, ...fonts];
    return values.filter((item) => {
      const key = item.family.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [fonts]);

  const selectedFontExists = useMemo(
    () => fontOptions.some((item) => item.family.toLowerCase() === settings.fontFamily.toLowerCase()),
    [fontOptions, settings.fontFamily]
  );

  useEffect(() => {
    if (!open || isLoadingFonts || selectedFontExists || fontWasReset) return;
    setFontWasReset(true);
    onChange({ fontFamily: "serif" });
  }, [fontWasReset, isLoadingFonts, onChange, open, selectedFontExists]);

  const filteredFonts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return fontOptions;
    return fontOptions.filter((item) => item.family.toLowerCase().includes(needle));
  }, [fontOptions, query]);

  return (
    <div className="typography-menu" ref={menuRef}>
      <button
        className={open ? "toolbar-button active" : "toolbar-button"}
        onClick={() => onOpenChange(!open)}
        title="小说排版"
        aria-label="小说排版"
      >
        <Type size={16} />
      </button>
      {open && (
        <div className="typography-popover">
          <header>
            <strong>小说排版</strong>
            <span>{settings.fontSize}px · {settings.lineHeight.toFixed(2)}</span>
          </header>

          <label className="typography-field">
            <span>
              字体
              {settings.fontFamily === "serif" && <em>系统默认衬线</em>}
            </span>
            <div className="font-search">
              <Search size={14} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索系统字体" />
            </div>
            <select
              value={selectedFontExists ? settings.fontFamily : "serif"}
              onChange={(event) => {
                setFontWasReset(false);
                onChange({ fontFamily: event.target.value });
              }}
            >
              {filteredFonts.map((font) => (
                <option key={`${font.source}:${font.family}`} value={font.family}>
                  {font.family === "serif" ? "系统默认衬线" : font.family}
                </option>
              ))}
            </select>
            {isLoadingFonts && <small>正在读取系统字体...</small>}
            {fontWasReset && <small>上次选择的字体不可用，已回退到默认字体。</small>}
          </label>

          <TypographyRange
            label="字号"
            value={settings.fontSize}
            min={16}
            max={28}
            step={1}
            suffix="px"
            onChange={(fontSize) => onChange({ fontSize })}
          />
          <TypographyRange
            label="行距"
            value={settings.lineHeight}
            min={1.45}
            max={2.2}
            step={0.05}
            onChange={(lineHeight) => onChange({ lineHeight })}
          />
          <TypographyRange
            label="段距"
            value={settings.paragraphSpacing}
            min={0.4}
            max={2.2}
            step={0.05}
            suffix="em"
            onChange={(paragraphSpacing) => onChange({ paragraphSpacing })}
          />
          <TypographyRange
            label="页面宽度"
            value={settings.pageWidth}
            min={620}
            max={980}
            step={20}
            suffix="px"
            onChange={(pageWidth) => onChange({ pageWidth })}
          />
          <button
            className="typography-reset"
            type="button"
            onClick={() => {
              setFontWasReset(false);
              setQuery("");
              onChange(DEFAULT_NOVEL_READING_SETTINGS);
            }}
          >
            恢复默认
          </button>
        </div>
      )}
    </div>
  );
}

function TypographyRange({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="typography-range">
      <span>
        {label}
        <strong>{formatSettingValue(value, suffix)}</strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function formatSettingValue(value: number, suffix: string) {
  if (suffix === "px") return `${Math.round(value)}px`;
  if (suffix === "em") return `${value.toFixed(2)}em`;
  return value.toFixed(2);
}
