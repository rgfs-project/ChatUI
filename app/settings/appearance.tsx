import { Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import {
  ACCENTS,
  CODE_SIZES,
  THEMES,
  UI_SIZES,
  type Accent,
  type Appearance,
  type Theme,
} from "../lib/appearance";
import { useUi } from "../lib/ui-context";
import { Row, type SettingsRow } from "./row";

const THEME_LABEL: Record<Theme, string> = { light: "Light", dark: "Dark", system: "System" };
const THEME_ICON: Record<Theme, ReactNode> = {
  light: <Sun size={18} aria-hidden />,
  dark: <Moon size={18} aria-hidden />,
  system: <Monitor size={18} aria-hidden />,
};
const ACCENT_LABEL: Record<Accent, string> = {
  blue: "Blue",
  green: "Green",
  yellow: "Yellow",
  pink: "Pink",
  orange: "Orange",
  purple: "Purple",
};

function useSet(): (patch: Partial<Appearance>) => void {
  const { appearance, setAppearance } = useUi();
  return (patch) => {
    setAppearance({ ...appearance, ...patch });
  };
}

function ThemeTiles() {
  const { appearance } = useUi();
  const set = useSet();
  return (
    <div className="mode-tiles" role="radiogroup" aria-label="Theme">
      {THEMES.map((theme) => (
        <label key={theme} className={`mode-tile${appearance.theme === theme ? " is-active" : ""}`}>
          <input
            type="radio"
            name="theme"
            value={theme}
            checked={appearance.theme === theme}
            onChange={() => {
              set({ theme });
            }}
          />
          <span className={`mode-preview mode-${theme}`} aria-hidden>
            {THEME_ICON[theme]}
          </span>
          <span>{THEME_LABEL[theme]}</span>
        </label>
      ))}
    </div>
  );
}

function AccentSwatches() {
  const { appearance } = useUi();
  const set = useSet();
  return (
    <div className="swatches" role="radiogroup" aria-label="Accent colour">
      {ACCENTS.map((accent) => (
        <label key={accent} className="swatch" title={ACCENT_LABEL[accent]}>
          <input
            type="radio"
            name="accent"
            value={accent}
            checked={appearance.accent === accent}
            aria-label={ACCENT_LABEL[accent]}
            onChange={() => {
              set({ accent });
            }}
          />
          <span className={`swatch-dot accent-${accent}`} aria-hidden />
        </label>
      ))}
    </div>
  );
}

function SizeSelect({
  id,
  sizes,
  value,
  reference,
  onChange,
}: {
  id: string;
  sizes: readonly number[];
  value: number;
  reference: number;
  onChange: (value: number) => void;
}) {
  return (
    <select
      id={id}
      className="pill-button pill-select native-select"
      value={value}
      onChange={(event) => {
        onChange(Number(event.target.value));
      }}
    >
      {sizes.map((size) => (
        <option key={size} value={size}>
          {size === reference ? `${String(size)} px (default)` : `${String(size)} px`}
        </option>
      ))}
    </select>
  );
}

function UiSize() {
  const { appearance } = useUi();
  const set = useSet();
  return (
    <Row label="Interface text size" labelFor="ui-size" hint="Scales the whole interface.">
      <SizeSelect
        id="ui-size"
        sizes={UI_SIZES}
        reference={14}
        value={appearance.uiSize}
        onChange={(uiSize) => {
          set({ uiSize });
        }}
      />
    </Row>
  );
}

function CodeSize() {
  const { appearance } = useUi();
  const set = useSet();
  return (
    <Row label="Code text size" labelFor="code-size">
      <SizeSelect
        id="code-size"
        sizes={CODE_SIZES}
        reference={12}
        value={appearance.codeSize}
        onChange={(codeSize) => {
          set({ codeSize });
        }}
      />
    </Row>
  );
}

function ReduceMotion() {
  const { appearance } = useUi();
  const set = useSet();
  return (
    <Row label="Reduce motion" labelFor="reduce-motion" hint="Off follows your system setting.">
      <input
        id="reduce-motion"
        type="checkbox"
        role="switch"
        className="switch"
        checked={appearance.motion === "reduce"}
        onChange={(event) => {
          set({ motion: event.target.checked ? "reduce" : "system" });
        }}
      />
    </Row>
  );
}

export const appearanceRows: SettingsRow[] = [
  {
    id: "theme",
    label: "Theme",
    keywords: "light dark system mode colour color",
    render: () => (
      <Row label="Theme">
        <ThemeTiles />
      </Row>
    ),
  },
  {
    id: "accent",
    label: "Accent colour",
    keywords: "accent color colour blue green yellow pink orange purple",
    render: () => (
      <Row label="Accent colour">
        <AccentSwatches />
      </Row>
    ),
  },
  {
    id: "ui-size",
    label: "Interface text size",
    keywords: "font zoom scale size text",
    render: () => <UiSize />,
  },
  {
    id: "code-size",
    label: "Code text size",
    keywords: "font monospace code size",
    render: () => <CodeSize />,
  },
  {
    id: "motion",
    label: "Reduce motion",
    keywords: "animation transition accessibility",
    render: () => <ReduceMotion />,
  },
];
