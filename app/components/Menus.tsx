import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  CircleUserRound,
  ChevronRight,
  Ellipsis,
  LogOut,
  Settings,
  Shield,
  Sparkles,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { type ReactNode, type Ref } from "react";
import { Link } from "react-router";
import type { MenuRequest } from "../lib/menu-request";
import { paths } from "../lib/paths";
import { NARROW_QUERY, useMediaQuery } from "../lib/use-media-query";
import { AccountLabel, type ProfileUser } from "./AccountLabel";
import { ModelTrigger } from "./ModelTrigger";

/**
 * Every dropdown in the app (Radix DropdownMenu, non-modal). This module is
 * loaded on demand: each call site renders a same-looking placeholder trigger
 * until it arrives, and a click on that placeholder opens the menu once it has
 * (`defaultOpen`).
 */

export interface MenuEntry {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  /** A nested menu ("Move to project ›"). */
  submenu?: MenuItems;
}
export type MenuItems = readonly (MenuEntry | "separator")[];

function Items({ items }: { items: MenuItems }) {
  return items.map((item, n) => {
    if (item === "separator")
      return <Menu.Separator key={`separator-${String(n)}`} className="menu-separator" />;
    if (item.submenu)
      return (
        <Menu.Sub key={item.label}>
          <Menu.SubTrigger className="menu-item" disabled={item.disabled}>
            {item.icon}
            <span className="grow">{item.label}</span>
            <ChevronRight size={16} className="trail" aria-hidden />
          </Menu.SubTrigger>
          <Menu.Portal>
            <Menu.SubContent className="menu" sideOffset={8} alignOffset={-7} collisionPadding={8}>
              <Items items={item.submenu} />
            </Menu.SubContent>
          </Menu.Portal>
        </Menu.Sub>
      );
    return (
      <Menu.Item
        key={item.label}
        className={`menu-item${item.danger ? " danger" : ""}`}
        disabled={item.disabled}
        onSelect={item.onSelect}
      >
        {item.icon}
        {item.label}
      </Menu.Item>
    );
  });
}

/**
 * Radix focuses the first item only when it saw the opening key press; a lazy
 * menu's press reached its placeholder. A keyboard request focuses it here.
 */
function focusFirstItem(request: MenuRequest) {
  return (content: HTMLElement | null) => {
    if (!content || request !== "keyboard") return;
    requestAnimationFrame(() => {
      if (content.contains(document.activeElement) && document.activeElement !== content) return;
      (
        content.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ??
        content.querySelector<HTMLElement>(
          '[role="menuitem"]:not([data-disabled]), [role="menuitemradio"]:not([data-disabled])',
        )
      )?.focus();
    });
  };
}

