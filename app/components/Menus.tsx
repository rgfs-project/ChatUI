import * as Menu from "@radix-ui/react-dropdown-menu";
import type { MenuRequest } from "../lib/menu-request";
import {
  Check,
  Download,
  Ellipsis,
  Pencil,
  Pin,
  PinOff,
  Search,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode, type Ref } from "react";
import { Link } from "react-router";
import { ModelTrigger } from "./ModelTrigger";

/**
 * The app's dropdown menus (Radix DropdownMenu, non-modal). This module is
 * loaded on demand: each call site renders a plain, same-looking trigger
 * until it arrives, and a click on that placeholder opens the menu once it
 * has (`defaultOpen`). Radix stays out of the critical chat bundle.
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

/**
 * Radix focuses a menu's first item only when it saw the key press itself;
 * the press that opened a lazy menu reached its placeholder instead. A
 * keyboard request therefore focuses the first item here, once, on mount.
 */
function focusFirstItem(request: MenuRequest) {
  return (content: HTMLElement | null) => {
    if (!content || request !== "keyboard") return;
    requestAnimationFrame(() => {
      if (content.contains(document.activeElement) && document.activeElement !== content) return;
      // The checked radio item if there is one (model menu), else the first item.
      (
        content.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ??
        content.querySelector<HTMLElement>(
          '[role="menuitem"]:not([data-disabled]), [role="menuitemradio"]:not([data-disabled])',
        )
      )?.focus();
    });
  };
}

/** The conversation actions shared by the sidebar row and the header menu. */
function conversationItems(props: {
  malformed?: boolean;
  pinned: boolean;
  onRename: () => void;
  onTogglePin: () => void;
  onExport?: () => void;
  onDelete: () => void;
}): (MenuItemSpec | "separator")[] {
  return [
    ...(props.malformed
      ? []
      : [{ label: "Rename", icon: <Pencil size={18} aria-hidden />, onSelect: props.onRename }]),
    {
      label: props.pinned ? "Unpin" : "Pin",
      icon: props.pinned ? <PinOff size={18} aria-hidden /> : <Pin size={18} aria-hidden />,
      onSelect: props.onTogglePin,
    },
    ...(props.onExport
      ? [
          {
            label: "Export as Markdown",
            icon: <Download size={18} aria-hidden />,
            onSelect: props.onExport,
          },
        ]
      : []),
    "separator",
    {
      label: "Delete",
      icon: <Trash2 size={18} aria-hidden />,
      danger: true,
      onSelect: props.onDelete,
    },
  ];
}

