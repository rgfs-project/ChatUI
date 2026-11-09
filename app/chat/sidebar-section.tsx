import { ChevronDown } from "lucide-react";

/** A folding sidebar section: its heading is a button (reference UI). */
export function Section({
  id,
  label,
  collapsed,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  collapsed: boolean;
  onToggle: (collapsed: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <h2 className="side-heading">
        <button
          type="button"
          className={`side-label${collapsed ? " is-collapsed" : ""}`}
          aria-expanded={!collapsed}
          aria-controls={id}
          onClick={() => {
            onToggle(!collapsed);
          }}
        >
          <span>{label}</span>
          <ChevronDown size={14} className="side-label-chevron" aria-hidden />
        </button>
      </h2>
      {collapsed ? null : children}
    </>
  );
}
