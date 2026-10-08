import * as RadixDialog from "@radix-ui/react-dialog";
import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

/** A centered dialog: title, optional description, body, actions on the right. */
export function Dialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Hide the title visually (it still names the dialog). */
  hideTitle?: boolean;
}) {
  return (
    <RadixDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="scrim" />
        <RadixDialog.Content
          className={`dialog ${props.className ?? ""}`}
          {...(props.description ? {} : { "aria-describedby": undefined })}
        >
          <RadixDialog.Title className={props.hideTitle ? "sr-only" : "dialog-title"}>
            {props.title}
          </RadixDialog.Title>
          {props.description ? (
            <RadixDialog.Description className="dialog-description">
              {props.description}
            </RadixDialog.Description>
          ) : null}
          {props.children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;

/** A yes/no question; the confirm action can be destructive. */
export function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirm: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.title}
      description={props.description}
    >
      {props.error ? (
        <p className="error" role="alert">
          {props.error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <DialogClose asChild>
          <button type="button" className="button">
            Cancel
          </button>
        </DialogClose>
        <button
          type="button"
          className={`button ${props.danger ? "danger" : "primary"}`}
          disabled={props.busy}
          onClick={props.onConfirm}
        >
          {props.confirm}
        </button>
      </div>
    </Dialog>
  );
}

/** Menus are non-modal: the page behind stays in the accessibility tree. */
export function Menu(props: ComponentProps<typeof RadixMenu.Root>) {
  return <RadixMenu.Root modal={false} {...props} />;
}
export const MenuTrigger = RadixMenu.Trigger;

export function MenuContent(props: ComponentProps<typeof RadixMenu.Content>) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        sideOffset={6}
        collisionPadding={8}
        {...props}
        className={`menu ${props.className ?? ""}`}
      />
    </RadixMenu.Portal>
  );
}

export function MenuItem(
  props: ComponentProps<typeof RadixMenu.Item> & {
    icon?: ReactNode;
    hint?: ReactNode;
    danger?: boolean;
  },
) {
  const { icon, hint, danger, children, className, ...rest } = props;
  return (
    <RadixMenu.Item {...rest} className={`menu-item${danger ? " danger" : ""} ${className ?? ""}`}>
      {icon}
      <span className="menu-text">
        <span>{children}</span>
        {hint ? <span className="menu-hint">{hint}</span> : null}
      </span>
    </RadixMenu.Item>
  );
}

export const MenuLabel = (props: ComponentProps<typeof RadixMenu.Label>) => (
  <RadixMenu.Label {...props} className="menu-label" />
);
export const MenuSeparator = () => <RadixMenu.Separator className="menu-separator" />;

/** A square icon button with an accessible name. */
export function IconButton(
  props: ComponentProps<"button"> & { label: string; children: ReactNode },
) {
  const { label, className, children, ...rest } = props;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={`icon-button ${className ?? ""}`}
    >
      {children}
    </button>
  );
}

export function Switch(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      className="switch"
      onClick={() => {
        props.onChange(!props.checked);
      }}
    >
      <span />
    </button>
  );
}

export function CloseButton(props: { onClick: () => void; label?: string }) {
  return (
    <IconButton label={props.label ?? "Close"} onClick={props.onClick} className="muted-icon">
      <X size={18} aria-hidden />
    </IconButton>
  );
}
