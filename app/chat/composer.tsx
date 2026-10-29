import { ArrowUp, Plus, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useHydrated } from "../lib/hydrated";
import { useRenderProbe } from "../lib/render-probe";
import { MenuLabel } from "../ui/menu";
import { useChat } from "./chat-context";
import { ModelMenu } from "./model-picker";
import { draftKey, draftStore } from "./drafts";

/** Single-row height of the textarea (26px line + 10px padding). */
const SINGLE_ROW_PX = 36;
const MAX_HEIGHT_PX = 216;

/**
 * Native textarea composer (contracts §13). Uncontrolled, so text typed before
 * hydration survives it (INV-56); Send works only after hydration.
 */
export function Composer() {
  useRenderProbe("Composer");
  const {
    userId,
    conversationId,
    composerRef,
    jumpRef,
    send,
    cancel,
    running,
    selectedPair,
    selectModel,
    groups,
    modelsState,
    refreshModels,
    setHasDraft,
  } = useChat();
  const hydrated = useHydrated();
  const [hasText, setHasText] = useState(false);
  const [multiline, setMultiline] = useState(false);
  const key = draftKey(userId, conversationId);
  const keyRef = useRef(key);

  const sync = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    const text = el.value.trim() !== "";
    setHasText(text);
    setHasDraft(text);
    el.style.height = "auto";
    el.style.height = `${String(Math.min(el.scrollHeight, MAX_HEIGHT_PX))}px`;
    // Grows to two rows on a newline or overflow; returns to one when cleared.
    setMultiline((was) =>
      el.value === ""
        ? false
        : was || el.value.includes("\n") || el.scrollHeight > SINGLE_ROW_PX + 4,
    );
  }, [composerRef, setHasDraft]);

  // Each conversation keeps its own draft in tab memory (INV-53).
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    if (keyRef.current !== key) {
      draftStore.set(keyRef.current, el.value);
      el.value = draftStore.get(key);
      keyRef.current = key;
    } else if (el.value === "") {
      el.value = draftStore.get(key);
    }
    sync();
  }, [composerRef, key, sync]);

  async function submit() {
    const el = composerRef.current;
    if (!el || !hydrated || running) return;
    const raw = el.value;
    const content = raw.trim();
    if (!content) return;
    // Cleared synchronously: a second Enter before React re-renders finds nothing to send.
    el.value = "";
    draftStore.set(key, "");
    sync();
    jumpRef.current?.();
    const ok = await send(content);
    if (!ok && el.value === "") {
      el.value = raw;
      draftStore.set(keyRef.current, raw);
      sync();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  }

  const canSend = hydrated && hasText && selectedPair !== null && !running;

  return (
    <form
      className={`composer${multiline ? " is-multiline" : ""}`}
      aria-label="Message composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="composer-start">
        <ModelMenu
          label="Composer options"
          side="top"
          groups={groups}
          selected={selectedPair}
          loading={modelsState === "loading"}
          onSelect={(pair) => {
            if (pair) selectModel(pair);
            composerRef.current?.focus();
          }}
          onRefresh={() => {
            void refreshModels();
          }}
          before={<MenuLabel>Model</MenuLabel>}
          trigger={
            <button
              type="button"
              className="icon-button composer-plus"
              aria-label="Composer options"
              data-testid="composer-menu"
            >
              <Plus size={20} aria-hidden />
            </button>
          }
        />
      </div>
      <textarea
        id="message"
        name="message"
        ref={composerRef}
        rows={1}
        placeholder="Ask anything"
        aria-label="Message"
        className="selectable"
        onInput={() => {
          draftStore.set(keyRef.current, composerRef.current?.value ?? "");
          sync();
        }}
        onKeyDown={onKeyDown}
      />
      <div className="composer-actions">
        {running ? (
          <button
            type="button"
            className="send-button is-stop"
            aria-label="Stop generating"
            onClick={() => {
              void cancel();
            }}
          >
            <Square size={14} fill="currentColor" aria-hidden />
          </button>
        ) : (
          <button type="submit" className="send-button" aria-label="Send" disabled={!canSend}>
            <ArrowUp size={20} aria-hidden />
          </button>
        )}
      </div>
    </form>
  );
}
