import { CircleHelp, FileText, Info, Keyboard, TriangleAlert } from "lucide-react";
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import type { MenuItems } from "./Menus";

/** The help dialogs load on first use. */
const HelpDialogs = lazy(() => import("./Help"));

export type HelpTopic = "about" | "faq" | "shortcuts" | "releases" | "report";

/** The help half of the header's "…" menu. */
export function helpItems(open: (topic: HelpTopic) => void): MenuItems {
  return [
    {
      label: "About ChatUI",
      icon: <Info size={20} aria-hidden />,
      onSelect: () => {
        open("about");
      },
    },
    {
      label: "Help & FAQ",
      icon: <CircleHelp size={20} aria-hidden />,
      onSelect: () => {
        open("faq");
      },
    },
    {
      label: "Keyboard shortcuts",
      icon: <Keyboard size={20} aria-hidden />,
      onSelect: () => {
        open("shortcuts");
      },
    },
    {
      label: "Release notes",
      icon: <FileText size={20} aria-hidden />,
      onSelect: () => {
        open("releases");
      },
    },
    {
      label: "Report a problem",
      icon: <TriangleAlert size={20} aria-hidden />,
      onSelect: () => {
        open("report");
      },
    },
  ];
}

/** Which help dialog is open; render `dialogs` once. */
export function useHelp(userId: string): { open: (topic: HelpTopic) => void; dialogs: ReactNode } {
  const [topic, setTopic] = useState<HelpTopic | null>(null);
  const [used, setUsed] = useState(false);
  const origin = useRef<HTMLElement | null>(null);
  return {
    open: (next) => {
      // A menu item is about to unmount: focus goes back to the menu's trigger.
      const active = document.activeElement;
      const menu =
        active instanceof HTMLElement ? active.closest<HTMLElement>('[role="menu"]') : null;
      origin.current = menu?.id
        ? document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`)
        : null;
      setUsed(true);
      setTopic(next);
    },
    dialogs: used ? (
      <Suspense fallback={null}>
        <HelpDialogs
          userId={userId}
          topic={topic}
          onClose={() => {
            setTopic(null);
          }}
          returnFocus={() => origin.current}
        />
      </Suspense>
    ) : null,
  };
}
