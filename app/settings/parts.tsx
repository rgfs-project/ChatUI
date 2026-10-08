import { Check, ChevronDown, ChevronRight } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui";

/*
 * Settings building blocks (design direction B): white cards of 52 px rows
 * split by hairlines; headings and notes sit on the card's outer edge.
 */

/** A card of rows, with an optional heading above and a note below. */
export function Group(props: { children: ReactNode; heading?: ReactNode; note?: ReactNode }) {
  return (
    <section className="settings-group">
      {props.heading ? <h3 className="group-heading">{props.heading}</h3> : null}
      <div className="group">{props.children}</div>
      {props.note ? <p className="group-note">{props.note}</p> : null}
    </section>
  );
}

/** A row: label (and an optional second line) on the left, a control or value on the right. */
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

/** A row that opens a page: label, an optional value, a chevron. */
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
      <span className="row-control">
        {props.value !== undefined ? <span className="row-value">{props.value}</span> : null}
        <ChevronRight size={18} aria-hidden className="chevron" />
      </span>
    </button>
  );
}

/** A row that does something: an icon and a verb. */
export function ActionRow(props: {
  icon: ReactNode;
  label: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`row row-button action-row${props.danger ? " danger" : ""}`}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

/** A text field inside a card: label left, the value typed on the right. */
export function FieldRow(props: ComponentProps<"input"> & { label: string }) {
  const { label, ...rest } = props;
  return (
    <label className="row field-row">
      <span className="field-row-label">{label}</span>
      <input {...rest} />
    </label>
  );
}

/** A longer text inside a card: label above, the text below. */
export function TextAreaRow(props: ComponentProps<"textarea"> & { label: string }) {
  const { label, ...rest } = props;
  return (
    <label className="row textarea-row">
      <span>{label}</span>
      <textarea {...rest} />
    </label>
  );
}

/** A compact menu choosing one value. */
export function Choice<T extends string | number | null>(props: {
  labelledBy: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Shown when the value matches no option. */
  label?: string;
  extra?: ReactNode;
}) {
  const current = props.options.find((o) => o.value === props.value);
  return (
    <Menu>
      <MenuTrigger asChild disabled={props.disabled}>
        <button type="button" className="choice" aria-labelledby={props.labelledBy}>
          <span>{current?.label ?? props.label ?? String(props.value)}</span>
          <ChevronDown size={16} aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        {props.options.map((o) => (
          <MenuItem
            key={String(o.value)}
            icon={
              <Check size={16} aria-hidden className={o.value === props.value ? "" : "invisible"} />
            }
            onSelect={() => {
              props.onChange(o.value);
            }}
          >
            {o.label}
          </MenuItem>
        ))}
        {props.extra}
      </MenuContent>
    </Menu>
  );
}

/**
 * A number chosen from presets, "Default" (null) or "Custom…", which turns
 * the control into a small field. `scale` converts the shown unit to stored.
 */
export function NumberChoice(props: {
  labelledBy: string;
  value: number | null;
  presets: readonly number[];
  format: (stored: number) => string;
  nullLabel: string;
  onChange: (value: number | null) => void;
  scale?: number;
  unit?: string;
  disabled?: boolean;
}) {
  const scale = props.scale ?? 1;
  const [custom, setCustom] = useState(false);
  const [text, setText] = useState("");
  if (custom)
    return (
      <form
        className="custom-number"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(text);
          if (text.trim() !== "" && Number.isFinite(n))
            props.onChange(Math.round(n * scale * 1000) / 1000);
          setCustom(false);
        }}
      >
        <input
          aria-labelledby={props.labelledBy}
          inputMode="decimal"
          autoFocus
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onBlur={(e) => {
            e.currentTarget.form?.requestSubmit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setCustom(false);
          }}
        />
        {props.unit ? <span className="muted">{props.unit}</span> : null}
      </form>
    );
  const options = [
    { value: null as number | null, label: props.nullLabel },
    ...props.presets.map((p) => ({ value: p, label: props.format(p) })),
  ];
  return (
    <Choice<number | null>
      labelledBy={props.labelledBy}
      value={props.value}
      options={options}
      label={props.value === null ? props.nullLabel : props.format(props.value)}
      disabled={props.disabled}
      onChange={props.onChange}
      extra={
        <MenuItem
          icon={<Check size={16} aria-hidden className="invisible" />}
          onSelect={() => {
            setText(props.value === null ? "" : String(props.value / scale));
            setCustom(true);
          }}
        >
          Custom…
        </MenuItem>
      }
    />
  );
}

/** Feedback under a group. */
export function Status(props: { error?: string | null; ok?: string | null }) {
  if (props.error)
    return (
      <p className="group-note error" role="alert">
        {props.error}
      </p>
    );
  if (props.ok)
    return (
      <p className="group-note ok" role="status">
        {props.ok}
      </p>
    );
  return null;
}

/** A page inside a section: the header shows its title and a back button. */
interface SubPage {
  title: string;
  onBack: () => void;
}

export const SubPageContext = createContext<(page: SubPage | null) => void>(() => undefined);

export function useSubPage(page: SubPage | null) {
  const set = useContext(SubPageContext);
  const back = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    back.current = page?.onBack;
  });
  const title = page?.title;
  useEffect(() => {
    set(title === undefined ? null : { title, onBack: () => back.current?.() });
    return () => {
      set(null);
    };
  }, [set, title]);
}

/** A text field's value from a form. */
export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
