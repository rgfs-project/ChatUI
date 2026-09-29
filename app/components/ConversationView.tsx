import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, Send, Square } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type SyntheticEvent } from "react";
import { useNavigate } from "react-router";
import type { ConversationDto } from "@shared/conversations";
import {
  isTerminalState,
  type GenerationState,
  type TerminalState,
} from "@shared/generation-state";
import type {
  GenerationError,
  GenerationSnapshot,
  ModelListDto,
  StartGenerationResponse,
} from "@shared/generations";
import { AccountChangedError } from "../lib/api";
import { paths } from "../lib/paths";
import { ApiError, apiJson, fetchers, queryKeys } from "../lib/query";
import { NEW_DRAFT, useShell } from "../lib/shell-context";
import { useScrollPin } from "../lib/use-scroll-pin";
import { ConfirmDialog } from "./Dialogs";
import { Markdown } from "./Markdown";
import { Message } from "./Message";

/** Resends of an unresolved send with the same operation key (contracts §4.1). */
const SEND_RETRIES = 3;

const noopSubscribe = () => () => undefined;
function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

interface Live {
  generationId: string;
  assistantMessageId: string;
  state: GenerationState;
  content: string;
  reasoning: string;
  error: GenerationError | null;
}

const STATE_LABEL: Record<GenerationState, string> = {
  pending: "Waiting for the model…",
  streaming: "Generating…",
  completed: "Completed",
  cancelled: "Stopped",
  failed: "Failed",
  timed_out: "Timed out",
};

function pairKey(pair: [string, string]): string {
  return JSON.stringify(pair);
}

/**
 * One conversation (or the /chat/new draft). Server-owned state only: the
 * transcript comes from the conversation query, the running reply from the
 * generation's SSE stream (replay/resync aware), reconciled by server ids.
 * Browser lifecycle events never cancel a generation.
 */
