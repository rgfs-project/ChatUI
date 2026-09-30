import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type Mutation,
} from "@tanstack/react-query";
import { ArrowDown, ChevronDown, PanelLeft, SquarePen, X } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AttachmentDto, MessageAttachmentDto } from "@shared/attachments";
import {
  addFiles,
  moveTray,
  removeAttachment,
  restoreReady,
  takeReady,
  useTray,
} from "../lib/attachments";
import { MessageAttachments } from "./MessageAttachments";
import { Link, useLocation, useNavigate } from "react-router";
import type { ConversationDto } from "@shared/conversations";
import { isTerminalState, type GenerationState } from "@shared/generation-state";
import type { StartGenerationResponse } from "@shared/generations";
import { AccountChangedError } from "../lib/api";
import { authStore, useAuth } from "../lib/auth-store";
import { paths, type OverlayState } from "../lib/paths";
import { markAccepted, markGeneration, markOnce } from "../lib/perf";
import { ApiError, apiJson, queries, queryKeys } from "../lib/query";
import {
  lookUpOperation,
  newRegenerateVariables,
  newSendVariables,
  regenerateWithRetries,
  SendRejectedError,
  sendWithRetries,
  SendUnknownError,
  type SendVariables,
} from "../lib/send";
import { NEW_DRAFT, useQueue, useShell } from "../lib/shell-context";
import { useSidebar } from "../lib/sidebar-context";
import { useLiveGeneration } from "../lib/use-live-generation";
import { useScrollPin } from "../lib/use-scroll-pin";
import type { Command } from "./CommandMenu";
import { Composer, type ModelChoice } from "./Composer";
import { preloadDialogs, useConversationActions } from "./ConversationActions";
import { Markdown } from "./Markdown";
import { Message, Reasoning, type MessageAction } from "./Message";

// Interaction-only UI loads on demand (Phase 9): the title menu shows a
// same-looking placeholder until its chunk arrives; the malformed-state
// dialog loads only when needed.
const TitleMenu = lazy(() => import("./Menus").then((m) => ({ default: m.TitleMenu })));
const ConfirmDialog = lazy(() => preloadDialogs().then((m) => ({ default: m.ConfirmDialog })));
// The inline message editor loads on the first edit (Phase 13a).
const MessageEditor = lazy(() =>
  import("./MessageEditor").then((m) => ({ default: m.MessageEditor })),
);
// The image viewer loads on the first click of a thumbnail (Phase 12).
const ImageViewer = lazy(() => import("./ImageViewer").then((m) => ({ default: m.ImageViewer })));

const USER_ACTIONS: readonly MessageAction[] = ["edit", "delete"];
const USER_UNANSWERED_ACTIONS: readonly MessageAction[] = ["edit", "regenerate", "delete"];
const REPLY_ACTIONS: readonly MessageAction[] = ["regenerate"];
const NO_ACTIONS: readonly MessageAction[] = [];

