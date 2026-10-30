import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { DialogClose } from "../ui/dialog";

export interface PageNavItem {
  id: string;
  label: string;
  icon: ReactNode;
}

/**
 * The full-window layout of Settings and Administration: a navigation column
 * (back to the chat, an optional search field, the sections) beside a
 * scrolling content column of grouped cards.
 */
export function SettingsPage({
  title,
  navLabel,
  items,
  current,
  onSelect,
  search,
  wide = false,
  children,
}: {
  title: string;
  navLabel: string;
  items: readonly PageNavItem[];
  /** The selected section, or null while search results show. */
  current: string | null;
  onSelect: (id: string) => void;
  search?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={navLabel}>
        <DialogClose asChild>
          <button type="button" className="side-row settings-back">
            <ArrowLeft size={18} aria-hidden />
            <span>Back to chat</span>
          </button>
        </DialogClose>
        <p className="settings-nav-title" aria-hidden>
          {title}
        </p>
        {search}
        <div className="settings-nav-items">
          {items.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`side-row${s.id === current ? " is-active" : ""}`}
              aria-current={s.id === current ? "page" : undefined}
              onClick={() => {
                onSelect(s.id);
              }}
            >
              {s.icon}
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      </nav>
      <div className="settings-scroll">
        <section
          className={`settings-panel${wide ? " is-wide" : ""}`}
          aria-labelledby="settings-section-title"
        >
          {children}
        </section>
      </div>
    </div>
  );
}

/** A rounded group of settings rows. */
export function SettingsCard({ children }: { children: ReactNode }) {
  return <div className="settings-card">{children}</div>;
}
