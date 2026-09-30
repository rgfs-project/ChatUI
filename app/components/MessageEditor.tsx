import { useEffect, useRef } from "react";
import "./operations.css";

/**
 * Inline editor for a user message (Phase 13a, loaded on first use). "Send"
 * is edit then regenerate (contracts §4.2); "Save" only edits, leaving the
 * turn unanswered. Escape cancels; Ctrl/⌘+Enter sends.
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
  onSave: (content: string, regenerate: boolean) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = (regenerate: boolean) => {
    const value = ref.current?.value.trim() ?? "";
    if (value !== "") onSave(value, regenerate);
  };
  return (
    <form
      className="message-editor"
      aria-label="Edit message"
      onSubmit={(event) => {
        event.preventDefault();
        submit(true);
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
            submit(true);
          }
        }}
      />
      <div className="message-editor-actions">
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            submit(false);
          }}
          disabled={busy}
          title="Save the edit without a new reply"
        >
          Save
        </button>
        <button type="submit" disabled={busy} title="Save and get a new reply (Ctrl+Enter)">
          Send
        </button>
      </div>
      <p className="message-editor-note">Later messages in this chat will be removed.</p>
    </form>
  );
}
