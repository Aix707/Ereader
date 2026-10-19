import type { ReactNode } from "react";

interface SegmentedControlProps {
  value: string;
  options: Array<{ value: string; label: string; icon: ReactNode }>;
  onChange: (value: string) => void;
}

export function SegmentedControl({ value, options, onChange }: SegmentedControlProps) {
  return (
    <div className="segmented-control" role="group" aria-label={options.map((option) => option.label).join("、")}>
      {options.map((option) => (
        <button
          key={option.value}
          className={option.value === value ? "active" : ""}
          onClick={() => onChange(option.value)}
          title={option.label}
          aria-label={option.label}
          aria-pressed={option.value === value}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}
