import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type Mutation,
} from "@tanstack/react-query";
import { ArrowDown } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import type { ConversationDto } from "@shared/conversations";
import { isTerminalState, type GenerationState } from "@shared/generation-state";
import type { StartGenerationResponse } from "@shared/generations";
import { AccountChangedError } from "../lib/api";
import { authStore } from "../lib/auth-store";
import { paths } from "../lib/paths";
import { markAccepted, markGeneration, markOnce } from "../lib/perf";
import { ApiError, apiJson, queries, queryKeys } from "../lib/query";
import {
  lookUpOperation,
  newSendVariables,
  SendRejectedError,
  sendWithRetries,
  SendUnknownError,
  type SendVariables,
} from "../lib/send";
import { NEW_DRAFT, useShell } from "../lib/shell-context";
import { useLiveGeneration } from "../lib/use-live-generation";
import { useScrollPin } from "../lib/use-scroll-pin";
import { Composer, type ModelChoice } from "./Composer";
import { Markdown } from "./Markdown";
import { Message } from "./Message";

// Only the (rare) malformed state needs a dialog: load it on demand.
const ConfirmDialog = lazy(() => import("./Dialogs").then((m) => ({ default: m.ConfirmDialog })));

const noopSubscribe = () => () => undefined;
function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

const STATE_LABEL: Record<GenerationState, string> = {
  pending: "Waiting for the model…",
  streaming: "Generating…",
  completed: "Completed",
  cancelled: "Stopped",
  failed: "Failed",
  timed_out: "Timed out",
};

type SendMutation = Mutation<StartGenerationResponse, Error, SendVariables>;

/** Optimistic user messages of this view, read from the send mutations' state. */
function usePendingSends(userId: string, draftKey: string, conversationId: string | undefined) {
  return useMutationState({
    filters: { mutationKey: queryKeys.sends(userId) },
    select: (mutation) => {
      const m = mutation as SendMutation;
      return { mutation: m, state: m.state };
    },
  }).filter(({ state }) => {
    const vars = state.variables;
    if (!vars) return false;
    // A rejected send is rolled back: its text returns to the composer.
    if (state.status === "error" && !(state.error instanceof SendUnknownError)) return false;
    // Once accepted, a send belongs to the conversation the server named.
    if (state.data)
      return conversationId !== undefined && state.data.conversationId === conversationId;
    return vars.conversationKey === draftKey;
  });
}

