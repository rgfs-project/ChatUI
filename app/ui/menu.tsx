import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import {
  createContext,
  useContext,
  useRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";

/**
 * A dialog opened from a menu item must return focus to the menu's trigger
 * when it closes (the item itself is gone by then). Menu items record their
 * trigger; dialogs opened right after claim it (INV-47).
 */
let opener: { element: HTMLElement; at: number } | null = null;
const OPENER_TTL_MS = 1_000;

export function claimMenuOpener(): HTMLElement | null {
  const claimed = opener && Date.now() - opener.at < OPENER_TTL_MS ? opener.element : null;
  opener = null;
  return claimed;
}

const TriggerContext = createContext<RefObject<HTMLElement | null> | null>(null);

/**
 * Menus on Radix DropdownMenu: roving focus, typeahead, Escape, focus return
 * to the trigger, collision-aware portal positioning (INV-47).
 */
export function Menu({
  trigger,
  children,
  align = "start",
  side = "bottom",
  label,
  contentClassName,
  onOpenChange,
}: {
  trigger: ReactElement;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  /** Accessible name of the menu itself. */
  label: string;
  contentClassName?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const triggerRef = useRef<HTMLElement | null>(null);
  return (
    <Dropdown.Root modal={false} {...(onOpenChange ? { onOpenChange } : {})}>
      <Dropdown.Trigger asChild ref={triggerRef as RefObject<HTMLButtonElement | null>}>
        {trigger}
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          className={`menu${contentClassName ? ` ${contentClassName}` : ""}`}
          align={align}
          side={side}
          sideOffset={4}
          collisionPadding={8}
          aria-label={label}
          loop
        >
          <TriggerContext.Provider value={triggerRef}>{children}</TriggerContext.Provider>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

export function MenuItem({
  icon,
  children,
  onSelect,
  danger,
  disabled,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  const triggerRef = useContext(TriggerContext);
  return (
    <Dropdown.Item
      className={`menu-item${danger ? " menu-item-danger" : ""}`}
      onSelect={() => {
        if (triggerRef?.current) opener = { element: triggerRef.current, at: Date.now() };
        onSelect();
      }}
      {...(disabled ? { disabled } : {})}
    >
      {icon ? <span className="menu-icon">{icon}</span> : null}
      <span className="menu-text">{children}</span>
    </Dropdown.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <Dropdown.Label className="menu-label">{children}</Dropdown.Label>;
}

export function MenuSeparator() {
  return <Dropdown.Separator className="menu-separator" />;
}

export function MenuRadioGroup({
  value,
  onValueChange,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <Dropdown.RadioGroup value={value} onValueChange={onValueChange}>
      {children}
    </Dropdown.RadioGroup>
  );
}

export function MenuRadioItem({
  value,
  children,
  detail,
  disabled,
}: {
  value: string;
  children: ReactNode;
  detail?: string;
  disabled?: boolean;
}) {
  return (
    <Dropdown.RadioItem
      className="menu-item menu-radio"
      value={value}
      {...(disabled ? { disabled } : {})}
    >
      <span className="menu-text">
        {children}
        {detail ? <span className="menu-detail">{detail}</span> : null}
      </span>
      <Dropdown.ItemIndicator className="menu-check">
        <Check size={16} aria-hidden />
      </Dropdown.ItemIndicator>
    </Dropdown.RadioItem>
  );
}

export function MenuGroup({ children }: { children: ReactNode }) {
  return <Dropdown.Group>{children}</Dropdown.Group>;
}
