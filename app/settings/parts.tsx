import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, type ComponentProps, type ReactNode } from "react";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui";

/** A heading over a group of rows. */
export function GroupHeading(props: { children: ReactNode }) {
  return <h3 className="group-heading">{props.children}</h3>;
}

/** White rounded card holding rows; an optional note below it. */
export function Group(props: { children: ReactNode; note?: ReactNode; heading?: ReactNode }) {
  return (
    <section className="settings-group">
      {props.heading ? <GroupHeading>{props.heading}</GroupHeading> : null}
      <div className="group">{props.children}</div>
      {props.note ? <p className="group-note">{props.note}</p> : null}
    </section>
  );
}

/** A row: label (and a second line) on the left, a control or value on the right. */
export function Row(props: {
  label: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  id?: string;
}) {
  return (
    <div className="row">
      <span className="row-label">
        <span id={props.id}>{props.label}</span>
        {props.hint ? <span className="row-hint">{props.hint}</span> : null}
      </span>
      {props.children !== undefined ? <span className="row-control">{props.children}</span> : null}
    </div>
  );
}

/** A row that opens something (a detail page or a form). */
export function LinkRow(props: {
  label: ReactNode;
  hint?: ReactNode;
  value?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" className="row row-button" onClick={props.onClick}>
      <span className="row-label">
        <span>{props.label}</span>
        {props.hint ? <span className="row-hint">{props.hint}</span> : null}
      </span>
      <span className="row-control muted">
        {props.value}
        <ChevronRight size={18} aria-hidden />
      </span>
    </button>
  );
}

/** A labelled text field. */
export function Field(props: ComponentProps<"input"> & { label: string; hint?: ReactNode }) {
  const generated = useId();
  const { label, hint, id, ...rest } = props;
  const fieldId = id ?? generated;
  return (
    <div className="field">
      <label htmlFor={fieldId}>{label}</label>
      <input id={fieldId} className="input" {...rest} />
      {hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}

export function TextArea(props: ComponentProps<"textarea"> & { label: string; hint?: ReactNode }) {
  const generated = useId();
  const { label, hint, id, ...rest } = props;
  const fieldId = id ?? generated;
  return (
    <div className="field">
      <label htmlFor={fieldId}>{label}</label>
      <textarea id={fieldId} className="input" {...rest} />
      {hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}

/** A compact menu choosing one of a few values. */
export function Choice<T extends string | number>(props: {
  labelledBy: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const current = props.options.find((o) => o.value === props.value);
  return (
    <Menu>
      <MenuTrigger asChild disabled={props.disabled}>
        <button type="button" className="choice" aria-labelledby={props.labelledBy}>
          <span>{current?.label ?? String(props.value)}</span>
          <ChevronDown size={16} aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        {props.options.map((o) => (
          <MenuItem
            key={String(o.value)}
            onSelect={() => {
              props.onChange(o.value);
            }}
          >
            {o.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/** Feedback under a form. */
export function Status(props: { error?: string | null; ok?: string | null }) {
  if (props.error)
    return (
      <p className="error" role="alert">
        {props.error}
      </p>
    );
  if (props.ok)
    return (
      <p className="ok" role="status">
        {props.ok}
      </p>
    );
  return null;
}

/** Empty state inside a section. */
export function Empty(props: { title: string; children?: ReactNode }) {
  return (
    <div className="settings-empty">
      <p className="settings-empty-title">{props.title}</p>
      {props.children ? <p className="muted">{props.children}</p> : null}
    </div>
  );
}

/** A sub-page header inside a section (back to the list). */
export function SubHeader(props: { onBack: () => void; title: string; backLabel: string }) {
  return (
    <div className="sub-header">
      <button type="button" className="link-button" onClick={props.onBack}>
        ‹ {props.backLabel}
      </button>
      <h3>{props.title}</h3>
    </div>
  );
}

/** Numbers typed into a field: empty means "not set". */
export function parseOptionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** A text field's value from a form. */
export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