/** An uploaded attachment shown in an optimistic or queued message. */
function asMessageAttachment(dto: AttachmentDto): MessageAttachmentDto {
  return {
    id: dto.id,
    missing: false,
    filename: dto.filename,
    mediaType: dto.mediaType,
    kind: dto.kind,
    size: dto.size,
    width: dto.width,
    height: dto.height,
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

/** Sets the message box as if typed (the composer's input handler runs). */
function setBox(el: HTMLTextAreaElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The empty-chat greeting: the page heading on a new chat. */
function Greeting({ level, text }: { level: 1 | 2; text: string }) {
  return level === 1 ? <h1 className="greeting">{text}</h1> : <h2 className="greeting">{text}</h2>;
}

/**
 * One conversation (or the /chat/new draft). Server-owned state only: the
 * transcript comes from the conversation query, the running reply from the
 * generation's SSE stream, optimistic user messages from send mutations;
 * everything reconciles by server-issued ids. Messages sent while a reply
 * runs wait in the shell's queue and go out one at a time afterwards.
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
  const {
    visible: sidebarVisible,
    show: showSidebar,
    narrow,
    drawerOpen,
    setDrawerTrigger,
    warmDrawer,
  } = useSidebar();
  const username = useAuth().session?.user?.username;
  const actions = useConversationActions(userId);
  const draftKey = conversationId ?? NEW_DRAFT;
  const queued = useQueue(draftKey);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleTriggerRef = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmUsed, setConfirmUsed] = useState(false);
  // The title placeholder was clicked before the menu chunk arrived.
  const [titleMenuRequested, setTitleMenuRequested] = useState(false);
  // Attachments on the composer (tab memory, per draft) and the open image viewer.
  const tray = useTray(userId, draftKey);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{
    items: readonly MessageAttachmentDto[];
    index: number;
    /** The thumbnail that opened it: focus returns there on close. */
    trigger: HTMLElement | null;
  } | null>(null);
  // Conversation operations (Phase 13a): the message being edited, the
  // operation awaiting confirmation, and whether one is in flight.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmOp, setConfirmOp] = useState<{
    kind: "delete" | "regenerate";
    userMessageId: string;
    latest: boolean;
    trigger: HTMLElement;
  } | null>(null);
  const [opsUsed, setOpsUsed] = useState(false);
  const [mutating, setMutating] = useState(false);
  const actionHandler = useRef<(a: MessageAction, id: string, t: HTMLElement) => void>(
    () => undefined,
  );
  // Stable for the memoized messages; the latest handler is installed after render.
  const onMessageAction = useCallback((action: MessageAction, id: string, t: HTMLElement) => {
    actionHandler.current(action, id, t);
  }, []);
  const openImage = useCallback(
    (items: readonly MessageAttachmentDto[], index: number, trigger: HTMLElement) => {
      setViewer({ items, index, trigger });
    },
    [],
  );

  const conversationQuery = useQuery({
    ...queries.conversation(userId, conversationId ?? ""),
    enabled: conversationId !== undefined && !props.initialError,
  });
  const modelsQuery = useQuery(queries.models(userId));
  // The sidebar's list (same cache entry): whether this conversation is pinned.
  const listQuery = useQuery({ ...queries.conversations(userId), enabled: hydrated });
  const pinned =
    typeof listQuery.data?.find((c) => c.id === conversationId)?.pinnedRank === "number";
  // Skills are only needed once the user types "/": never a startup request.
  const [wantSkills, setWantSkills] = useState(false);
  const skillsQuery = useQuery({ ...queries.skills(userId), enabled: wantSkills });
  const conversation: ConversationDto | undefined = conversationQuery.data;
  const loadError =
    conversationQuery.error instanceof ApiError
      ? conversationQuery.error
      : conversationQuery.data === undefined && props.initialError
        ? new ApiError(props.initialError.status, props.initialError.code, "")
        : null;

  /**
   * Puts queued messages back into the box, in order and before any draft
   * (Stop, a failed reply, or a rejected send whose text is `first`).
   */
  function restoreQueue(reason: string | null, first?: string) {
    const queuedItems = shell.takeQueue(draftKey);
    for (const item of queuedItems) restoreReady(userId, draftKey, item.attachments ?? []);
    const texts = [...(first !== undefined ? [first] : []), ...queuedItems.map((m) => m.content)];
    const el = textareaRef.current;
    if (texts.length === 0 || !el) return;
    setBox(el, [...texts, el.value].filter((t) => t !== "").join("\n\n"));
    if (reason) setStatus(reason);
  }

  const { live, observedId, started } = useLiveGeneration({
    userId,
    conversationId,
    serverActive: conversation?.activeGeneration?.generationId ?? null,
    disabled: props.inert === true,
    onTerminal: (state) => {
      if (state === "failed" || state === "timed_out")
        restoreQueue("The reply did not finish, so your queued messages are back in the box.");
    },
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
      if (!(error instanceof SendRejectedError)) return;
      if (!shell.getDraft(vars.conversationKey)) shell.setDraft(vars.conversationKey, vars.content);
      // Rejected before acceptance: the attachments are still pending, back on the composer.
      restoreReady(vars.userId, vars.conversationKey, vars.attachments ?? []);
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
  // messages, the live reply appearing, its state line, its growing text and
  // queued messages.
  const contentVersion = [
    conversation?.messages.length ?? 0,
    optimistic.map(({ state }) => `${state.variables?.tempId ?? ""}:${state.status}`).join(","),
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
    reveal,
  } = useScrollPin<HTMLDivElement>(contentVersion);

  // A search result opens `/chat/:id#m-<message id>`: show and mark that message once.
  const revealed = useRef<string | null>(null);
  const hash = location.hash;
  const loaded = conversation !== undefined;
  useEffect(() => {
    const match = /^#m-([0-9a-f-]{36})$/.exec(hash);
    if (!match || !loaded || revealed.current === hash) return;
    const element = document.getElementById(`m-${match[1] ?? ""}`);
    if (!element) return;
    revealed.current = hash;
    reveal(element);
    element.classList.add("search-hit");
    const timer = setTimeout(() => {
      element.classList.remove("search-hit");
    }, 2500);
    return () => {
      clearTimeout(timer);
    };
  }, [hash, loaded, reveal]);

  const lastReply = [...(conversation?.messages ?? [])]
    .reverse()
    .find((m) => m.role === "assistant");

  function send(
    content: string,
    choice: ModelChoice,
    fromBox: boolean,
    attachments: AttachmentDto[] = [],
  ) {
    const vars = newSendVariables({
      userId,
      conversationKey: draftKey,
      ...(conversationId ? { conversationId } : {}),
      providerId: choice[0],
      model: choice[1],
      content,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    setAttachNotice(null);
    // The optimistic message is visible immediately; the composer is cleared.
    if (fromBox) {
      if (textareaRef.current) setBox(textareaRef.current, "");
      shell.clearDraft(draftKey);
    }
    setStatus(null);
    sendMutation.mutate(vars, {
      // Only while this view is still mounted.
      onSuccess: (result) => {
        started(result);
        if (result.conversationId !== conversationId) {
          // Messages queued on the draft follow it into the new conversation.
          shell.moveQueue(draftKey, result.conversationId);
          moveTray(userId, draftKey, result.conversationId);
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
          // It and anything queued after it go back to the box.
          const el = textareaRef.current;
          if (el?.value.includes(vars.content)) restoreQueue(null);
          else restoreQueue(null, vars.content);
        }
      },
    });
  }

  /** The composer's Send/Enter: send now, or queue while a reply is running. */
  function submit(content: string, choice: ModelChoice) {
    const attachments = takeReady(userId, draftKey);
    if (running || sending) {
      shell.enqueue(draftKey, {
        id: crypto.randomUUID(),
        content,
        pair: choice,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      const el = textareaRef.current;
      if (el) setBox(el, "");
      shell.clearDraft(draftKey);
      return;
    }
    send(content, choice, true, attachments);
  }

  /** Files picked, pasted or dropped: upload now with the current limits and preference. */
  function attach(files: File[]) {
    void (async () => {
      const [limits, preferences] = await Promise.all([
        client.query({ ...queries.attachmentLimits(userId), staleTime: 30_000 }).catch(() => null),
        client.query({ ...queries.preferences(userId), staleTime: 30_000 }).catch(() => null),
      ]);
      setAttachNotice(
        addFiles(userId, draftKey, files, {
          maxPerMessage: limits?.maxPerMessage ?? 10,
          maxFileBytes: limits?.maxFileBytes ?? 20 * 1024 * 1024,
          imageMaxEdge: preferences?.imageMaxEdge ?? null,
          onUploaded: () => {
            void client.invalidateQueries({ queryKey: queryKeys.attachmentLimits(userId) });
          },
        }),
      );
    })();
  }

  // Drain the queue: the next message goes out once the reply has finished
  // and the stored transcript is back (so it follows the reply it answers).
  const sendNextQueued = useEffectEvent(() => {
    const next = shell.getQueue(draftKey)[0];
    if (!next) return;
    shell.removeQueued(draftKey, next.id);
    send(next.content, next.pair, false, next.attachments ?? []);
  });
  const hasQueued = queued.length > 0;
  const transcriptReady = conversationId === undefined || conversation !== undefined;
  useEffect(() => {
    if (!hasQueued || running || sending || props.inert || !hydrated || !transcriptReady) return;
    // Next task, so a re-render before the send starts cancels it (no double send).
    const timer = setTimeout(sendNextQueued, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [hasQueued, running, sending, props.inert, hydrated, transcriptReady]);

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

  function runCommand(name: string) {
    switch (name) {
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

  // Which user turn each regular reply answers, and which turns are unanswered.
  const answers = new Map<string, string>();
  const unanswered = new Set<string>();
  conversation?.messages.forEach((message, index, all) => {
    const next = all[index + 1];
    if (message.role !== "user") return;
    if (next?.role === "assistant") answers.set(next.id, message.id);
    else unanswered.add(message.id);
  });
  const opsDisabled = !hydrated || running || sending || mutating || props.inert === true;

  /** The (provider, model) a regeneration uses: the composer's, else the last reply's. */
  function regenerationModel(): ModelChoice | null {
    const remembered = shell.getModel(draftKey);
    if (remembered) return remembered;
    if (lastReply?.provider && lastReply.model) return [lastReply.provider, lastReply.model];
    const first = modelsQuery.data?.providers.flatMap((g) => g.models)[0];
    return first ? [first.providerId, first.id] : null;
  }

  function operationFailed(error: unknown) {
    if (error instanceof AccountChangedError) return;
    const message =
      error instanceof ApiError || error instanceof SendRejectedError
        ? error.message
        : "The change couldn’t be made. Try again.";
    setStatus(message);
    void client.invalidateQueries({
      queryKey: queryKeys.conversation(userId, conversationId ?? ""),
    });
  }

  async function regenerate(userMessageId: string, expectedRevision: string) {
    const choice = regenerationModel();
    if (!conversationId || !choice) return;
    const vars = newRegenerateVariables({
      userId,
      conversationId,
      userMessageId,
      providerId: choice[0],
      model: choice[1],
      expectedRevision,
    });
    const result = await regenerateWithRetries(vars);
    markAccepted(result.generationId, result.conversationId);
    started(result);
    await client.invalidateQueries({ queryKey: queryKeys.conversation(userId, conversationId) });
  }

  async function runOperation(fn: () => Promise<void>) {
    setMutating(true);
    setStatus(null);
    try {
      await fn();
    } catch (error) {
      operationFailed(error);
    } finally {
      setMutating(false);
    }
  }

  async function saveEdit(messageId: string, content: string, andRegenerate: boolean) {
    if (!conversation || !conversationId) return;
    await runOperation(async () => {
      const dto = await apiJson<ConversationDto>(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ content, expectedRevision: conversation.revision }),
        },
      );
      client.setQueryData(queryKeys.conversation(userId, conversationId), dto);
      setEditingId(null);
      // Edit and resubmit = edit, then regenerate on the returned revision (§4.2).
      if (andRegenerate) await regenerate(messageId, dto.revision);
    });
    void client.invalidateQueries({ queryKey: queryKeys.conversations(userId) });
  }

  async function confirmOperation() {
    const op = confirmOp;
    if (!op || !conversation || !conversationId) return;
    await runOperation(async () => {
      if (op.kind === "regenerate") {
        await regenerate(op.userMessageId, conversation.revision);
        return;
      }
      const dto = await apiJson<ConversationDto>(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(op.userMessageId)}?expectedRevision=${conversation.revision}`,
        { method: "DELETE" },
      );
      client.setQueryData(queryKeys.conversation(userId, conversationId), dto);
    });
    void client.invalidateQueries({ queryKey: queryKeys.conversations(userId) });
  }

  const handleAction = (action: MessageAction, messageId: string, trigger: HTMLElement) => {
    if (opsDisabled) return;
    if (action === "edit") {
      setEditingId(messageId);
      return;
    }
    const userMessageId =
      action === "regenerate" ? (answers.get(messageId) ?? messageId) : messageId;
    const index = conversation?.messages.findIndex((m) => m.id === messageId) ?? -1;
    const latest = index >= (conversation?.messages.length ?? 0) - 1;
    setOpsUsed(true);
    setConfirmOp({ kind: action, userMessageId, latest, trigger });
  };
  // Installs the latest handler after every render (the callback above stays stable).
  useLayoutEffect(() => {
    actionHandler.current = handleAction;
  });

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
      <main className="chat empty-state" data-testid="missing-state" inert={props.inert}>
        <h1>This conversation does not exist</h1>
        <p>It may have been deleted.</p>
        <Link to={paths.newChat()}>Start a new chat</Link>
      </main>
    );
  }

  const loading =
    conversationId !== undefined && conversationQuery.isPending && !props.initialError;
  const fetchError =
    conversationQuery.isError && !loadError?.code ? conversationQuery.error : undefined;
  const empty =
    !loading &&
    !fetchError &&
    (conversationId === undefined || conversation?.messages.length === 0) &&
    !showLive &&
    optimistic.length === 0 &&
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
    ...(skillsQuery.data ?? [])
      .filter((skill) => skill.enabled)
      .map((skill) => ({
        name: skill.name,
        description: skill.description || "Skill",
        kind: "skill" as const,
      })),
  ];

  return (
    <main
      className={`chat${empty ? " chat-empty" : ""}`}
      data-testid="conversation"
      inert={props.inert}
    >
      <header className="chat-header app-header">
        {sidebarVisible ? null : (
          <span className="header-nav">
            <button
              ref={setDrawerTrigger}
              type="button"
              className="icon-btn"
              aria-label={narrow ? "Open conversations" : "Show sidebar"}
              aria-expanded={narrow ? drawerOpen : false}
              aria-controls={narrow ? undefined : "sidebar"}
              aria-haspopup={narrow ? "dialog" : undefined}
              title={narrow ? "Conversations" : "Show sidebar"}
              // Warm the drawer chunk on intent (touch or mouse), never required.
              onPointerDown={warmDrawer}
              onFocus={() => {
                if (narrow) warmDrawer();
              }}
              onClick={showSidebar}
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
            <Suspense
              fallback={
                <button
                  type="button"
                  className="title-trigger"
                  onClick={() => {
                    setTitleMenuRequested(true);
                  }}
                >
                  <span className="title-text">{conversation.title}</span>
                  <ChevronDown size={16} aria-hidden />
                </button>
              }
            >
              <TitleMenu
                title={conversation.title}
                pinned={pinned}
                onTogglePin={() => {
                  actions.togglePin({ ...conversation, pinned });
                }}
                defaultOpen={titleMenuRequested}
                triggerRef={titleTriggerRef}
                onOpen={() => void preloadDialogs()}
                onRename={() => {
                  actions.rename(conversation, titleTriggerRef.current);
                }}
                onDelete={() => {
                  actions.remove(conversation, titleTriggerRef.current);
                }}
              />
            </Suspense>
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
        aria-busy={loading}
        data-testid="transcript"
      >
        {empty ? (
          <Greeting
            level={conversation ? 2 : 1}
            text={username ? `How can I help, ${username}?` : "How can I help?"}
          />
        ) : null}
        <ol className="history" aria-label="Messages">
          {conversation?.messages.map((message) => (
            <Message
              key={message.id}
              messageId={message.id}
              role={message.role}
              content={message.content}
              reasoning={message.reasoning}
              status={message.status}
              attachments={message.attachments}
              onOpenImage={openImage}
              actions={
                message.role === "user"
                  ? unanswered.has(message.id)
                    ? USER_UNANSWERED_ACTIONS
                    : USER_ACTIONS
                  : answers.has(message.id)
                    ? REPLY_ACTIONS
                    : NO_ACTIONS
              }
              actionsDisabled={opsDisabled}
              onAction={onMessageAction}
              editor={
                editingId === message.id ? (
                  <Suspense fallback={null}>
                    <MessageEditor
                      initial={message.content}
                      busy={mutating}
                      onCancel={() => {
                        setEditingId(null);
                      }}
                      onSave={(content, andRegenerate) =>
                        void saveEdit(message.id, content, andRegenerate)
                      }
                    />
                  </Suspense>
                ) : undefined
              }
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
                    setBox(el, text);
                    el.focus();
                  }
                }}
              />
            ) : null,
          )}
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
              {item.attachments?.length ? (
                <MessageAttachments
                  items={item.attachments.map(asMessageAttachment)}
                  onOpenImage={openImage}
                />
              ) : null}
              {item.content ? (
                <div className="bubble">
                  <p className="plain-text">{item.content}</p>
                </div>
              ) : null}
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
        {loading ? (
          <p className="placeholder" data-testid="transcript-loading">
            Loading conversation…
          </p>
        ) : fetchError ? (
          <div className="placeholder" role="alert" data-testid="transcript-error">
            <p>This conversation couldn’t be loaded.</p>
            <button
              type="button"
              className="secondary"
              onClick={() => void conversationQuery.refetch()}
            >
              Try again
            </button>
          </div>
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
        commands={commands}
        onSubmit={submit}
        onCommand={runCommand}
        onCommandIntent={() => {
          setWantSkills(true);
        }}
        onCancel={() => void cancel()}
        attachments={tray}
        attachNotice={attachNotice}
        onAttach={attach}
        onRemoveAttachment={(localId) => {
          removeAttachment(userId, draftKey, localId);
        }}
      />
      {actions.dialogs}
      {opsUsed ? (
        <Suspense fallback={null}>
          <ConfirmDialog
            open={confirmOp !== null}
            onOpenChange={(open) => {
              if (!open) setConfirmOp(null);
            }}
            title={confirmOp?.kind === "delete" ? "Delete this message?" : "Regenerate the reply?"}
            description={
              confirmOp?.kind === "delete"
                ? "The message and its reply will be deleted. Later replies may refer to it."
                : confirmOp?.latest
                  ? "The current reply will be replaced."
                  : "The current reply will be replaced, and every later message in this chat removed."
            }
            confirmLabel={confirmOp?.kind === "delete" ? "Delete" : "Regenerate"}
            returnFocus={() => confirmOp?.trigger ?? null}
            onConfirm={() => void confirmOperation()}
          />
        </Suspense>
      ) : null}
      {viewer ? (
        <Suspense fallback={null}>
          <ImageViewer
            items={viewer.items}
            index={viewer.index}
            onClose={() => {
              const trigger = viewer.trigger;
              setViewer(null);
              requestAnimationFrame(() => {
                if (trigger?.isConnected) trigger.focus();
              });
            }}
          />
        </Suspense>
      ) : null}
    </main>
  );
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
      className={`turn turn-user turn-pending${unknown ? " unknown" : ""}`}
      data-testid="message-pending"
      data-temp-id={props.vars.tempId}
      aria-busy={props.status === "pending"}
    >
      <span className="visually-hidden">You</span>
      {props.vars.attachments?.length ? (
        <MessageAttachments items={props.vars.attachments.map(asMessageAttachment)} />
      ) : null}
      {props.vars.content ? (
        <div className="bubble">
          <p className="plain-text">{props.vars.content}</p>
        </div>
      ) : null}
      {props.status === "pending" ? <span className="queued-meta">Sending…</span> : null}
      {unknown ? (
        <div className="pending-actions" role="alert">
          <span className="badge status-failed">Outcome unknown</span>
          <p>
            {notFound
              ? "The server has no record of this message. It was probably not saved."
              : "We couldn’t confirm whether this message was saved. Refresh the conversation to check."}
          </p>
          <div className="pending-buttons">
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
        </div>
      ) : null}
    </li>
  );
}
