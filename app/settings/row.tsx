import type { ReactNode } from "react";

/**
 * One labelled settings row: text on the left, its control on the right.
 * `stacked` puts a wide control (a text area) under the text instead.
 */
export function Row({
  label,
  hint,
  children,
  labelFor,
  stacked = false,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  labelFor?: string;
  stacked?: boolean;
}) {
  return (
    <div className={`settings-row${stacked ? " is-stacked" : ""}`}>
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

/** The end of a form in a card: an optional note, then its buttons on the right. */
export function FormActions({ hint, children }: { hint?: string; children: ReactNode }) {
  return (
    <div className="settings-actions">
      {hint ? <span className="settings-row-hint">{hint}</span> : null}
      <div className="settings-actions-buttons">{children}</div>
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