export function ConversationView(props: {
  userId: string;
  conversationId?: string | undefined;
  inert?: boolean;
  /** Server-side load error (so malformed/missing states render before JS). */
  initialError?: { status: number; code: string } | null;
}) {
  const { userId, conversationId } = props;
  const hydrated = useHydrated();
  const navigate = useNavigate();
  const client = useQueryClient();
  const shell = useShell();
  const draftKey = conversationId ?? NEW_DRAFT;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const conversationQuery = useQuery({
    queryKey: queryKeys.conversation(userId, conversationId ?? ""),
    queryFn: () => fetchers.conversation(conversationId ?? ""),
    enabled: conversationId !== undefined && !props.initialError,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
  });
  const modelsQuery = useQuery({
    queryKey: queryKeys.models(userId),
    queryFn: () => fetchers.models(),
  });
  const conversation: ConversationDto | undefined = conversationQuery.data;
  const loadError =
    conversationQuery.error instanceof ApiError
      ? conversationQuery.error
      : conversationQuery.data === undefined && props.initialError
        ? new ApiError(props.initialError.status, props.initialError.code, "")
        : null;

  // The running generation: the one we started here, else the server's view.
  const serverActive = conversation?.activeGeneration?.generationId ?? null;
  const observedId = live && !isTerminalState(live.state) ? live.generationId : serverActive;

  useEffect(() => {
    if (!observedId || props.inert) return;
    const source = new EventSource(`/api/generations/${observedId}/stream`);
    const onFullState = (event: MessageEvent<string>) => {
      const s = JSON.parse(event.data) as GenerationSnapshot;
      setLive({
        generationId: s.generationId,
        assistantMessageId: s.assistantMessageId,
        state: s.state,
        content: s.content,
        reasoning: s.reasoning,
        error: s.error,
      });
      if (isTerminalState(s.state)) source.close();
    };
    // snapshot (fresh observer) and resync (cursor outside the replay window)
    // both carry the full state; deltas then continue exactly (INV-20).
    source.addEventListener("snapshot", onFullState);
    source.addEventListener("resync", onFullState);
    source.addEventListener("state", (event: MessageEvent<string>) => {
      const { state } = JSON.parse(event.data) as { state: GenerationState };
      setLive((v) => (v?.generationId === observedId ? { ...v, state } : v));
    });
    source.addEventListener("delta", (event: MessageEvent<string>) => {
      const delta = JSON.parse(event.data) as { content?: string; reasoning?: string };
      setLive((v) =>
        v?.generationId === observedId
          ? {
              ...v,
              content: v.content + (delta.content ?? ""),
              reasoning: v.reasoning + (delta.reasoning ?? ""),
            }
          : v,
      );
    });
    source.addEventListener("terminal", (event: MessageEvent<string>) => {
      const t = JSON.parse(event.data) as { state: TerminalState; error: GenerationError | null };
      setLive((v) =>
        v?.generationId === observedId ? { ...v, state: t.state, error: t.error } : v,
      );
      source.close();
      // The reply is stored now: refresh the canonical transcript and list.
      void client.invalidateQueries({
        queryKey: queryKeys.conversation(userId, conversationId ?? ""),
      });
      void client.invalidateQueries({ queryKey: queryKeys.conversations(userId) });
    });
    return () => {
      source.close();
    };
  }, [observedId, props.inert, client, userId, conversationId]);

  // Drafts live in tab memory, keyed by conversation, and survive navigation.
  useEffect(() => {
    const el = textareaRef.current;
    if (el?.value === "") el.value = shell.getDraft(draftKey);
  }, [draftKey, shell]);

  // Keep the live reply on screen until the stored copy is in the transcript.
  const storedIds = new Set(conversation?.messages.map((m) => m.id));
  const showLive =
    live !== null && (!isTerminalState(live.state) || !storedIds.has(live.assistantMessageId));
  const running = observedId !== null;

  const groups = modelsQuery.data?.providers ?? [];
  const allModels = groups.flatMap((g) => g.models);
  const lastReply = [...(conversation?.messages ?? [])]
    .reverse()
    .find((m) => m.role === "assistant");
  const remembered = shell.getModel(draftKey);
  const preferred =
    (remembered &&
      allModels.find((m) => m.providerId === remembered[0] && m.id === remembered[1])) ??
    allModels.find((m) => m.providerId === lastReply?.provider && m.id === lastReply.model) ??
    allModels.find((m) => m.status === "loaded") ??
    allModels[0];
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const selectedValue =
    selected ?? (preferred ? pairKey([preferred.providerId, preferred.id]) : "");

  // Anything that changes the transcript's height: stored messages, the live
  // reply appearing, its state line and its growing text.
  const contentVersion = [
    conversation?.messages.length ?? 0,
    showLive ? `${live.generationId}:${live.state}:${live.error ? "e" : ""}` : "-",
    live?.content.length ?? 0,
    live?.reasoning.length ?? 0,
  ].join("|");
  const {
    ref: transcriptRef,
    handlers: scrollHandlers,
    showJump,
    jumpToLatest,
  } = useScrollPin<HTMLDivElement>(contentVersion);

  async function send(event?: SyntheticEvent) {
    event?.preventDefault();
    const content = textareaRef.current?.value.trim() ?? "";
    if (!content) {
      textareaRef.current?.focus();
      return;
    }
    let pair: [string, string];
    try {
      pair = JSON.parse(selectedValue) as [string, string];
    } catch {
      setStatus("Choose a model first.");
      return;
    }
    if (running || busy) return;
    setBusy(true);
    setStatus("Sending…");
    const body = JSON.stringify({
      ...(conversationId ? { conversationId } : {}),
      providerId: pair[0],
      model: pair[1],
      content,
      operationKey: crypto.randomUUID(),
      operationIssuedAt: new Date().toISOString(),
    });
    try {
      for (let attempt = 0; attempt <= SEND_RETRIES; attempt++) {
        try {
          const started = await apiJson<StartGenerationResponse>("/api/generations", {
            method: "POST",
            body,
          });
          if (textareaRef.current) textareaRef.current.value = "";
          shell.clearDraft(draftKey);
          shell.setModel(started.conversationId, pair);
          setStatus(null);
          setLive({
            generationId: started.generationId,
            assistantMessageId: started.assistantMessageId,
            state: "pending",
            content: "",
            reasoning: "",
            error: null,
          });
          void client.invalidateQueries({ queryKey: queryKeys.conversations(userId) });
          if (started.conversationId !== conversationId) {
            // The draft becomes a real conversation: replace the draft URL so
            // Back does not resurrect the empty draft (INV-53).
            await navigate(paths.chat(started.conversationId), {
              replace: true,
              state: { live: started },
            });
          } else {
            await client.invalidateQueries({
              queryKey: queryKeys.conversation(userId, conversationId),
            });
          }
          return;
        } catch (error) {
          if (error instanceof AccountChangedError) return; // discarded, never re-sent
          // A contract error other than INTERNAL means rejected: nothing was saved.
          if (error instanceof ApiError && error.code && error.code !== "INTERNAL") {
            setStatus(error.message);
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
      }
      setStatus(
        "The outcome of this send is unknown. Check the conversation, then send again if needed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!observedId) return;
    await apiJson(`/api/generations/${observedId}/cancel`, { method: "POST" }).catch(
      () => undefined,
    );
  }

  async function deleteMalformed() {
    if (!conversationId) return;
    await apiJson(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
    }).catch(() => undefined);
    void client.invalidateQueries({ queryKey: queryKeys.conversations(userId) });
    await navigate(paths.newChat(), { replace: true });
  }

  if (loadError?.code === "CONVERSATION_MALFORMED") {
    return (
      <main className="conversation empty-state" data-testid="malformed-state" inert={props.inert}>
        <h1>This conversation can’t be opened</h1>
        <p>
          Its file on the server is not valid ChatUI Markdown, so it can’t be shown or changed. The
          file is left untouched; you can delete it.
        </p>
        <button
          type="button"
          className="danger"
          onClick={() => {
            setConfirmDelete(true);
          }}
          disabled={!hydrated}
        >
          Delete conversation
        </button>
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title="Delete this conversation?"
          description="The unreadable file will be permanently deleted."
          confirmLabel="Delete"
          onConfirm={() => void deleteMalformed()}
        />
      </main>
    );
  }
  if (loadError?.status === 404) {
    return (
      <main className="conversation empty-state" data-testid="missing-state" inert={props.inert}>
        <h1>This conversation does not exist</h1>
        <p>It may have been deleted.</p>
      </main>
    );
  }

  const modelCount = allModels.length;
  const canSend = hydrated && modelCount > 0 && !running && !busy && !props.inert;

  return (
    <main className="conversation" data-testid="conversation" inert={props.inert}>
      <div className="conversation-header">
        <h1 className="conversation-title">
          {conversation?.title ?? (conversationId ? "" : "New chat")}
        </h1>
      </div>
      {/* Focusable so keyboard users can scroll it (it is its own scroll container). */}
      <div
        className="transcript"
        ref={transcriptRef}
        {...scrollHandlers}
        tabIndex={0}
        role="region"
        aria-label="Transcript"
        data-testid="transcript"
      >
        <ol className="messages" aria-label="Messages">
          {conversation?.messages.map((message) => (
            <Message
              key={message.id}
              role={message.role}
              content={message.content}
              reasoning={message.reasoning}
              status={message.status}
            />
          ))}
          {showLive ? (
            <li
              className="message message-assistant live"
              data-testid="response"
              aria-busy={running}
            >
              <span className="message-role">Assistant</span>
              {live.reasoning ? (
                <details className="reasoning" data-testid="reasoning">
                  <summary>Reasoning</summary>
                  <div className="reasoning-body">{live.reasoning}</div>
                </details>
              ) : null}
              {/* Streaming Markdown: unfinished fences/tables/lists render stably. */}
              <div data-testid="content">
                <Markdown text={live.content} />
              </div>
              <p className="gen-status" data-testid="generation-status">
                {STATE_LABEL[live.state]}
                {live.error ? ` — ${live.error.message}` : ""}
              </p>
            </li>
          ) : null}
        </ol>
        {conversation?.messages.length === 0 && !showLive ? (
          <p className="placeholder">Send a message to start.</p>
        ) : null}
      </div>
      {showJump ? (
        <button
          type="button"
          className="jump-to-latest"
          onClick={jumpToLatest}
          data-testid="jump-to-latest"
        >
          <ArrowDown size={16} aria-hidden /> Jump to latest
        </button>
      ) : null}
      <p className="gen-status" role="status" aria-live="polite" data-testid="status">
        {status ?? ""}
      </p>
      <form
        className="composer"
        onSubmit={(event) => void send(event)}
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
              if (canSend) void send();
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
            disabled={modelCount === 0 || props.inert}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setSelected(value);
              try {
                const pair = JSON.parse(value) as [string, string];
                shell.setModel(draftKey, pair);
              } catch {
                // placeholder option
              }
            }}
          >
            {modelCount === 0 ? <option value="">No models available</option> : null}
            {groups.map((group: ModelListDto["providers"][number]) => (
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
            <button
              type="button"
              className="secondary"
              onClick={() => void cancel()}
              disabled={!hydrated}
            >
              <Square size={14} aria-hidden /> Stop generating
            </button>
          ) : (
            <button type="submit" disabled={!canSend}>
              <Send size={14} aria-hidden /> Send
            </button>
          )}
        </div>
      </form>
    </main>
  );
}
