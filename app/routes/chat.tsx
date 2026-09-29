import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type SyntheticEvent,
} from "react";
import { Link, redirect, useNavigate, useRevalidator } from "react-router";
import type { ConversationDto, ConversationSummary, MessageDto } from "@shared/conversations";
import {
  isTerminalState,
  type GenerationState,
  type TerminalState,
} from "@shared/generation-state";
import type {
  GenerationError,
  GenerationSnapshot,
  ModelDto,
  StartGenerationResponse,
} from "@shared/generations";
import { appContext } from "../context";
import { ACCOUNT_CHANGED_EVENT, AccountChangedError, apiFetch } from "../lib/api";
import type { Route } from "./+types/chat";

/** SSR waits this long for model discovery before rendering without it. */
const MODEL_DISCOVERY_BUDGET_MS = 2_500;
/** Resends of an unresolved send with the same operation key (contracts §4.1). */
const SEND_RETRIES = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  return [
    {
      title: loaderData.conversation
        ? `${loaderData.conversation.title} · ChatUI`
        : "ChatUI · Local chat",
    },
  ];
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const { services, auth } = context.get(appContext);
  const url = new URL(request.url);
  // Private surface: identity from the server-side session only (INV-54).
  if (!auth) throw redirect(`/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`);

  const id = url.searchParams.get("c");
  const modelsPromise = Promise.race([
    services.models.list().then((models) => ({ models, modelError: null })),
    new Promise<{ models: ModelDto[]; modelError: string }>((resolve) => {
      setTimeout(() => {
        resolve({ models: [], modelError: "The model server is taking a long time to respond." });
      }, MODEL_DISCOVERY_BUDGET_MS).unref();
    }),
  ]).catch((error: unknown) => ({
    models: [] as ModelDto[],
    modelError: error instanceof Error ? error.message : "The model server is unreachable.",
  }));
  let conversation: ConversationDto | null = null;
  let conversationError: string | null = null;
  if (id !== null) {
    if (!UUID.test(id)) conversationError = "This conversation does not exist.";
    else {
      try {
        conversation = await services.conversationDto(auth.userId, id);
      } catch (error) {
        conversationError =
          (error as { code?: string }).code === "CONVERSATION_MALFORMED"
            ? "This conversation file is malformed. It can be deleted, but not opened or changed."
            : "This conversation does not exist.";
      }
    }
  }
  // Public summary fields only (the index also stores file stamps).
  const conversations: ConversationSummary[] = services.conversations
    .list(auth.userId)
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      messageCount: entry.messageCount,
      malformed: entry.malformed,
    }));
  const { models, modelError } = await modelsPromise;
  return {
    conversations,
    conversation,
    conversationError,
    selectedId: id,
    models,
    modelError,
    username: auth.username,
  };
}

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
  finishReason: string | null;
  error: GenerationError | null;
}

const STATE_LABEL: Record<GenerationState, string> = {
  pending: "Waiting for the model…",
  streaming: "Generating…",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
  timed_out: "Timed out",
};

const STATUS_LABEL: Record<NonNullable<MessageDto["status"]>, string> = {
  complete: "",
  cancelled: "Stopped",
  failed: "Failed",
  timed_out: "Timed out",
  interrupted: "Interrupted",
};

async function errorOf(response: Response): Promise<{ code: string | null; message: string }> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    return {
      code: body.error?.code ?? null,
      message: body.error?.message ?? `Request failed (${String(response.status)})`,
    };
  } catch {
    return { code: null, message: `Request failed (${String(response.status)})` };
  }
}

function Message({ message }: { message: MessageDto }) {
  const label =
    message.role === "user" ? "You" : message.role === "assistant" ? "Assistant" : "System";
  return (
    <li className={`turn turn-${message.role}`} data-testid={`message-${message.role}`}>
      <span className="turn-role">
        {label}
        {message.status && STATUS_LABEL[message.status] ? ` · ${STATUS_LABEL[message.status]}` : ""}
      </span>
      {message.reasoning ? (
        <details className="reasoning">
          <summary>Reasoning</summary>
          <p>{message.reasoning}</p>
        </details>
      ) : null}
      <p>{message.content}</p>
    </li>
  );
}

