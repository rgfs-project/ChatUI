import type { ReactNode } from "react";

/** One labelled settings row: text on the left, its control on the right. */
export function Row({
  label,
  hint,
  children,
  labelFor,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  labelFor?: string;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        {labelFor ? (
          <label className="settings-row-label" htmlFor={labelFor}>
            {label}
          </label>
        ) : (
          <span className="settings-row-label">{label}</span>
        )}
        {hint ? <span className="settings-row-hint">{hint}</span> : null}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

export interface SettingsRow {
  id: string;
  /** Searched by the settings filter, together with `keywords`. */
  label: string;
  keywords?: string;
  render: () => ReactNode;
}

export interface SettingsSection {
  id: string;
  label: string;
  icon: ReactNode;
  rows: SettingsRow[];
}

export function matches(row: SettingsRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${row.label} ${row.keywords ?? ""}`.toLowerCase().includes(q);
}
