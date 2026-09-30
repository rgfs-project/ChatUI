import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { ArrowUp, ChevronDown, Plus, Square } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type RefObject } from "react";
import { acceptAttribute } from "@shared/attachment-media";
import type { ModelListDto } from "@shared/generations";
import type { DraftAttachment } from "../lib/attachments";
import { markOnce } from "../lib/perf";
import { fetchers, queryKeys } from "../lib/query";
import { useShell } from "../lib/shell-context";
import {
  COMMAND_MENU_ID,
  CommandMenu,
  commandOptionId,
  commandQuery,
  filterCommands,
  type Command,
} from "./CommandMenu";

// The tray loads with the first attachment (Phase 12): not in the critical chunk.
const AttachmentTray = lazy(() =>
  import("./AttachmentTray").then((m) => ({ default: m.AttachmentTray })),
);

/** Files from a paste or drop (images, audio and text files; the server decides). */
function filesOf(list: FileList | null | undefined): File[] {
  return list ? Array.from(list) : [];
}

/** A `(providerId, modelId)` pair; the server validates it on every send. */
export type ModelChoice = [string, string];

function pairKey(pair: ModelChoice): string {
  return JSON.stringify(pair);
}

type ModelsState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "none-configured" }
  | { kind: "all-unavailable" }
  | { kind: "no-models" }
  | { kind: "ready"; degraded: boolean };

function modelsState(models: UseQueryResult<ModelListDto>): ModelsState {
  const data = models.data;
  if (!data) return models.isError ? { kind: "error" } : { kind: "loading" };
  const groups = data.providers;
  const down = (g: (typeof groups)[number]) =>
    g.provider.status === "unavailable" || g.provider.status === "invalid";
  const count = groups.reduce((n, g) => n + g.models.length, 0);
  if (groups.length === 0) return { kind: "none-configured" };
  if (count === 0) return groups.every(down) ? { kind: "all-unavailable" } : { kind: "no-models" };
  return { kind: "ready", degraded: groups.every(down) };
}

const EMPTY_MESSAGE: Record<Exclude<ModelsState["kind"], "ready" | "loading">, string> = {
  error: "The model list couldn’t be loaded.",
  "none-configured": "No models are available: no model provider is configured yet.",
  "all-unavailable": "All model providers are unavailable right now.",
  "no-models": "No models are available from the configured providers.",
};

/**
 * The composer: a native uncontrolled textarea (survives hydration; contracts
 * §13) in a pill with the model selector and Send/Stop. Sending needs a
 * hydrated page and a server-known model; nothing secondary gates it. The
 * parent decides whether a submission is sent now or queued (while a reply
 * runs). A message that is exactly "/filter" opens the command list instead.
 */