export default function Chat({ loaderData }: Route.ComponentProps) {
  const { conversations, conversation, conversationError, models: initialModels } = loaderData;
  const hydrated = useHydrated();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<HTMLSelectElement>(null);
  const [models, setModels] = useState<ModelDto[]>(initialModels);
  const [modelError, setModelError] = useState<string | null>(loaderData.modelError);
  const [live, setLive] = useState<Live | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The running generation: the one we just started, else the server's view.
  const serverActive = conversation?.activeGeneration?.generationId ?? null;
  const observedId = live && !isTerminalState(live.state) ? live.generationId : serverActive;

  // Observe over SSE; closing this never cancels the generation (INV-06).
  useEffect(() => {
    if (!observedId) return;
    const source = new EventSource(`/api/generations/${observedId}/stream`);
    source.addEventListener("snapshot", (event) => {
      const s = JSON.parse(event.data as string) as GenerationSnapshot;
      setLive({
        generationId: s.generationId,
        assistantMessageId: s.assistantMessageId,
        state: s.state,
        content: s.content,
        reasoning: s.reasoning,
        finishReason: s.finishReason,
        error: s.error,
      });
      if (isTerminalState(s.state)) {
        source.close();
        void revalidator.revalidate();
      }
    });
    source.addEventListener("state", (event) => {
      const { state } = JSON.parse(event.data as string) as { state: GenerationState };
      setLive((v) => (v?.generationId === observedId ? { ...v, state } : v));
    });
    source.addEventListener("delta", (event) => {
      const delta = JSON.parse(event.data as string) as { content?: string; reasoning?: string };
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
    source.addEventListener("terminal", (event) => {
      const t = JSON.parse(event.data as string) as {
        state: TerminalState;
        finishReason: string | null;
        error: GenerationError | null;
      };
      setLive((v) => (v?.generationId === observedId ? { ...v, ...t } : v));
      source.close();
      // Show the canonical transcript (the reply is now stored).
      void revalidator.revalidate();
    });
    return () => {
      source.close();
    };
    // revalidator identity changes on every render; the stream only depends on the id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [observedId]);

  // Another tab signed in as someone else, or this session ended: drop all
  // user-bound state (draft, live view) and go to sign-in (INV-59).
  useEffect(() => {
    const onChange = () => {
      if (textareaRef.current) textareaRef.current.value = "";
      setLive(null);
      setStatus(null);
      void navigate("/login", { replace: true });
    };
    window.addEventListener(ACCOUNT_CHANGED_EVENT, onChange);
    return () => {
      window.removeEventListener(ACCOUNT_CHANGED_EVENT, onChange);
    };
  }, [navigate]);

  async function logout() {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    if (textareaRef.current) textareaRef.current.value = "";
    await navigate("/login", { replace: true });
  }

  const refreshModels = useCallback(async () => {
    setModelError(null);
    const response = await fetch("/api/models?refresh=1");
    if (!response.ok) {
      setModelError((await errorOf(response)).message);
      return;
    }
    setModels(((await response.json()) as { models: ModelDto[] }).models);
  }, []);

  async function send(event?: SyntheticEvent) {
    event?.preventDefault();
    // The textarea is uncontrolled, so text typed before hydration is kept.
    const content = textareaRef.current?.value.trim() ?? "";
    const model = modelRef.current?.value ?? "";
    if (!content) {
      textareaRef.current?.focus();
      return;
    }
    if (!model || observedId || busy) return;
    setBusy(true);
    setStatus("Sending…");
    const body = JSON.stringify({
      ...(conversation ? { conversationId: conversation.id } : {}),
      model,
      content,
      operationKey: crypto.randomUUID(),
      operationIssuedAt: new Date().toISOString(),
    });
    try {
      for (let attempt = 0; attempt <= SEND_RETRIES; attempt++) {
        let response: Response | undefined;
        try {
          response = await apiFetch("/api/generations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
        } catch (error) {
          if (error instanceof AccountChangedError) return; // discarded, never re-sent
          response = undefined; // network error: outcome unknown, resend with the same key
        }
        if (response?.status === 202) {
          const started = (await response.json()) as StartGenerationResponse;
          if (textareaRef.current) textareaRef.current.value = "";
          setStatus(null);
          setLive({
            generationId: started.generationId,
            assistantMessageId: started.assistantMessageId,
            state: "pending",
            content: "",
            reasoning: "",
            finishReason: null,
            error: null,
          });
          if (started.conversationId !== conversation?.id) {
            await navigate(`/chat?c=${started.conversationId}`);
          } else {
            await revalidator.revalidate();
          }
          return;
        }
        if (response) {
          const error = await errorOf(response);
          // Any contract error except INTERNAL means rejected: nothing was saved.
          if (error.code && error.code !== "INTERNAL") {
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
    await apiFetch(`/api/generations/${observedId}/cancel`, { method: "POST" });
  }

  async function rename(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!conversation) return;
    const title = new FormData(event.currentTarget).get("title");
    if (typeof title !== "string" || title.trim() === "") return;
    const response = await apiFetch(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim(), expectedRevision: conversation.revision }),
    });
    setStatus(response.ok ? null : (await errorOf(response)).message);
    await revalidator.revalidate();
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    const response = await apiFetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (!response.ok) {
      setStatus((await errorOf(response)).message);
      return;
    }
    await navigate("/chat");
  }

  const defaultModel = (models.find((m) => m.status === "loaded") ?? models[0])?.id;
  const running = observedId !== null;
  const canSend = hydrated && models.length > 0 && !running && !busy && conversationError === null;
  // Keep the streamed reply on screen until the stored copy is in the transcript.
  const showLive =
    live !== null &&
    (running || !conversation?.messages.some((m) => m.id === live.assistantMessageId));

  return (
    <div className="chat-layout">
      <nav className="sidebar" aria-label="Conversations">
        <Link to="/chat" className="new-chat">
          New chat
        </Link>
        <ul data-testid="conversation-list">
          {conversations.map((item: ConversationSummary) => (
            <li key={item.id} className={item.id === loaderData.selectedId ? "current" : undefined}>
              <Link
                to={`/chat?c=${item.id}`}
                aria-current={item.id === loaderData.selectedId ? "page" : undefined}
              >
                {item.malformed ? `${item.title} (unreadable)` : item.title}
              </Link>
            </li>
          ))}
        </ul>
        <p className="hint">
          <span data-testid="signed-in-user">{loaderData.username}</span> ·{" "}
          <a href="/account">Account</a> ·{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => void logout()}
            disabled={!hydrated}
          >
            Sign out
          </button>
        </p>
      </nav>

      <main className="chat">
        <header className="chat-header">
          {conversation ? (
            <form
              className="title-form"
              onSubmit={(event) => void rename(event)}
              key={conversation.revision}
            >
              <label htmlFor="title" className="visually-hidden">
                Conversation title
              </label>
              <input id="title" name="title" defaultValue={conversation.title} maxLength={200} />
              <button type="submit" className="secondary" disabled={!hydrated}>
                Rename
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!hydrated}
                onClick={() => void remove(conversation.id)}
              >
                Delete
              </button>
            </form>
          ) : (
            <h1>{conversationError ? "Conversation unavailable" : "New chat"}</h1>
          )}
        </header>

        {conversationError ? (
          <p className="error" role="alert">
            {conversationError}{" "}
            {loaderData.selectedId && UUID.test(loaderData.selectedId) ? (
              <button
                type="button"
                className="secondary"
                disabled={!hydrated}
                onClick={() => void remove(loaderData.selectedId ?? "")}
              >
                Delete it
              </button>
            ) : null}
          </p>
        ) : null}

        <ol className="history" aria-label="Messages" data-testid="transcript">
          {conversation?.messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
        </ol>

        {showLive ? (
          <section className="response" aria-label="Reply in progress" data-testid="response">
            {live.reasoning ? (
              <details className="reasoning" data-testid="reasoning">
                <summary>Reasoning</summary>
                <p>{live.reasoning}</p>
              </details>
            ) : null}
            <p className="content" data-testid="content">
              {live.content}
            </p>
            <p className="gen-status" data-testid="generation-status">
              {STATE_LABEL[live.state]}
              {live.error ? ` — ${live.error.message}` : ""}
            </p>
            {running ? (
              <button
                type="button"
                className="secondary"
                onClick={() => void cancel()}
                disabled={!hydrated}
              >
                Stop generating
              </button>
            ) : null}
          </section>
        ) : null}

        <p className="gen-status" role="status" aria-live="polite" data-testid="status">
          {status ?? ""}
        </p>

        <form
          className="composer"
          onSubmit={(event) => void send(event)}
          aria-label="Message composer"
        >
          <label htmlFor="model">Model</label>
          <div className="model-row">
            <select
              id="model"
              name="model"
              ref={modelRef}
              defaultValue={defaultModel}
              disabled={models.length === 0}
            >
              {models.length === 0 ? <option value="">No models available</option> : null}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id}
                  {model.status === "unloaded" ? " (not loaded)" : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="secondary"
              onClick={() => void refreshModels()}
              disabled={!hydrated}
            >
              Refresh
            </button>
          </div>
          {modelError ? (
            <p className="error" role="alert">
              {modelError}
            </p>
          ) : null}
          <label htmlFor="message">Message</label>
          <textarea
            id="message"
            name="message"
            ref={textareaRef}
            rows={4}
            placeholder="Ask anything…"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-actions">
            <span className="hint">
              {hydrated ? "Enter to send, Shift+Enter for a new line" : "Loading…"}
            </span>
            <button type="submit" disabled={!canSend}>
              Send
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
