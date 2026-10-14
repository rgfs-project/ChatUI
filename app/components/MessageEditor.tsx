import { useEffect, useRef } from "react";

/**
 * Editing a sent message in place (loaded on first use). "Send" saves it and
 * gets a new reply. Escape cancels, Ctrl/⌘+Enter sends.
 */
export function MessageEditor({
  initial,
  busy,
  onCancel,
  onSave,
}: {
  initial: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (content: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => {
    const value = ref.current?.value.trim() ?? "";
    if (value !== "") onSave(value);
  };
  return (
    <form
      className="message-editor"
      aria-label="Edit message"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor="edit-message" className="visually-hidden">
        Message
      </label>
      <textarea
        id="edit-message"
        ref={ref}
        defaultValue={initial}
        rows={3}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="message-editor-actions">
        <button type="button" className="btn sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn sm primary"
          type="submit"
          disabled={busy}
          title="Save and get a new reply (Ctrl+Enter)"
        >
          Send
        </button>
      </div>
    </form>
  );
}
