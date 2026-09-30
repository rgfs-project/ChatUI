import * as Menu from "@radix-ui/react-dropdown-menu";
import type { MenuRequest } from "../lib/menu-request";
import {
  ChevronDown,
  LogOut,
  MoreHorizontal,
  Pencil,
  Pin,
  ArrowDownUp,
  PinOff,
  Settings,
  Shield,
  Trash2,
} from "lucide-react";
import type { ReactNode, Ref } from "react";
import { Link } from "react-router";
import { paths, type OverlayState } from "../lib/paths";
import { AccountLabel } from "./AccountLabel";

/**
 * The app's dropdown menus (Radix DropdownMenu, non-modal; INV-47). This
 * module is loaded on demand (Phase 9): each call site renders a plain,
 * same-looking trigger until it arrives, and a click on that placeholder
 * opens the menu once it has (`defaultOpen`). Radix and Floating UI stay out
 * of the critical chat bundle.
 */

interface MenuItemSpec {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  onSelect: () => void;
}

function Items({ items }: { items: (MenuItemSpec | "separator")[] }) {
  return items.map((item, n) =>
    item === "separator" ? (
      <Menu.Separator key={`separator-${String(n)}`} className="menu-separator" />
    ) : (
      <Menu.Item
        key={item.label}
        className={`menu-item${item.danger ? " danger" : ""}`}
        onSelect={item.onSelect}
      >
        {item.icon}
        {item.label}
      </Menu.Item>
    ),
  );
}

/** The "…" menu on a sidebar row. */
/**
 * Radix focuses a menu's first item only when it saw the key press itself;
 * the press that opened a lazy menu reached its placeholder instead, before
 * the menu existed. A keyboard request therefore focuses the first item here
 * (WAI-ARIA menu button pattern), once, when the content mounts.
 */
function focusFirstItem(request: MenuRequest) {
  return (content: HTMLElement | null) => {
    if (!content || request !== "keyboard") return;
    requestAnimationFrame(() => {
      if (content.contains(document.activeElement) && document.activeElement !== content) return;
      content.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')?.focus();
    });
  };
}

export function RowMenu(props: {
  title: string;
  malformed: boolean;
  pinned: boolean;
  onTogglePin: () => void;
  /** Open on mount (a placeholder was activated); "keyboard" also focuses the first item. */
  defaultOpen: MenuRequest;
  onTriggerFocus: (element: HTMLElement) => void;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <Menu.Root
      modal={false}
      defaultOpen={props.defaultOpen !== false}
      onOpenChange={(open) => {
        if (open) props.onOpen();
      }}
    >
      <Menu.Trigger asChild>
        <button
          type="button"
          className="icon-btn row-menu"
          aria-label={`Actions for ${props.title}`}
          title="More"
          onFocus={(event) => {
            props.onTriggerFocus(event.currentTarget);
          }}
        >
          <MoreHorizontal size={16} aria-hidden />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          ref={focusFirstItem(props.defaultOpen)}
          className="menu-popover"
          align="start"
          sideOffset={4}
        >
          <Items
            items={[
              ...(props.malformed
                ? []
                : [
                    {
                      label: "Rename",
                      icon: <Pencil size={16} aria-hidden />,
                      onSelect: props.onRename,
                    },
                  ]),
              {
                label: props.pinned ? "Unpin" : "Pin",
                icon: props.pinned ? (
                  <PinOff size={16} aria-hidden />
                ) : (
                  <Pin size={16} aria-hidden />
                ),
                onSelect: props.onTogglePin,
              },
              {
                label: "Delete",
                icon: <Trash2 size={16} aria-hidden />,
                danger: true,
                onSelect: props.onDelete,
              },
            ]}
          />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The conversation title in the header: Rename, Pin, Export, Delete. */
export function TitleMenu({
  title,
  defaultOpen,
  triggerRef,
  onOpen,
  onRename,
  onDelete,
  pinned,
  onTogglePin,
  onExport,
}: {
  title: string;
  pinned: boolean;
  onTogglePin: () => void;
  /** Downloads the chat's exact Markdown (Phase 13d). */
  onExport?: () => void;
  /** Open on mount (a placeholder was activated); "keyboard" also focuses the first item. */
  defaultOpen: MenuRequest;
  triggerRef: Ref<HTMLButtonElement>;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <Menu.Root
      modal={false}
      defaultOpen={defaultOpen !== false}
      onOpenChange={(open) => {
        if (open) onOpen();
      }}
    >
      <Menu.Trigger ref={triggerRef} className="title-trigger">
        <span className="title-text">{title}</span>
        <ChevronDown size={16} aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          ref={focusFirstItem(defaultOpen)}
          className="menu-popover"
          align="start"
          sideOffset={6}
        >
          <Items
            items={[
              { label: "Rename", onSelect: onRename },
              { label: pinned ? "Unpin" : "Pin", onSelect: onTogglePin },
              ...(onExport ? [{ label: "Export as Markdown", onSelect: onExport }] : []),
              { label: "Delete", danger: true, onSelect: onDelete },
            ]}
          />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Avatar and name at the bottom of the sidebar: Settings, Administration, Sign out. */
export function AccountMenu(props: {
  username: string;
  isAdmin: boolean;
  /** Open on mount (a placeholder was activated); "keyboard" also focuses the first item. */
  defaultOpen: MenuRequest;
  /** Settings/Administration keep the current view behind them (URL-backed overlays). */
  overlayState: OverlayState;
  onNavigate: () => void;
  onSignOut: () => void;
}) {
  // Real links: the router discovers and prefetches the overlay routes while
  // the menu is open, so choosing one is instant.
  const overlayItem = (to: string, label: string, icon: ReactNode) => (
    <Menu.Item asChild className="menu-item">
      <Link to={to} state={props.overlayState} prefetch="render" onClick={props.onNavigate}>
        {icon}
        {label}
      </Link>
    </Menu.Item>
  );
  return (
    <Menu.Root modal={false} defaultOpen={props.defaultOpen !== false}>
      <Menu.Trigger className="account-trigger">
        <AccountLabel username={props.username} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          ref={focusFirstItem(props.defaultOpen)}
          className="menu-popover account-popover"
          side="top"
          sideOffset={6}
        >
          {overlayItem(paths.settings(), "Settings", <Settings size={16} aria-hidden />)}
          {overlayItem(
            paths.settings("data"),
            "Import & export",
            <ArrowDownUp size={16} aria-hidden />,
          )}
          {props.isAdmin
            ? overlayItem(paths.admin(), "Administration", <Shield size={16} aria-hidden />)
            : null}
          <Items
            items={[
              "separator",
              {
                label: "Sign out",
                icon: <LogOut size={16} aria-hidden />,
                onSelect: props.onSignOut,
              },
            ]}
          />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