/**
 * One conversation (or the /chat/new draft). Server-owned state only: the
 * transcript comes from the conversation query, the running reply from the
 * generation's SSE stream, optimistic user messages from send mutations;
 * everything reconciles by server-issued ids.
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
  const [status, setStatus] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmUsed, setConfirmUsed] = useState(false);

  const conversationQuery = useQuery({
    ...queries.conversation(userId, conversationId ?? ""),
    enabled: conversationId !== undefined && !props.initialError,
  });
  const modelsQuery = useQuery(queries.models(userId));
  const conversation: ConversationDto | undefined = conversationQuery.data;
  const loadError =
    conversationQuery.error instanceof ApiError
      ? conversationQuery.error
      : conversationQuery.data === undefined && props.initialError
        ? new ApiError(props.initialError.status, props.initialError.code, "")
        : null;

  const { live, observedId, started } = useLiveGeneration({
    userId,
    conversationId,
    serverActive: conversation?.activeGeneration?.generationId ?? null,
    disabled: props.inert === true,
  });

  // The loader saw no session (client navigation after expiry): re-authenticate.
  const unauthenticated = props.initialError?.status === 401;
  useEffect(() => {
    if (unauthenticated) authStore.expire();
  }, [unauthenticated]);

  // Drafts live in tab memory, keyed by conversation, and survive navigation.
  useEffect(() => {
    const el = textareaRef.current;
    if (el?.value === "") el.value = shell.getDraft(draftKey);
  }, [draftKey, shell]);

  const sendMutation = useMutation({
    mutationKey: queryKeys.sends(userId),
    mutationFn: (vars: SendVariables) => sendWithRetries(vars),
    // Runs even if this view unmounted: a rejected message returns to its draft.
    onError: (error, vars) => {
      if (error instanceof SendRejectedError && !shell.getDraft(vars.conversationKey))
        shell.setDraft(vars.conversationKey, vars.content);
    },
    onSuccess: (result, vars) => {
      markAccepted(result.generationId, result.conversationId);
      shell.setModel(result.conversationId, [vars.providerId, vars.model]);
      void client.invalidateQueries({ queryKey: queryKeys.conversations(userId) });
    },
  });
  const pending = usePendingSends(userId, draftKey, conversationId);

  // The requested conversation's transcript is on screen.
  const visibleId = props.inert ? undefined : conversation?.id;
  useEffect(() => {
    if (visibleId)
      markOnce("chatui:conversation-visible", visibleId, { conversationId: visibleId });
  }, [visibleId]);
  // The first streamed assistant output has been painted (next frame).
  const liveOutputId = live && (live.content || live.reasoning) ? live.generationId : null;
  useEffect(() => {
    if (!liveOutputId) return;
    const frame = requestAnimationFrame(() => {
      markGeneration("chatui:first-assistant-paint", liveOutputId);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [liveOutputId]);

  // Keep the live reply on screen until the stored copy is in the transcript.
  const storedIds = new Set(conversation?.messages.map((m) => m.id));
  const showLive =
    live !== null && (!isTerminalState(live.state) || !storedIds.has(live.assistantMessageId));
  const optimistic = pending.filter(
    ({ state }) => !(state.data && storedIds.has(state.data.userMessageId)),
  );
  const running = observedId !== null;
  const sending = pending.some(({ state }) => state.status === "pending");

  // Anything that changes the transcript's height: stored messages, optimistic
  // messages, the live reply appearing, its state line and its growing text.
  const contentVersion = [
    conversation?.messages.length ?? 0,
    optimistic.map(({ state }) => `${state.variables?.tempId ?? ""}:${state.status}`).join(","),
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

  const lastReply = [...(conversation?.messages ?? [])]
    .reverse()
    .find((m) => m.role === "assistant");

  function send(content: string, choice: ModelChoice) {
    if (running || sending) return;
    const vars = newSendVariables({
      userId,
      conversationKey: draftKey,
      ...(conversationId ? { conversationId } : {}),
      providerId: choice[0],
      model: choice[1],
      content,
    });
    // The optimistic message is visible immediately; the composer is cleared.
    if (textareaRef.current) textareaRef.current.value = "";
    shell.clearDraft(draftKey);
    setStatus(null);
    sendMutation.mutate(vars, {
      // Only while this view is still mounted.
      onSuccess: (result) => {
        started(result);
        if (result.conversationId !== conversationId) {
          // The draft becomes a real conversation: replace the draft URL so
          // Back does not resurrect the empty draft (INV-53).
          void navigate(paths.chat(result.conversationId), { replace: true });
        } else {
          void client.invalidateQueries({
            queryKey: queryKeys.conversation(userId, result.conversationId),
          });
        }
      },
      onError: (error) => {
        if (error instanceof AccountChangedError) return; // discarded, never re-sent
        if (error instanceof SendRejectedError) {
          setStatus(error.message);
          const el = textareaRef.current;
          if (el?.value === "") el.value = vars.content;
        }
      },
    });
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
            setConfirmUsed(true);
            setConfirmDelete(true);
          }}
          disabled={!hydrated}
        >
          Delete conversation
        </button>
        {confirmUsed ? (
          <Suspense fallback={null}>
            <ConfirmDialog
              open={confirmDelete}
              onOpenChange={setConfirmDelete}
              title="Delete this conversation?"
              description="The unreadable file will be permanently deleted."
              confirmLabel="Delete"
              onConfirm={() => void deleteMalformed()}
            />
          </Suspense>
        ) : null}
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
        aria-busy={conversationQuery.isFetching && !conversation}
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
          {optimistic.map(({ mutation, state }) =>
            state.variables ? (
              <PendingMessage
                key={state.variables.tempId}
                vars={state.variables}
                status={state.status}
                error={state.error}
                onResolved={() => {
                  client.getMutationCache().remove(mutation);
                  void client.invalidateQueries({
                    queryKey: queryKeys.conversation(userId, conversationId ?? ""),
                  });
                }}
                onEdit={(text) => {
                  client.getMutationCache().remove(mutation);
                  const el = textareaRef.current;
                  if (el) {
                    el.value = text;
                    shell.setDraft(draftKey, text);
                    el.focus();
                  }
                }}
              />
            ) : null,
          )}
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
        <TranscriptPlaceholder
          conversationId={conversationId}
          loading={conversationQuery.isPending && !props.initialError}
          error={
            conversationQuery.isError && !loadError?.code ? conversationQuery.error : undefined
          }
          empty={
            (conversationId === undefined || conversation?.messages.length === 0) &&
            !showLive &&
            optimistic.length === 0
          }
          onRetry={() => void conversationQuery.refetch()}
        />
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
      <Composer
        userId={userId}
        textareaRef={textareaRef}
        draftKey={draftKey}
        hydrated={hydrated}
        inert={props.inert === true}
        running={running}
        sending={sending}
        status={status}
        models={modelsQuery}
        preferred={
          shell.getModel(draftKey) ??
          (lastReply?.provider && lastReply.model ? [lastReply.provider, lastReply.model] : null)
        }
        onSend={send}
        onCancel={() => void cancel()}
      />
    </main>
  );
}

function TranscriptPlaceholder(props: {
  conversationId: string | undefined;
  loading: boolean;
  error: Error | undefined;
  empty: boolean;
  onRetry: () => void;
}) {
  if (props.conversationId !== undefined && props.loading)
    return (
      <p className="placeholder" data-testid="transcript-loading">
        Loading conversation…
      </p>
    );
  if (props.error)
    return (
      <div className="placeholder" role="alert" data-testid="transcript-error">
        <p>This conversation couldn’t be loaded.</p>
        <button type="button" className="secondary" onClick={props.onRetry}>
          Try again
        </button>
      </div>
    );
  if (props.empty) return <p className="placeholder">Send a message to start.</p>;
  return null;
}

/** An optimistic user message: sending, sent (awaiting the stored copy) or unknown. */
function PendingMessage(props: {
  vars: SendVariables;
  status: "idle" | "pending" | "success" | "error";
  error: Error | null;
  onResolved: () => void;
  onEdit: (text: string) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const unknown = props.status === "error" && props.error instanceof SendUnknownError;
  return (
    <li
      className="message message-user pending"
      data-testid="message-pending"
      data-temp-id={props.vars.tempId}
      aria-busy={props.status === "pending"}
    >
      <span className="message-role">
        You
        {props.status === "pending" ? <span className="status-badge">Sending…</span> : null}
        {unknown ? <span className="status-badge status-failed">Outcome unknown</span> : null}
      </span>
      <p className="plain-text">{props.vars.content}</p>
      {unknown ? (
        <div className="pending-actions" role="alert">
          <p>
            {notFound
              ? "The server has no record of this message. It was probably not saved."
              : "We couldn’t confirm whether this message was saved. Refresh the conversation to check."}
          </p>
          <button
            type="button"
            className="secondary"
            disabled={checking}
            onClick={() => {
              setChecking(true);
              void lookUpOperation(props.vars.operationKey)
                .then((result) => {
                  if (result) props.onResolved();
                  else setNotFound(true);
                })
                .catch(() => undefined)
                .finally(() => {
                  setChecking(false);
                });
            }}
          >
            Refresh conversation
          </button>
          {notFound ? (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                props.onEdit(props.vars.content);
              }}
            >
              Edit and resend
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
