import * as Menu from "@radix-ui/react-dropdown-menu";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, PanelLeft, Square, SquarePen, X } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type SyntheticEvent,
} from "react";
import { Link, useLocation, useNavigate, useRouteLoaderData } from "react-router";
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
import { paths, type OverlayState } from "../lib/paths";
import { ApiError, apiJson, fetchers, queryKeys } from "../lib/query";
import { NEW_DRAFT, useQueue, useShell, type QueuedMessage } from "../lib/shell-context";
import { useSidebar } from "../lib/sidebar-context";
import { useScrollPin } from "../lib/use-scroll-pin";
import {
  COMMAND_MENU_ID,
  CommandMenu,
  commandOptionId,
  commandQuery,
  filterCommands,
  type Command,
} from "./CommandMenu";
import { useConversationActions } from "./ConversationActions";
import { ConfirmDialog } from "./Dialogs";
import { Markdown } from "./Markdown";
import { Message, Reasoning } from "./Message";

/** Resends of an unresolved send with the same operation key (contracts §4.1). */
const SEND_RETRIES = 3;
/** The model list is re-read when the tab regains focus, at most this often. */
const MODEL_REFRESH_MS = 30_000;

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

/** The empty-chat greeting: the page heading on a new chat. */
function Greeting({ level, text }: { level: 1 | 2; text: string }) {
  return level === 1 ? <h1 className="greeting">{text}</h1> : <h2 className="greeting">{text}</h2>;
}

