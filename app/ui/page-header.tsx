import { PanelLeftOpen } from "lucide-react";
import type { ReactNode } from "react";
import { useUi } from "../lib/ui-context";
import { IconButton } from "./icon-button";

/** Header of a full page (Library, Profile): the sidebar toggle, a title and actions. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  const { setSidebarOpen } = useUi();
  return (
    <header className="chat-header page-header">
      <div className="header-start">
        <IconButton
          label="Open sidebar"
          className="sidebar-open"
          tooltipSide="right"
          onClick={() => {
            setSidebarOpen(true);
          }}
        >
          <PanelLeftOpen size={20} aria-hidden />
        </IconButton>
        <h1 className="header-title">{title}</h1>
      </div>
      <div className="header-end">{children}</div>
    </header>
  );
}
