import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { DialogClose } from "../ui/dialog";

export interface AdminNavItem {
  id: string;
  label: string;
  /** One line under the section title. */
  description: string;
}

/**
 * Administration's own full-window layout: a plain bar, the sections as text
 * tabs along the top, and a single content column. Settings keeps its side
 * list of cards, so the two places can't be mistaken for each other.
 */
export function AdminPage({
  items,
  current,
  onSelect,
  children,
}: {
  items: readonly AdminNavItem[];
  current: AdminNavItem;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="admin">
      <header className="admin-top">
        <DialogClose asChild>
          <button type="button" className="admin-back">
            <ArrowLeft size={18} aria-hidden />
            <span>Back to chat</span>
          </button>
        </DialogClose>
        <p className="admin-brand" aria-hidden>
          Administration
        </p>
      </header>
      <nav className="admin-tabs" aria-label="Administration sections">
        {items.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`admin-tab${s.id === current.id ? " is-active" : ""}`}
            aria-current={s.id === current.id ? "page" : undefined}
            onClick={() => {
              onSelect(s.id);
            }}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="admin-scroll">
        <section className="admin-content" aria-labelledby="admin-section-title">
          <div className="admin-heading">
            <h2 id="admin-section-title" className="admin-title">
              {current.label}
            </h2>
            <p className="admin-description">{current.description}</p>
          </div>
          <div className="admin-panel">{children}</div>
        </section>
      </div>
    </div>
  );
}