/** The "…" menu on a sidebar row. */
export function RowMenu(props: {
  title: string;
  malformed: boolean;
  pinned: boolean;
  onTogglePin: () => void;
  /** Open on mount (a placeholder was activated); "keyboard" also focuses the first item. */
  defaultOpen: MenuRequest;
  onTriggerFocus: (element: HTMLElement) => void;
  onOpen: () => void;
  onOpenChange?: (open: boolean) => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <Menu.Root
      modal={false}
      defaultOpen={props.defaultOpen !== false}
      onOpenChange={(open) => {
        if (open) props.onOpen();
        props.onOpenChange?.(open);
      }}
    >
      <Menu.Trigger asChild>
        <button
          type="button"
          className="icon-btn row-menu-btn"
          aria-label={`Actions for ${props.title}`}
          title="More"
          onFocus={(event) => {
            props.onTriggerFocus(event.currentTarget);
          }}
        >
          <Ellipsis size={18} aria-hidden />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          ref={focusFirstItem(props.defaultOpen)}
          className="menu"
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={8}
        >
          <Items items={conversationItems(props)} />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

export interface ModelOption {
  /** The JSON (providerId, modelId) pair, as the composer stores it. */
  value: string;
  label: string;
  /** A muted second line, e.g. "Not loaded". */
  detail?: string;
}

export interface ModelGroup {
  id: string;
  /** Shown as a heading only when there is more than one group. */
  label: string;
  options: ModelOption[];
}

/** Long lists get a filter field; short ones stay a plain menu. */
const SEARCH_THRESHOLD = 6;

/**
 * The composer's model picker: the current model's name with a chevron,
 * opening a card of models (name over a muted detail, a check on the chosen
 * one), a filter for long lists and, for administrators, "Manage models".
 * Controlled by the composer, which also opens it for "/model".
 */
export function ModelMenu(props: {
  label: string;
  value: string;
  groups: ModelGroup[];
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** How it was opened before this chunk arrived ("keyboard" focuses an item). */
  request: MenuRequest;
  onChange: (value: string) => void;
  /** Settings → Models, shown to administrators. */
  manageHref?: string;
}) {
  const [filter, setFilter] = useState("");
  const total = props.groups.reduce((n, g) => n + g.options.length, 0);
  const needle = filter.trim().toLowerCase();
  const groups = props.groups
    .map((g) => ({
      ...g,
      options: needle ? g.options.filter((o) => o.label.toLowerCase().includes(needle)) : g.options,
    }))
    .filter((g) => g.options.length > 0);
  const headed = groups.length > 1;
  return (
    <Menu.Root
      modal={false}
      open={props.open}
      onOpenChange={(open) => {
        if (!open) setFilter("");
        props.onOpenChange(open);
      }}
    >
      <Menu.Trigger asChild disabled={props.disabled}>
        <ModelTrigger label={props.label} disabled={props.disabled} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          ref={focusFirstItem(props.request)}
          className="menu model-menu"
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
        >
          {total > SEARCH_THRESHOLD ? (
            <label className="model-search">
              <Search size={18} aria-hidden />
              <span className="visually-hidden">Search models</span>
              <input
                type="search"
                placeholder="Search models"
                value={filter}
                onChange={(event) => {
                  setFilter(event.currentTarget.value);
                }}
                // Typing filters; Radix's typeahead must not steal the keys.
                onKeyDown={(event) => {
                  if (event.key !== "Escape" && event.key !== "ArrowDown") event.stopPropagation();
                }}
              />
            </label>
          ) : null}
          <Menu.RadioGroup value={props.value} onValueChange={props.onChange}>
            {groups.map((group) => (
              <Menu.Group key={group.id}>
                {headed ? <Menu.Label className="menu-label">{group.label}</Menu.Label> : null}
                {group.options.map((option) => (
                  <Menu.RadioItem
                    key={option.value}
                    value={option.value}
                    className="menu-item model-option"
                    data-model={option.value}
                  >
                    <span className="text">
                      <span className="name">{option.label}</span>
                      {option.detail ? <span className="desc">{option.detail}</span> : null}
                    </span>
                    <Menu.ItemIndicator className="trail">
                      <Check size={18} aria-hidden />
                    </Menu.ItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.Group>
            ))}
          </Menu.RadioGroup>
          {needle && groups.length === 0 ? <p className="menu-label">No matching models</p> : null}
          {props.manageHref ? (
            <>
              <Menu.Separator className="menu-separator" />
              <Menu.Item asChild className="menu-item">
                <Link to={props.manageHref}>
                  <SlidersHorizontal size={18} aria-hidden />
                  Manage models
                </Link>
              </Menu.Item>
            </>
          ) : null}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The header's "…" menu for the open conversation: Rename, Pin, Export, Delete. */
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
  /** Downloads the chat's exact Markdown. */
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
      <Menu.Trigger
        ref={triggerRef}
        className="icon-btn title-trigger"
        aria-label={`Actions for ${title}`}
        title="More options"
      >
        <Ellipsis size={20} aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          ref={focusFirstItem(defaultOpen)}
          className="menu"
          align="end"
          sideOffset={6}
          collisionPadding={8}
        >
          <Items items={conversationItems({ pinned, onRename, onTogglePin, onExport, onDelete })} />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
