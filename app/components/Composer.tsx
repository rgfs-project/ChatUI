import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { ArrowUp, ChevronDown, Square } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { ModelListDto } from "@shared/generations";
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
}) {
  const shell = useShell();
  const client = useQueryClient();
  const modelRef = useRef<HTMLSelectElement>(null);
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
  const canSend = ready && !running && !sending;

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
    if (!content) {
      el?.focus();
      return;
    }
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

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      aria-label="Message composer"
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
      <p
        className="gen-status composer-status"
        role="status"
        aria-live="polite"
        data-testid="status"
      >
        {status ?? ""}
      </p>
      {commandOpen ? (
        <CommandMenu
          commands={shown}
          activeIndex={activeIndex}
          onPick={runCommand}
          onHover={setActiveCommand}
        />
      ) : null}
      <div className="composer-box">
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
