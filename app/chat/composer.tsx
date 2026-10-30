import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Paperclip, Plus, Square } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { useHydrated } from "../lib/hydrated";
import { mark } from "../lib/perf";
import { qk } from "../lib/query/keys";
import { preferencesQuery } from "../lib/query/queries";
import { useRenderProbe } from "../lib/render-probe";
import { MenuItem, MenuLabel, MenuSeparator } from "../ui/menu";
import { useToast } from "../ui/toast";
import { AttachmentChips } from "./attachment-chips";
import { useChat } from "./chat-context";
import { ACCEPT, composerFiles, MAX_FILES_PER_MESSAGE, useComposerFiles } from "./composer-files";
import { DEFAULT_IMAGE_MAX_EDGE } from "./downscale";
import { ModelMenu } from "./model-picker";
import { draftKey, draftStore } from "./drafts";

/** Adds files to a draft's composer and starts uploading them (also used by drag and drop). */
export function useAddFiles(userId: string, key: string): (files: File[]) => void {
  const client = useQueryClient();
  const toast = useToast();
  const preferences = useQuery(preferencesQuery(userId));
  const maxEdge = preferences.data?.imageMaxEdge ?? DEFAULT_IMAGE_MAX_EDGE;
  return useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const refused = composerFiles.add(key, files, {
        imageMaxEdge: maxEdge,
        onUploaded: () => {
          void client.invalidateQueries({ queryKey: qk.attachments(userId) });
        },
      });
      if (refused > 0)
        toast(`A message can carry up to ${String(MAX_FILES_PER_MESSAGE)} files.`, "error");
    },
    [client, key, maxEdge, toast, userId],
  );
}

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
  const files = useComposerFiles(key);
  const addFiles = useAddFiles(userId, key);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const uploading = files.some((f) => f.status === "uploading");
  const failed = files.some((f) => f.status === "error");
  const ready = files.filter((f) => f.status === "ready" && f.attachment !== null);
  // Images and audio need a model with that input (INV-44); the server checks again.
  const selectedModel = selectedPair
    ? groups
        .flatMap((g) => g.models)
        .find((m) => m.providerId === selectedPair[0] && m.id === selectedPair[1])
    : undefined;
  const modalities = selectedModel?.capabilities.inputModalities ?? ["text"];
  const needs = {
    image: files.some((f) => f.kind === "image"),
    audio: files.some((f) => f.kind === "audio"),
  };
  const capabilityProblem =
    needs.image && !modalities.includes("image")
      ? "This model can't view images. Choose a model with vision."
      : needs.audio && !modalities.includes("audio")
        ? "This model can't listen to audio. Choose a model with audio input."
        : null;

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
    if (!el || !hydrated || running || uploading || failed || capabilityProblem) return;
    const raw = el.value;
    const content = raw.trim();
    if (!content && ready.length === 0) return;
    // Cleared synchronously: a second Enter before React re-renders finds nothing to send.
    el.value = "";
    draftStore.set(key, "");
    const taken = composerFiles.take(key);
    sync();
    jumpRef.current?.();
    const ok = await send(
      content,
      ready.flatMap((f) => (f.attachment ? [f.attachment] : [])),
    );
    if (ok) {
      composerFiles.release(taken);
    } else {
      composerFiles.restore(key, taken);
      if (el.value === "") {
        el.value = raw;
        draftStore.set(keyRef.current, raw);
        sync();
      }
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = Array.from(event.clipboardData.files);
    if (pasted.length === 0) return;
    event.preventDefault();
    addFiles(pasted);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  }

  const canSend =
    hydrated &&
    (hasText || ready.length > 0) &&
    selectedPair !== null &&
    !running &&
    !uploading &&
    !failed &&
    capabilityProblem === null;
  // Fully interactive: hydrated, and a server-valid model is known (send can work).
  const interactive = hydrated && selectedPair !== null;
  useEffect(() => {
    if (interactive) mark("chatui:composer-interactive");
  }, [interactive]);

  return (
    <>
      {capabilityProblem ? (
        <p className="composer-warning" role="status" data-testid="capability-warning">
          {capabilityProblem}
        </p>
      ) : null}
      <form
        className={`composer${multiline || files.length > 0 ? " is-multiline" : ""}${files.length > 0 ? " has-files" : ""}`}
        aria-label="Message composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <AttachmentChips draft={key} files={files} />
        <input
          ref={pickerRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          data-testid="file-input"
          onChange={(event) => {
            addFiles(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = "";
          }}
        />
        <div className="composer-start">
          <ModelMenu
            label="Composer options"
            side="top"
            groups={groups}
            needs={needs}
            selected={selectedPair}
            loading={modelsState === "loading"}
            onSelect={(pair) => {
              if (pair) selectModel(pair);
              composerRef.current?.focus();
            }}
            onRefresh={() => {
              void refreshModels();
            }}
            before={
              <>
                <MenuItem
                  icon={<Paperclip size={16} aria-hidden />}
                  onSelect={() => {
                    // Runs inside the menu item's click: a genuine user activation.
                    pickerRef.current?.click();
                  }}
                >
                  Add photos and files
                </MenuItem>
                <MenuSeparator />
                <MenuLabel>Model</MenuLabel>
              </>
            }
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
          onPaste={onPaste}
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
    </>
  );
}
