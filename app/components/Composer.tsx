import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { RefreshCw, Send, Square } from "lucide-react";
import { useState, type RefObject } from "react";
import type { ModelListDto } from "@shared/generations";
import { fetchers, queryKeys } from "../lib/query";
import { useShell } from "../lib/shell-context";

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
 * §13), the model selector and Send/Stop. Sending needs a hydrated page and a
 * server-known model; neither the sidebar nor anything secondary gates it.
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
  onSend,
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
  onSend: (content: string, choice: ModelChoice) => void;
  onCancel: () => void;
}) {
  const shell = useShell();
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const state = modelsState(models);
  const groups = models.data?.providers ?? [];
  const allModels = groups.flatMap((g) => g.models);
  const preferred =
    (remembered &&
      allModels.find((m) => m.providerId === remembered[0] && m.id === remembered[1])) ??
    allModels.find((m) => m.status === "loaded") ??
    allModels[0];
  const selectedValue =
    selected ?? (preferred ? pairKey([preferred.providerId, preferred.id]) : "");
  const canSend = hydrated && state.kind === "ready" && !running && !sending && !inert;

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
    if (canSend) onSend(content, choice);
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
    <>
      {notice ? (
        <div className="models-notice" role="status" data-testid="models-notice">
          <span>{notice}</span>
          <button
            type="button"
            className="secondary"
            onClick={refreshModels}
            disabled={!hydrated || refreshing}
          >
            <RefreshCw size={14} aria-hidden /> {refreshing ? "Checking…" : "Retry"}
          </button>
        </div>
      ) : null}
      <p className="gen-status" role="status" aria-live="polite" data-testid="status">
        {status ?? ""}
      </p>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        aria-label="Message composer"
      >
        <label htmlFor="message" className="visually-hidden">
          Message
        </label>
        <textarea
          id="message"
          name="message"
          ref={textareaRef}
          rows={3}
          placeholder="Ask anything…"
          onInput={(event) => {
            shell.setDraft(draftKey, event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-actions">
          <label htmlFor="model" className="visually-hidden">
            Model
          </label>
          <select
            id="model"
            name="model"
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
          <span className="hint">
            {hydrated ? "Enter to send, Shift+Enter for a new line" : "Loading…"}
          </span>
          {running ? (
            <button type="button" className="secondary" onClick={onCancel} disabled={!hydrated}>
              <Square size={14} aria-hidden /> Stop generating
            </button>
          ) : (
            <button type="submit" disabled={!canSend}>
              <Send size={14} aria-hidden /> Send
            </button>
          )}
        </div>
      </form>
    </>
  );
}
