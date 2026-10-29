import { ChevronLeft, PenLine } from "lucide-react";
import { useState } from "react";
import { useChat } from "./chat-context";

/** Prompt starters: they only fill the composer; nothing is sent. */
const WRITE_OR_EDIT = [
  "Help me write a polite follow-up email",
  "Proofread this paragraph and suggest fixes",
  "Turn these notes into a short summary",
  "Rewrite this to sound more confident",
];

export function Suggestions() {
  const { composerRef, setHasDraft } = useChat();
  const [open, setOpen] = useState(false);

  function fill(text: string) {
    const el = composerRef.current;
    if (!el) return;
    el.value = `${text}: `;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    setHasDraft(true);
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

  return (
    <div className="suggestions" data-testid="suggestions">
      {open ? (
        <>
          <button
            type="button"
            className="suggestion is-back"
            onClick={() => {
              setOpen(false);
            }}
          >
            <ChevronLeft size={18} aria-hidden />
            <span>Write or edit</span>
          </button>
          {WRITE_OR_EDIT.map((text) => (
            <button
              key={text}
              type="button"
              className="suggestion"
              onClick={() => {
                fill(text);
              }}
            >
              <span>{text}</span>
            </button>
          ))}
        </>
      ) : (
        <button
          type="button"
          className="suggestion"
          aria-expanded={false}
          onClick={() => {
            setOpen(true);
          }}
        >
          <PenLine size={18} aria-hidden />
          <span>Write or edit</span>
        </button>
      )}
    </div>
  );
}