/** The "…" on a sidebar row. */
export function RowMenu(props: {
  title: string;
  items: MenuItems;
  defaultOpen: MenuRequest;
  onTriggerFocus: (element: HTMLElement) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Menu.Root
      modal={false}
      defaultOpen={props.defaultOpen !== false}
      onOpenChange={props.onOpenChange}
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
          <Items items={props.items} />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The header's "…": the open chat's actions, then help. */
export function HeaderMenu({
  label,
  items,
  defaultOpen,
  triggerRef,
  onOpen,
}: {
  label: string;
  items: MenuItems;
  defaultOpen: MenuRequest;
  triggerRef: Ref<HTMLButtonElement>;
  onOpen?: () => void;
}) {
  return (
    <Menu.Root
      modal={false}
      defaultOpen={defaultOpen !== false}
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <Menu.Trigger
        ref={triggerRef}
        className="icon-btn title-trigger"
        aria-label={label}
        title="More options"
      >
        <Ellipsis size={20} aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          ref={focusFirstItem(defaultOpen)}
          className="menu wide"
          align="end"
          sideOffset={6}
          collisionPadding={8}
        >
          <Items items={items} />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** A reply's "…" (More actions). */
export function ReplyMenu(props: { items: MenuItems; defaultOpen: MenuRequest }) {
  return (
    <Menu.Root modal={false} defaultOpen={props.defaultOpen !== false}>
      <Menu.Trigger className="icon-btn" aria-label="More actions" title="More actions">
        <Ellipsis size={18} aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          ref={focusFirstItem(props.defaultOpen)}
          className="menu"
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          <Items items={props.items} />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

export interface ModelOption {
  /** The JSON [providerId, modelId] pair, as the composer stores it. */
  value: string;
  label: string;
  /** A muted second line ("Not loaded"). */
  detail?: string;
}

export interface ModelGroup {
  id: string;
  /** Shown as a heading only when there is more than one group. */
  label: string;
  options: ModelOption[];
}

/**
 * The composer's model picker: the current model with a chevron, opening a
 * card of models (name over a muted detail, a check on the chosen one) and,
 * for administrators, "Manage models". Controlled: "/model" opens it too.
 */
export function ModelMenu(props: {
  label: string;
  value: string;
  groups: ModelGroup[];
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: MenuRequest;
  onChange: (value: string) => void;
  manageHref?: string;
}) {
  const groups = props.groups.filter((g) => g.options.length > 0);
  const headed = groups.length > 1;
  const narrow = useMediaQuery(NARROW_QUERY);
  if (narrow) return <ModelSheet {...props} groups={groups} headed={headed} />;
  return (
    <Menu.Root modal={false} open={props.open} onOpenChange={props.onOpenChange}>
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
                    <Menu.ItemIndicator className="check">
                      <Check size={18} aria-hidden />
                    </Menu.ItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.Group>
            ))}
          </Menu.RadioGroup>
          {props.manageHref ? (
            <>
              <Menu.Separator className="menu-separator" />
              <Menu.Item asChild className="menu-item">
                <Link to={props.manageHref}>
                  <SlidersHorizontal size={18} className="muted-icon" aria-hidden />
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

/**
 * Phones (the MobileModelPicker artboard): a bottom sheet with a grab handle,
 * "Model" and Close, then the models. No search field, as requested.
 */
function ModelSheet(props: {
  label: string;
  value: string;
  groups: ModelGroup[];
  headed: boolean;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
  manageHref?: string;
}) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Trigger asChild disabled={props.disabled}>
        <ModelTrigger label={props.label} disabled={props.disabled} />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog model-sheet" aria-describedby={undefined}>
          <span className="sheet-handle" aria-hidden />
          <div className="model-sheet-head">
            <Dialog.Title className="model-sheet-title">Model</Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="Close">
              <X size={20} aria-hidden />
            </Dialog.Close>
          </div>
          {props.groups.map((group) => (
            <div key={group.id} role="listbox" aria-label={props.headed ? group.label : "Models"}>
              {props.headed ? <div className="menu-label">{group.label}</div> : null}
              {group.options.map((option) => {
                const selected = option.value === props.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className="model-option sheet-option"
                    data-model={option.value}
                    onClick={() => {
                      props.onChange(option.value);
                      props.onOpenChange(false);
                    }}
                  >
                    <span className="text">
                      <span className="name">{option.label}</span>
                      {option.detail ? <span className="desc">{option.detail}</span> : null}
                    </span>
                    {selected ? <Check size={18} className="check" aria-hidden /> : null}
                  </button>
                );
              })}
            </div>
          ))}
          {props.manageHref ? (
            <>
              <div className="sheet-separator" role="separator" />
              <Link to={props.manageHref} className="model-option sheet-option manage">
                <SlidersHorizontal size={20} className="muted-icon" aria-hidden />
                Manage models
              </Link>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The account row at the bottom of the sidebar. */
export function AccountMenu(props: {
  user: ProfileUser;
  isAdmin: boolean;
  defaultOpen: MenuRequest;
  /** Settings keeps the current conversation to come back to. */
  settingsState: { background: string };
  onNavigate: () => void;
  onSignOut: () => void;
}) {
  const link = (to: string, label: string, icon: ReactNode) => (
    <Menu.Item asChild className="menu-item">
      <Link to={to} state={props.settingsState} prefetch="render" onClick={props.onNavigate}>
        {icon}
        {label}
      </Link>
    </Menu.Item>
  );
  // As ChatGPT's profile menu: who you are, then Personalization, Profile,
  // Settings, and Log out under a separator.
  return (
    <Menu.Root modal={false} defaultOpen={props.defaultOpen !== false}>
      <Menu.Trigger className="nav-row account-row" aria-label={`Account (${props.user.username})`}>
        <AccountLabel user={props.user} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          ref={focusFirstItem(props.defaultOpen)}
          className="menu account-menu"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={8}
        >
          <div className="menu-profile">
            <AccountLabel user={props.user} />
          </div>
          <Menu.Separator className="menu-separator" />
          {link(paths.settings("memories"), "Personalization", <Sparkles size={20} aria-hidden />)}
          {link(paths.settings("account"), "Profile", <CircleUserRound size={20} aria-hidden />)}
          {link(paths.settings(), "Settings", <Settings size={20} aria-hidden />)}
          {props.isAdmin
            ? link(paths.admin(), "Administration", <Shield size={20} aria-hidden />)
            : null}
          <Items
            items={[
              "separator",
              {
                label: "Log out",
                icon: <LogOut size={20} aria-hidden />,
                onSelect: props.onSignOut,
              },
            ]}
          />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