/**
 * One conversation (or the /chat/new draft). Server-owned state only: the
 * transcript comes from the conversation query, the running reply from the
 * generation's SSE stream (replay/resync aware), reconciled by server ids.
 * Browser lifecycle events never cancel a generation. Messages sent while a
 * reply streams wait in the shell's queue and go out one at a time.
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
  const location = useLocation();
  const client = useQueryClient();
  const shell = useShell();
  const sidebar = useSidebar();
  const actions = useConversationActions(userId);
  const layout = useRouteLoaderData<{ user?: { username: string } }>("routes/app-layout");
  const draftKey = conversationId ?? NEW_DRAFT;
  const queued = useQueue(draftKey);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<HTMLSelectElement>(null);
  const titleTriggerRef = useRef<HTMLButtonElement>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // "/" commands: the typed filter (null: closed) and the highlighted option.
  const [slash, setSlash] = useState<string | null>(null);
  const [activeCommand, setActiveCommand] = useState(0);

  const conversationQuery = useQuery({
    queryKey: queryKeys.conversation(userId, conversationId ?? ""),
    queryFn: () => fetchers.conversation(conversationId ?? ""),
    enabled: conversationId !== undefined && !props.initialError,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
  });
  // Re-read (bypassing the server's cache) when the tab regains focus, so
  // models loaded or unloaded on the provider show up without a button.
  const modelsQuery = useQuery({
    queryKey: queryKeys.models(userId),
    queryFn: () => fetchers.models(true),
    staleTime: MODEL_REFRESH_MS,
    refetchOnWindowFocus: true,
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

  /** Puts queued messages back into the message box (Stop, or a failed reply). */
  function restoreQueue(reason: string | null, first?: QueuedMessage) {
    const items = [...(first ? [first] : []), ...shell.takeQueue(draftKey)];
    const box = textareaRef.current;
    if (items.length === 0 || !box) return;
    box.value = [...items.map((m) => m.content), box.value].filter((t) => t !== "").join("\n\n");
    shell.setDraft(draftKey, box.value);
    setHasDraft(true);
    if (reason) setStatus(reason);
  }
  const onTerminal = useEffectEvent((state: TerminalState) => {
    if (state === "failed" || state === "timed_out")
      restoreQueue("The reply did not finish, so your queued messages are back in the box.");
  });

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
      onTerminal(t.state);
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
  // reply appearing, its state line, its growing text and queued messages.
  const contentVersion = [
    conversation?.messages.length ?? 0,
    showLive ? `${live.generationId}:${live.state}:${live.error ? "e" : ""}` : "-",
    live?.content.length ?? 0,
    live?.reasoning.length ?? 0,
    queued.length,
  ].join("|");
  const {
    ref: transcriptRef,
    handlers: scrollHandlers,
    showJump,
    jumpToLatest,
  } = useScrollPin<HTMLDivElement>(contentVersion);

  function clearBox() {
    if (textareaRef.current) textareaRef.current.value = "";
    shell.clearDraft(draftKey);
    setHasDraft(false);
    setSlash(null);
  }

  /** Starts a generation; true once the server accepted it. */
  async function submit(content: string, pair: [string, string], fromBox: boolean) {
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
          if (fromBox) clearBox();
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
            // Messages queued on the draft follow it into the new conversation.
            shell.moveQueue(draftKey, started.conversationId);
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
          return true;
        } catch (error) {
          if (error instanceof AccountChangedError) return false; // discarded, never re-sent
          // A contract error other than INTERNAL means rejected: nothing was saved.
          if (error instanceof ApiError && error.code && error.code !== "INTERNAL") {
            setStatus(error.message);
            return false;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
      }
      setStatus(
        "The outcome of this send is unknown. Check the conversation, then send again if needed.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Enter or the send button: send now, or queue while a reply is running. */
  function send(event?: SyntheticEvent) {
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
    if (running || busy) {
      shell.enqueue(draftKey, { id: crypto.randomUUID(), content, pair });
      clearBox();
      return;
    }
    void submit(content, pair, true);
  }

  // Drain the queue: the next message goes out once the reply has finished
  // and the stored transcript is back (so it follows the reply it answers).
  const sendNextQueued = useEffectEvent(async (next: QueuedMessage) => {
    shell.removeQueued(draftKey, next.id);
    // Rejected (the status says why): it and the rest go back to the box.
    if (!(await submit(next.content, next.pair, false))) restoreQueue(null, next);
  });
  const nextQueued = queued.at(0);
  const transcriptReady = conversationId === undefined || conversation !== undefined;
  useEffect(() => {
    if (!nextQueued || running || busy || props.inert || !hydrated || !transcriptReady) return;
    // Next task, so a re-run before the send starts cancels it (no double send).
    const timer = setTimeout(() => void sendNextQueued(nextQueued), 0);
    return () => {
      clearTimeout(timer);
    };
  }, [nextQueued, running, busy, props.inert, hydrated, transcriptReady]);

  async function cancel() {
    if (!observedId) return;
    // Stopping also stops the queue: queued messages return to the box.
    restoreQueue(null);
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
      <main className="chat empty-state" data-testid="malformed-state" inert={props.inert}>
        <h1>This conversation can’t be opened</h1>
        <p>
          Its file on the server is not valid ChatUI Markdown, so it can’t be shown or changed. The
          file is left untouched; you can delete it.
        </p>
        <button
          type="button"
          className="secondary danger-outline"
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
      <main className="chat empty-state" data-testid="missing-state" inert={props.inert}>
        <h1>This conversation does not exist</h1>
        <p>It may have been deleted.</p>
        <Link to={paths.newChat()}>Start a new chat</Link>
      </main>
    );
  }

  const modelCount = allModels.length;
  const canSend = hydrated && modelCount > 0 && !running && !busy && !props.inert;
  const empty =
    (conversationId === undefined || conversation?.messages.length === 0) &&
    !showLive &&
    queued.length === 0;

  const commands: Command[] = [
    { name: "model", description: "Choose the model for this chat" },
    { name: "new", description: "Start a new chat" },
    ...(conversation
      ? [
          { name: "rename", description: "Rename this chat" },
          { name: "delete", description: "Delete this chat" },
        ]
      : []),
    { name: "settings", description: "Open settings" },
  ];
  const shownCommands = slash === null ? [] : filterCommands(commands, slash);
  const commandOpen = shownCommands.length > 0;
  const active = shownCommands[Math.min(activeCommand, shownCommands.length - 1)];
  function runCommand(command: Command) {
    clearBox();
    switch (command.name) {
      case "model": {
        const select = modelRef.current;
        select?.focus();
        try {
          select?.showPicker();
        } catch {
          // Not supported or not allowed here: focus is enough.
        }
        break;
      }
      case "new":
        void navigate(paths.newChat());
        break;
      case "rename":
        if (conversation) actions.rename(conversation, textareaRef.current);
        break;
      case "delete":
        if (conversation) actions.remove(conversation, textareaRef.current);
        break;
      case "settings":
        void navigate(paths.settings(), {
          state: { background: location.pathname } satisfies OverlayState,
        });
        break;
    }
  }

  return (
    <main
      className={`chat${empty ? " chat-empty" : ""}`}
      data-testid="conversation"
      inert={props.inert}
    >
      <header className="chat-header app-header">
        {sidebar.visible ? null : (
          <span className="header-nav">
            <button
              type="button"
              className="icon-btn"
              aria-label="Show sidebar"
              aria-expanded={false}
              aria-controls="sidebar"
              title="Show sidebar"
              onClick={sidebar.show}
            >
              <PanelLeft size={18} aria-hidden />
            </button>
            <Link to={paths.newChat()} className="icon-btn" aria-label="New chat" title="New chat">
              <SquarePen size={18} aria-hidden />
            </Link>
          </span>
        )}
        {conversation ? (
          <h1 className="chat-title">
            <Menu.Root modal={false}>
              <Menu.Trigger ref={titleTriggerRef} className="title-trigger">
                <span className="title-text">{conversation.title}</span>
                <ChevronDown size={16} aria-hidden />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content className="menu-popover" align="start" sideOffset={6}>
                  <Menu.Item
                    className="menu-item"
                    onSelect={() => {
                      actions.rename(conversation, titleTriggerRef.current);
                    }}
                  >
                    Rename
                  </Menu.Item>
                  <Menu.Item
                    className="menu-item danger"
                    onSelect={() => {
                      actions.remove(conversation, titleTriggerRef.current);
                    }}
                  >
                    Delete
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
          </h1>
        ) : null}
      </header>

      {/* Focusable so keyboard users can scroll it (it is its own scroll container). */}
      <div
        className="scroll"
        ref={transcriptRef}
        {...scrollHandlers}
        tabIndex={0}
        role="region"
        aria-label="Transcript"
        data-testid="transcript"
      >
        {empty ? (
          <Greeting
            level={conversation ? 2 : 1}
            text={layout?.user ? `How can I help, ${layout.user.username}?` : "How can I help?"}
          />
        ) : null}
        <ol className="history" aria-label="Messages">
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
            <li className="turn turn-assistant live" data-testid="response" aria-busy={running}>
              <span className="visually-hidden">Assistant</span>
              {live.reasoning ? (
                <Reasoning
                  text={live.reasoning}
                  done={!running || live.content !== ""}
                  testId="reasoning"
                />
              ) : null}
              {/* Streaming Markdown: unfinished fences/tables/lists render stably. */}
              <div data-testid="content">
                <Markdown text={live.content} />
              </div>
              {running && live.content === "" ? <span className="cursor" aria-hidden /> : null}
              <p className="gen-status" data-testid="generation-status">
                {STATE_LABEL[live.state]}
                {live.error ? ` — ${live.error.message}` : ""}
              </p>
            </li>
          ) : null}
          {queued.map((item) => (
            <li key={item.id} className="turn turn-user turn-queued" data-testid="message-queued">
              <span className="visually-hidden">You (queued)</span>
              <div className="bubble">
                <p className="plain-text">{item.content}</p>
              </div>
              <div className="queued-meta">
                <span>Queued</span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Remove queued message"
                  title="Remove"
                  onClick={() => {
                    shell.removeQueued(draftKey, item.id);
                  }}
                >
                  <X size={14} aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ol>
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

      <form
        className="composer"
        onSubmit={(event) => {
          send(event);
        }}
        aria-label="Message composer"
      >
        <p
          className="gen-status composer-status"
          role="status"
          aria-live="polite"
          data-testid="status"
        >
          {status ?? ""}
        </p>
        {modelsQuery.isError && modelCount === 0 ? (
          <p className="error" role="alert">
            Couldn’t load the model list.{" "}
            <button
              type="button"
              className="link-button"
              onClick={() => void modelsQuery.refetch()}
            >
              Try again
            </button>
          </p>
        ) : null}
        {commandOpen ? (
          <CommandMenu
            commands={shownCommands}
            activeIndex={Math.min(activeCommand, shownCommands.length - 1)}
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
              if (query !== slash) setActiveCommand(0);
              setSlash(query);
            }}
            onKeyDown={(event) => {
              if (commandOpen) {
                const n = shownCommands.length;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : n - 1;
                  setActiveCommand((i) => (Math.min(i, n - 1) + step) % n);
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
                if (hydrated && modelCount > 0 && !props.inert) send();
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
            <ChevronDown size={15} className="model-chevron" aria-hidden />
          </span>
          {running && hasDraft ? (
            <button
              type="submit"
              className="send-btn secondary-send"
              aria-label="Queue message"
              title="Queue message (sent when the reply finishes)"
              disabled={!hydrated || props.inert}
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
              onClick={() => void cancel()}
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
      {actions.dialogs}
    </main>
  );
}
