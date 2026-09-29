import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type SyntheticEvent,
} from "react";
import { data, useNavigate, type ShouldRevalidateFunction } from "react-router";
import {
  isTerminalState,
  type GenerationState,
  type TerminalState,
} from "@shared/generation-state";
import type {
  ChatMessage,
  GenerationError,
  GenerationSnapshot,
  ModelDto,
  StartGenerationResponse,
} from "@shared/generations";
import { appContext } from "../context";
import type { Route } from "./+types/chat";

/** SSR waits this long for model discovery before rendering without it. */
const MODEL_DISCOVERY_BUDGET_MS = 2_500;

export function meta(): Route.MetaDescriptors {
  return [{ title: "ChatUI · Local chat demo" }];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function loader({ context, request }: Route.LoaderArgs) {
  const { services } = context.get(appContext);
  // Pre-auth chat exists only on the loopback-guarded host process (§9.2b).
  if (!services.chatDemoEnabled) throw data("Not found", { status: 404 });

  const generationId = new URL(request.url).searchParams.get("g");
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
  let generation: GenerationSnapshot | null = null;
  if (generationId && UUID.test(generationId)) {
    try {
      generation = services.generations.snapshot(generationId);
    } catch {
      generation = null; // evicted or unknown: show an empty composer
    }
  }
  const { models, modelError } = await modelsPromise;
  return { models, modelError, generation };
}

/** Only the loader's own inputs matter; `?g=` changes made by this page need no reload. */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}) => (currentUrl.pathname !== nextUrl.pathname ? defaultShouldRevalidate : false);

const noopSubscribe = () => () => undefined;
function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

interface View {
  generationId: string;
  model: string;
  state: GenerationState;
  content: string;
  reasoning: string;
  finishReason: string | null;
  error: GenerationError | null;
}

function viewFrom(snapshot: GenerationSnapshot): View {
  return {
    generationId: snapshot.generationId,
    model: snapshot.model,
    state: snapshot.state,
    content: snapshot.content,
    reasoning: snapshot.reasoning,
    finishReason: snapshot.finishReason,
    error: snapshot.error,
  };
}

const STATE_LABEL: Record<GenerationState, string> = {
  pending: "Waiting for the model…",
  streaming: "Generating…",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
  timed_out: "Timed out",
};

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `Request failed (${String(response.status)})`;
  } catch {
    return `Request failed (${String(response.status)})`;
  }
}

export default function Chat({ loaderData }: Route.ComponentProps) {
  const hydrated = useHydrated();
  const navigate = useNavigate();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<HTMLSelectElement>(null);
  const [models, setModels] = useState<ModelDto[]>(loaderData.models);
  const [modelError, setModelError] = useState<string | null>(loaderData.modelError);
  const [view, setView] = useState<View | null>(
    loaderData.generation ? viewFrom(loaderData.generation) : null,
  );
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const active = view !== null && !isTerminalState(view.state);
  const activeId = active ? view.generationId : null;

  // Observe the active generation over SSE. Closing this never cancels it.
  useEffect(() => {
    if (!activeId) return;
    const source = new EventSource(`/api/generations/${activeId}/stream`);
    source.addEventListener("snapshot", (event) => {
      setView(viewFrom(JSON.parse(event.data as string) as GenerationSnapshot));
    });
    source.addEventListener("state", (event) => {
      const { state } = JSON.parse(event.data as string) as { state: GenerationState };
      setView((v) => (v?.generationId === activeId ? { ...v, state } : v));
    });
    source.addEventListener("delta", (event) => {
      const delta = JSON.parse(event.data as string) as { content?: string; reasoning?: string };
      setView((v) =>
        v?.generationId === activeId
          ? {
              ...v,
              content: v.content + (delta.content ?? ""),
              reasoning: v.reasoning + (delta.reasoning ?? ""),
            }
          : v,
      );
    });
    source.addEventListener("terminal", (event) => {
      const terminal = JSON.parse(event.data as string) as {
        state: TerminalState;
        finishReason: string | null;
        error: GenerationError | null;
      };
      setView((v) => (v?.generationId === activeId ? { ...v, ...terminal } : v));
      source.close();
    });
    return () => {
      source.close();
    };
  }, [activeId]);

  const refreshModels = useCallback(async () => {
    setModelError(null);
    const response = await fetch("/api/models?refresh=1");
    if (!response.ok) {
      setModelError(await readError(response));
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
    if (!model || active || submitting) return;
    // The previous completed exchange becomes context for this one.
    const prior =
      view?.state === "completed" && lastPrompt !== null
        ? [
            ...history,
            { role: "user" as const, content: lastPrompt },
            { role: "assistant" as const, content: view.content },
          ]
        : history;
    setSubmitting(true);
    setRequestError(null);
    try {
      const response = await fetch("/api/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [...prior, { role: "user", content }] }),
      });
      if (response.status !== 202) {
        setRequestError(await readError(response));
        return;
      }
      const started = (await response.json()) as StartGenerationResponse;
      setHistory(prior);
      setLastPrompt(content);
      setView({
        generationId: started.generationId,
        model,
        state: "pending",
        content: "",
        reasoning: "",
        finishReason: null,
        error: null,
      });
      if (textareaRef.current) textareaRef.current.value = "";
      void navigate(`?g=${started.generationId}`, { replace: true, preventScrollReset: true });
    } catch {
      setRequestError("Could not reach ChatUI. Check that the server is running.");
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel() {
    if (!view) return;
    const response = await fetch(`/api/generations/${view.generationId}/cancel`, {
      method: "POST",
    });
    if (response.ok) setView(viewFrom((await response.json()) as GenerationSnapshot));
  }

  const defaultModel = (models.find((m) => m.status === "loaded") ?? models[0])?.id;
  const canSend = hydrated && models.length > 0 && !active && !submitting;

  return (
    <main className="chat">
      <header className="chat-header">
        <h1>Local chat demo</h1>
        <p className="lede">
          Loopback-only preview. Nothing is saved; reloading keeps watching the current reply.{" "}
          <a href="/">Status</a>
        </p>
      </header>

      {history.length > 0 ? (
        <ol className="history" aria-label="Earlier messages in this session">
          {history.map((message, index) => (
            <li key={index} className={`turn turn-${message.role}`}>
              <span className="turn-role">{message.role === "user" ? "You" : "Assistant"}</span>
              <p>{message.content}</p>
            </li>
          ))}
        </ol>
      ) : null}

      <section className="response" aria-label="Response" data-testid="response">
        {lastPrompt !== null ? (
          <p className="prompt" data-testid="prompt">
            <span className="turn-role">You</span> {lastPrompt}
          </p>
        ) : null}
        {view ? (
          <>
            {view.reasoning ? (
              <details className="reasoning" data-testid="reasoning">
                <summary>Reasoning</summary>
                <p>{view.reasoning}</p>
              </details>
            ) : null}
            <p className="content" data-testid="content">
              {view.content}
            </p>
          </>
        ) : (
          <p className="placeholder">Responses appear here.</p>
        )}
        <p className="gen-status" role="status" aria-live="polite" data-testid="generation-status">
          {view ? STATE_LABEL[view.state] : ""}
          {view?.state === "completed" && view.finishReason === "length"
            ? " — stopped at the output token limit"
            : ""}
          {view?.error ? ` — ${view.error.message}` : ""}
        </p>
        {active ? (
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
        {requestError ? (
          <p className="error" role="alert" data-testid="request-error">
            {requestError}
          </p>
        ) : null}
      </form>
    </main>
  );
}