export function Composer({
  userId,
  textareaRef,
  draftKey,
  hydrated,
  inert,
  running,
  sending,
  status,
  models,
  preferred: remembered,
  commands,
  onSubmit,
  onCommand,
  onCommandIntent,
  onCancel,
  attachments = [],
  attachNotice = null,
  onAttach,
  onRemoveAttachment,
}: {
  userId: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  draftKey: string;
  hydrated: boolean;
  inert: boolean;
  running: boolean;
  sending: boolean;
  status: string | null;
  models: UseQueryResult<ModelListDto>;
  preferred: ModelChoice | null;
  commands: readonly Command[];
  onSubmit: (content: string, choice: ModelChoice) => void;
  onCommand: (name: string) => void;
  /** The user started a "/" command (load anything the list needs). */
  onCommandIntent?: () => void;
  onCancel: () => void;
  /** The draft's attachments (Phase 12). */
  attachments?: readonly DraftAttachment[];
  /** Why files were refused before upload (e.g. too many). */
  attachNotice?: string | null;
  onAttach?: (files: File[]) => void;
  onRemoveAttachment?: (localId: string) => void;
}) {
  const shell = useShell();
  const client = useQueryClient();
  const modelRef = useRef<HTMLSelectElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  // "/" commands: the typed filter (null: closed) and the highlighted option.
  const [slash, setSlash] = useState<string | null>(null);
  const [activeCommand, setActiveCommand] = useState(0);
  const state = modelsState(models);
  const groups = models.data?.providers ?? [];
  const allModels = groups.flatMap((g) => g.models);
  const preferred =
    (remembered &&
      allModels.find((m) => m.providerId === remembered[0] && m.id === remembered[1])) ??
    allModels.find(
      (m) =>
        m.providerId === models.data?.defaultModel?.providerId &&
        m.id === models.data.defaultModel.modelId,
    ) ??
    allModels.find((m) => m.status === "loaded") ??
    allModels[0];
  const selectedValue =
    selected ?? (preferred ? pairKey([preferred.providerId, preferred.id]) : "");
  const ready = hydrated && state.kind === "ready" && !inert;
  // Attachments: sending waits for uploads; a model must read each modality (INV-44).
  const live = attachments.filter((a) => a.status !== "error");
  const uploading = live.some((a) => a.status === "uploading");
  const hasReady = live.some((a) => a.status === "ready");
  let selectedModel: (typeof allModels)[number] | undefined;
  try {
    const [providerId, modelId] = JSON.parse(selectedValue || "null") as ModelChoice;
    selectedModel = allModels.find((m) => m.providerId === providerId && m.id === modelId);
  } catch {
    selectedModel = undefined;
  }
  const accepts = selectedModel?.capabilities.inputModalities ?? [];
  const missing = (["image", "audio"] as const).filter(
    (kind) => selectedModel && live.some((a) => a.kind === kind) && !accepts.includes(kind),
  );
  const capabilityWarning =
    missing.length > 0 && selectedModel
      ? `${selectedModel.id} can't read ${missing.map((k) => (k === "image" ? "images" : "audio")).join(" or ")}. Choose another model or remove the attachment.`
      : null;
  const canSend = ready && !running && !sending && !uploading && capabilityWarning === null;

  const shown = slash === null ? [] : filterCommands(commands, slash);
  const commandOpen = shown.length > 0;
  const activeIndex = Math.min(activeCommand, shown.length - 1);
  const active = shown[activeIndex];

  // Send controls are usable (hydrated, a server-known model): ComposerTTI ends.
  const interactive = hydrated && state.kind === "ready" && !inert;
  useEffect(() => {
    if (interactive) markOnce("chatui:composer-interactive");
  }, [interactive]);

  function refreshModels() {
    setRefreshing(true);
    void fetchers
      .models(true)
      .then((data) => {
        client.setQueryData(queryKeys.models(userId), data);
      })
      .catch(() => undefined)
      .finally(() => {
        setRefreshing(false);
      });
  }

  function clear() {
    const el = textareaRef.current;
    if (el) el.value = "";
    shell.clearDraft(draftKey);
    setHasDraft(false);
    setSlash(null);
  }

  function submit() {
    const el = textareaRef.current;
    const content = el?.value.trim() ?? "";
    if (!content && !hasReady) {
      el?.focus();
      return;
    }
    if (uploading || capabilityWarning) return;
    let choice: ModelChoice;
    try {
      choice = JSON.parse(selectedValue) as ModelChoice;
    } catch {
      return;
    }
    if (ready) onSubmit(content, choice);
  }

  function runCommand(command: Command) {
    if (command.kind === "skill") {
      // A skill applies to the message: insert "/name " and keep typing.
      const el = textareaRef.current;
      if (el) {
        el.value = `/${command.name} `;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
      return;
    }
    clear();
    if (command.name !== "model") {
      onCommand(command.name);
      return;
    }
    const select = modelRef.current;
    select?.focus();
    try {
      select?.showPicker();
    } catch {
      // Not supported or not allowed here: focus is enough.
    }
  }

  const notice =
    state.kind === "ready"
      ? state.degraded
        ? "Model providers are unreachable; the list may be out of date."
        : null
      : state.kind === "loading"
        ? null
        : EMPTY_MESSAGE[state.kind];

  const attachable = hydrated && !inert && onAttach !== undefined;
  return (
    <form
      className={`composer${dragging ? " dragging" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      aria-label="Message composer"
      onDragOver={(event) => {
        if (!attachable || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        setDragging(false);
        const files = filesOf(event.dataTransfer.files);
        if (!attachable || files.length === 0) return;
        event.preventDefault();
        onAttach(files);
      }}
    >
      {notice ? (
        <div className="models-notice" role="status" data-testid="models-notice">
          <span>{notice}</span>
          <button
            type="button"
            className="link-button"
            onClick={refreshModels}
            disabled={!hydrated || refreshing}
          >
            {refreshing ? "Checking…" : "Retry"}
          </button>
        </div>
      ) : null}
      {capabilityWarning ? (
        <div className="models-notice" role="alert" data-testid="capability-warning">
          <span>{capabilityWarning}</span>
        </div>
      ) : null}
      <p
        className="gen-status composer-status"
        role="status"
        aria-live="polite"
        data-testid="status"
      >
        {status ?? attachNotice ?? ""}
      </p>
      {commandOpen ? (
        <CommandMenu
          commands={shown}
          activeIndex={activeIndex}
          onPick={runCommand}
          onHover={setActiveCommand}
        />
      ) : null}
      <div className={`composer-box${attachments.length > 0 ? " has-attachments" : ""}`}>
        {attachments.length > 0 && onRemoveAttachment ? (
          <Suspense fallback={null}>
            <AttachmentTray items={attachments} onRemove={onRemoveAttachment} />
          </Suspense>
        ) : null}
        <button
          type="button"
          className="icon-btn attach-btn"
          aria-label="Attach files"
          title="Attach images, audio or text files"
          disabled={!attachable}
          // The picker opens only from this genuine user activation.
          onClick={() => fileRef.current?.click()}
        >
          <Plus size={20} aria-hidden />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          accept={acceptAttribute()}
          data-testid="file-input"
          onChange={(event) => {
            const files = filesOf(event.currentTarget.files);
            event.currentTarget.value = "";
            if (files.length > 0) onAttach?.(files);
          }}
        />
        <label htmlFor="message" className="visually-hidden">
          Message
        </label>
        <textarea
          id="message"
          name="message"
          ref={textareaRef}
          rows={1}
          placeholder={running ? "Queue a message" : "Ask anything"}
          aria-autocomplete="list"
          aria-controls={commandOpen ? COMMAND_MENU_ID : undefined}
          aria-activedescendant={commandOpen && active ? commandOptionId(active.name) : undefined}
          onInput={(event) => {
            const value = event.currentTarget.value;
            shell.setDraft(draftKey, value);
            setHasDraft(value.trim() !== "");
            const query = commandQuery(value);
            if (query !== null) onCommandIntent?.();
            if (query !== slash) setActiveCommand(0);
            setSlash(query);
          }}
          onPaste={(event) => {
            const files = filesOf(event.clipboardData.files);
            if (!attachable || files.length === 0) return;
            // Pasted files attach; pasted text (if any) still goes into the box.
            if (!event.clipboardData.types.includes("text/plain")) event.preventDefault();
            onAttach(files);
          }}
          onKeyDown={(event) => {
            if (commandOpen) {
              const n = shown.length;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : n - 1;
                setActiveCommand((activeIndex + step) % n);
                return;
              }
              if ((event.key === "Enter" || event.key === "Tab") && active) {
                event.preventDefault();
                runCommand(active);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setSlash(null);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <span className="model-picker">
          <label htmlFor="model" className="visually-hidden">
            Model
          </label>
          <select
            id="model"
            name="model"
            ref={modelRef}
            className="model-select"
            value={selectedValue}
            disabled={allModels.length === 0 || inert}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setSelected(value);
              try {
                shell.setModel(draftKey, JSON.parse(value) as ModelChoice);
              } catch {
                // placeholder option
              }
            }}
          >
            {allModels.length === 0 ? (
              <option value="">
                {state.kind === "loading" ? "Loading models…" : "No models available"}
              </option>
            ) : null}
            {groups.map((group) => (
              <optgroup
                key={group.provider.id}
                label={`${group.provider.name}${
                  group.provider.status === "unavailable"
                    ? " (unavailable)"
                    : group.stale
                      ? " (list may be out of date)"
                      : ""
                }`}
              >
                {group.models.map((model) => (
                  <option key={model.id} value={pairKey([model.providerId, model.id])}>
                    {model.id}
                    {model.status === "unloaded" ? " (not loaded)" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <ChevronDown size={15} className="model-chevron" aria-hidden />
        </span>
        {running && hasDraft ? (
          <button
            type="submit"
            className="send-btn secondary-send"
            aria-label="Queue message"
            title="Queue message (sent when the reply finishes)"
            disabled={!ready}
          >
            <ArrowUp size={18} strokeWidth={2.25} aria-hidden />
          </button>
        ) : null}
        {running ? (
          <button
            type="button"
            className="send-btn"
            aria-label="Stop generating"
            title="Stop generating"
            onClick={onCancel}
            disabled={!hydrated}
          >
            <Square size={13} fill="currentColor" aria-hidden />
          </button>
        ) : (
          <button
            type="submit"
            className="send-btn"
            aria-label="Send"
            title="Send (Enter) · New line (Shift+Enter)"
            disabled={!canSend}
          >
            <ArrowUp size={18} strokeWidth={2.25} aria-hidden />
          </button>
        )}
      </div>
    </form>
  );
}
