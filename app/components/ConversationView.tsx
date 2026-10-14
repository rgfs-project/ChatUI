import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type Mutation,
} from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Code,
  Download,
  Ellipsis,
  FileText,
  FolderClosed,
  GripVertical,
  Lightbulb,
  PanelLeft,
  Pencil,
  PenLine,
  Pin,
  PinOff,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { MessageArtifactDto } from "@shared/artifacts";
import type { AttachmentDto, MessageAttachmentDto } from "@shared/attachments";
import type { ConversationDto } from "@shared/conversations";
import { isTerminalState, type GenerationState } from "@shared/generation-state";
import type { StartGenerationResponse } from "@shared/generations";
import { announce } from "../lib/announcer";
import { AccountChangedError } from "../lib/api";
import {
  addFiles,
  moveTray,
  removeAttachment,
  restoreReady,
  takeReady,
  useTray,
} from "../lib/attachments";
import { authStore } from "../lib/auth-store";
import { menuRequest, type MenuRequest } from "../lib/menu-request";
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
import { formatSeparator, separatorsBefore } from "../lib/time-separators";
import { useLiveGeneration } from "../lib/use-live-generation";
import { useScrollPin } from "../lib/use-scroll-pin";
import { preloadDialogs, useChatActions } from "./ChatActions";
import type { Command } from "./CommandMenu";
import { Composer, type ModelChoice } from "./Composer";
import { helpItems, useHelp } from "./HelpEntry";
import { Markdown } from "./Markdown";
import { Message, Reasoning, type MessageAction } from "./Message";
import { MessageAttachments } from "./MessageAttachments";
import type { MenuItems } from "./Menus";
import { Spinner } from "./Spinner";

// Interaction-only UI loads on demand: never in the critical chat bundle.
const HeaderMenu = lazy(() => import("./Menus").then((m) => ({ default: m.HeaderMenu })));
const ConfirmDialog = lazy(() => preloadDialogs().then((m) => ({ default: m.ConfirmDialog })));
const MessageEditor = lazy(() =>
  import("./MessageEditor").then((m) => ({ default: m.MessageEditor })),
);
const ImageViewer = lazy(() => import("./ImageViewer").then((m) => ({ default: m.ImageViewer })));
const ArtifactPanel = lazy(() => import("./ArtifactPanel"));

const USER_ACTIONS: readonly MessageAction[] = ["edit", "delete"];
const USER_UNANSWERED_ACTIONS: readonly MessageAction[] = ["edit", "regenerate", "delete"];
const REPLY_ACTIONS: readonly MessageAction[] = ["regenerate", "edit", "delete"];
const NO_ACTIONS: readonly MessageAction[] = [];

/** An uploaded file shown in an optimistic or queued message. */
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

/**
 * "Today 10:22 PM" above a new sitting. In the viewer's locale and time zone,
 * so it fills in after hydration; the row keeps its height meanwhile.
 */
function TimeSeparator({ iso, hydrated }: { iso: string; hydrated: boolean }) {
  return (
    <li className="time-separator" data-testid="time-separator">
      <time dateTime={iso}>{hydrated ? formatSeparator(iso) : ""}</time>
    </li>
  );
}

/** What the live region says: a reply's start and end, never its tokens. */
const ANNOUNCEMENT: Record<GenerationState, string> = {
  pending: "Assistant is responding",
  streaming: "Assistant is responding",
  completed: "Response complete",
  cancelled: "Response cancelled",
  failed: "Response failed",
  timed_out: "Response failed: timed out",
};

const STATE_LABEL: Record<GenerationState, string> = {
  pending: "Waiting for the model…",
  streaming: "Generating…",
  completed: "Completed",
  cancelled: "Stopped",
  failed: "Failed",
  timed_out: "Timed out",
};

type SendMutation = Mutation<StartGenerationResponse, Error, SendVariables>;

/** This view's optimistic user messages, read from the send mutations. */
function usePendingSends(
  userId: string,
  draftKey: string,
  conversationId: string | undefined,
  sentHere: ReadonlySet<string>,
) {
  return useMutationState({
    filters: { mutationKey: queryKeys.sends(userId) },
    select: (mutation) => {
      const m = mutation as SendMutation;
      return { mutation: m, state: m.state };
    },
  }).filter(({ state }) => {
    const vars = state.variables;
    if (!vars) return false;
    // A rejected send rolls back: its text goes back into the composer.
    if (state.status === "error" && !(state.error instanceof SendUnknownError)) return false;
    // Once accepted, a send belongs to the conversation the server named. A
    // draft keeps showing its own first send until the route switches to that
    // conversation, so the transcript never blanks during the navigation.
    if (state.data)
      return conversationId === undefined
        ? sentHere.has(vars.tempId)
        : state.data.conversationId === conversationId;
    return vars.conversationKey === draftKey;
  });
}

/** Sets the message box as if typed (the composer's input handler runs). */
function setBox(el: HTMLTextAreaElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Starters under the empty composer: each fills the box with a prompt to finish. */
const STARTERS = [
  { label: "Help me write", prompt: "Help me write ", icon: <PenLine size={18} aria-hidden /> },
  { label: "Code", prompt: "Help me with this code: ", icon: <Code size={18} aria-hidden /> },
  {
    label: "Brainstorm",
    prompt: "Brainstorm ideas for ",
    icon: <Lightbulb size={18} aria-hidden />,
  },
  { label: "Summarize", prompt: "Summarize this: ", icon: <FileText size={18} aria-hidden /> },
] as const;

/**
 * Messages typed while a reply runs, in a card above the composer: sent in
 * order once it finishes. Each can be sent now (stopping the reply), edited
 * back in the box, or removed.
 */
function QueueCard(props: {
  items: readonly { id: string; content: string; attachments?: readonly AttachmentDto[] }[];
  onSendNow: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <section className="queue" aria-label="Queued messages">
      <div className="queue-head">
        <span>{props.items.length} queued</span>
        <button type="button" className="btn ghost" onClick={props.onClear}>
          Clear all
        </button>
      </div>
      <ol>
        {props.items.map((item) => {
          const files = item.attachments?.length ?? 0;
          const text = item.content || `${String(files)} attachment${files === 1 ? "" : "s"}`;
          return (
            <li key={item.id} className="queue-item" data-testid="message-queued">
              <GripVertical size={16} aria-hidden />
              <span className="queue-text">
                <span className="visually-hidden">Queued: </span>
                {text}
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label="Send now"
                title="Stop the reply and send this now"
                onClick={() => {
                  props.onSendNow(item.id);
                }}
              >
                <ArrowUp size={16} aria-hidden />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Edit queued message"
                title="Edit"
                onClick={() => {
                  props.onEdit(item.id);
                }}
              >
                <Pencil size={16} aria-hidden />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Remove queued message"
                title="Remove"
                onClick={() => {
                  props.onRemove(item.id);
                }}
              >
                <X size={16} aria-hidden />
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * One conversation, or the /chat/new draft. Server-owned state only: the
 * transcript from the conversation query, the running reply from its SSE
 * stream, optimistic user messages from send mutations, all reconciled by
 * server-issued ids. Messages sent while a reply runs wait in the shell's
 * queue and go out one at a time afterwards.
 */
export function ConversationView(props: {
  userId: string;
  conversationId?: string | undefined;
  /** A new chat started from a project's page goes into that project. */
  projectId?: string | undefined;
  inert?: boolean;
  /** A server-side load error, so missing/malformed states render before JS. */
  initialError?: { status: number; code: string } | null;
}) {
  const { userId, conversationId } = props;
  const hydrated = useHydrated();
  const navigate = useNavigate();
  const location = useLocation();
  const client = useQueryClient();
  const shell = useShell();
  const { show: showSidebar, narrow, drawerOpen, setDrawerTrigger, warmDrawer } = useSidebar();
  const actions = useChatActions(userId);
  const help = useHelp(userId);
  const draftKey = conversationId ?? NEW_DRAFT;
  const projects = useQuery({ ...queries.projects(userId), enabled: Boolean(props.projectId) });
  const draftProject = conversationId
    ? undefined
    : projects.data?.find((p) => p.id === props.projectId);
  const queued = useQueue(draftKey);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const headerTriggerRef = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmUsed, setConfirmUsed] = useState(false);
  const [headerMenu, setHeaderMenu] = useState<MenuRequest>(false);
  const [headerMenuUsed, setHeaderMenuUsed] = useState(false);
  const tray = useTray(userId, draftKey);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{
    items: readonly MessageAttachmentDto[];
    index: number;
    trigger: HTMLElement | null;
  } | null>(null);
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
    [setViewer],
  );
  const [openArtifact, setOpenArtifact] = useState<{
    artifact: MessageArtifactDto;
    trigger: HTMLElement;
  } | null>(null);
  const onOpenArtifact = useCallback(
    (artifact: MessageArtifactDto, trigger: HTMLElement) => {
      setOpenArtifact({ artifact, trigger });
    },
    [setOpenArtifact],
  );

  const conversationQuery = useQuery({
    ...queries.conversation(userId, conversationId ?? ""),
    enabled: conversationId !== undefined && !props.initialError,
  });
  const modelsQuery = useQuery(queries.models(userId));
  // The sidebar's list (same cache entry): is this chat pinned?
  const listQuery = useQuery({ ...queries.conversations(userId), enabled: hydrated });
  const pinned =
    typeof listQuery.data?.find((c) => c.id === conversationId)?.pinnedRank === "number";
  // Skills are needed only once "/" is typed: never a startup request.
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
   * Puts queued messages back in the box, in order and before any draft (Stop,
   * a failed reply, or a rejected send whose text is `first`).
   */
  function restoreQueue(reason: string | null, first?: string) {
    const items = shell.takeQueue(draftKey);
    for (const item of items) restoreReady(userId, draftKey, item.attachments ?? []);
    const texts = [...(first !== undefined ? [first] : []), ...items.map((m) => m.content)];
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

  // The loader saw no session (a client navigation after expiry): sign in again.
  const unauthenticated = props.initialError?.status === 401;
  useEffect(() => {
    if (unauthenticated) authStore.expire();
  }, [unauthenticated]);

  // Drafts live in tab memory per conversation and survive navigation.
  useEffect(() => {
    const el = textareaRef.current;
    if (el?.value === "") el.value = shell.getDraft(draftKey);
  }, [draftKey, shell]);

  const sendMutation = useMutation({
    mutationKey: queryKeys.sends(userId),
    mutationFn: (vars: SendVariables) => sendWithRetries(vars),
    // Runs even after this view unmounts: a rejected message returns to its draft.
    onError: (error, vars) => {
      if (!(error instanceof SendRejectedError)) return;
      if (!shell.getDraft(vars.conversationKey)) shell.setDraft(vars.conversationKey, vars.content);
      restoreReady(vars.userId, vars.conversationKey, vars.attachments ?? []);
    },
    onSuccess: (result, vars) => {
      markAccepted(result.generationId, result.conversationId);
      shell.setModel(result.conversationId, [vars.providerId, vars.model]);
      void client.invalidateQueries({ queryKey: queryKeys.conversations(userId) });
    },
  });
  // Sends made by this view instance (a draft's first send, see usePendingSends).
  const [sentHere] = useState(() => new Set<string>());
  const pending = usePendingSends(userId, draftKey, conversationId, sentHere);

  const visibleId = props.inert ? undefined : conversation?.id;
  useEffect(() => {
    if (visibleId)
      markOnce("chatui:conversation-visible", visibleId, { conversationId: visibleId });
  }, [visibleId]);
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

  const announcement = live && props.inert !== true ? ANNOUNCEMENT[live.state] : null;
  useEffect(() => {
    if (announcement) announce(announcement);
  }, [announcement]);

  const separators = useMemo(
    () => separatorsBefore(conversation?.messages ?? []),
    [conversation?.messages],
  );

  // The live reply stays until its stored copy is in the transcript.
  const storedIds = new Set(conversation?.messages.map((m) => m.id));
  const showLive =
    live !== null && (!isTerminalState(live.state) || !storedIds.has(live.assistantMessageId));
  const optimistic = pending.filter(
    ({ state }) => !(state.data && storedIds.has(state.data.userMessageId)),
  );
  const running = observedId !== null;
  const sending = pending.some(({ state }) => state.status === "pending");

  // Whatever changes the transcript's height keeps the view pinned to the end.
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
    spacerRef,
  } = useScrollPin<HTMLDivElement>(
    contentVersion,
    optimistic.map(({ state }) => state.variables?.tempId ?? "").join(","),
  );

  // A search result opens `/chat/:id#m-<id>`: show and mark that message once.
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
      ...(conversationId
        ? { conversationId }
        : props.projectId
          ? { projectId: props.projectId }
          : {}),
      providerId: choice[0],
      model: choice[1],
      content,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    sentHere.add(vars.tempId);
    setAttachNotice(null);
    if (fromBox) {
      if (textareaRef.current) setBox(textareaRef.current, "");
      shell.clearDraft(draftKey);
    }
    setStatus(null);
    sendMutation.mutate(vars, {
      onSuccess: (result) => {
        started(result);
        if (result.conversationId !== conversationId) {
          // Queued messages and files follow the draft into the new conversation.
          shell.moveQueue(draftKey, result.conversationId);
          moveTray(userId, draftKey, result.conversationId);
          // Replace the draft URL so Back doesn't bring the empty draft back (INV-53).
          void navigate(paths.chat(result.conversationId), { replace: true });
        } else {
          void client.invalidateQueries({
            queryKey: queryKeys.conversation(userId, result.conversationId),
          });
        }
      },
      onError: (error) => {
        if (error instanceof AccountChangedError) return;
        if (error instanceof SendRejectedError) {
          setStatus(error.message);
          const el = textareaRef.current;
          if (el?.value.includes(vars.content)) restoreQueue(null);
          else restoreQueue(null, vars.content);
        }
      },
    });
  }

  /** Send or Enter: now, or into the queue while a reply runs. */
  function submit(content: string, choice: ModelChoice) {
    const attachments = takeReady(userId, draftKey);
    // A second Enter in the same tick finds the box empty and the files taken.
    if (content === "" && attachments.length === 0) return;
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

  /** Picked, pasted or dropped files upload now, with the current limits. */
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

  // The queue drains once the reply has finished and the stored transcript is
  // back, so each message follows the reply it answers.
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
    // Next task: a re-render before the send starts cancels it (no double send).
    const timer = setTimeout(sendNextQueued, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [hasQueued, running, sending, props.inert, hydrated, transcriptReady]);

  async function stopGeneration() {
    if (!observedId) return;
    await apiJson(`/api/generations/${observedId}/cancel`, { method: "POST" }).catch(
      () => undefined,
    );
  }

  /** Stop: queued messages go back into the box too. */
  async function cancel() {
    restoreQueue(null);
    await stopGeneration();
  }

  /** Send now: this one goes first, and the running reply stops for it. */
  function sendNow(id: string) {
    shell.promoteQueued(draftKey, id);
    void stopGeneration();
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

  // Which user turn each reply answers, and which turns have no reply.
  const suggestionsByReply = groupByReply(conversation?.proposals);
  const artifactsByReply = groupByReply(conversation?.artifacts);
  const answers = new Map<string, string>();
  const unanswered = new Set<string>();
  conversation?.messages.forEach((message, index, all) => {
    const next = all[index + 1];
    if (message.role !== "user") return;
    if (next?.role === "assistant") answers.set(next.id, message.id);
    else unanswered.add(message.id);
  });
  const opsDisabled = !hydrated || running || sending || mutating || props.inert === true;

  /** The model a regeneration uses: the composer's, else the last reply's. */
  function regenerationModel(): ModelChoice | null {
    const remembered = shell.getModel(draftKey);
    if (remembered) return remembered;
    if (lastReply?.provider && lastReply.model) return [lastReply.provider, lastReply.model];
    const first = modelsQuery.data?.providers.flatMap((g) => g.models)[0];
    return first ? [first.providerId, first.id] : null;
  }

  function operationFailed(error: unknown) {
    if (error instanceof AccountChangedError) return;
    setStatus(
      error instanceof ApiError || error instanceof SendRejectedError
        ? error.message
        : "The change couldn’t be made. Try again.",
    );
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

  async function saveEdit(messageId: string, content: string) {
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
      await regenerate(messageId, dto.revision);
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
    // A reply's edit and delete act on the prompt it answers.
    const userMessageId = answers.get(messageId) ?? messageId;
    if (action === "edit") {
      setEditingId(userMessageId);
      return;
    }
    const index = conversation?.messages.findIndex((m) => m.id === messageId) ?? -1;
    const latest = index >= (conversation?.messages.length ?? 0) - 1;
    setOpsUsed(true);
    setConfirmOp({ kind: action, userMessageId, latest, trigger });
  };
  useLayoutEffect(() => {
    actionHandler.current = handleAction;
  });
  // The first send glides the composer from the centred greeting down to its
  // dock (FLIP): measured after every commit, animated when "empty" ends.
  const dockRef = useRef<HTMLDivElement>(null);
  const dockWas = useRef<{ empty: boolean; top: number } | null>(null);
  useLayoutEffect(() => {
    const dock = dockRef.current;
    if (!dock) {
      dockWas.current = null;
      return;
    }
    const isEmpty = dock.closest(".chat-view")?.classList.contains("empty") ?? false;
    const top = dock.getBoundingClientRect().top;
    const was = dockWas.current;
    dockWas.current = { empty: isEmpty, top };
    if (!was?.empty || isEmpty || was.top === top) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    dock.animate([{ transform: `translateY(${String(was.top - top)}px)` }, { transform: "none" }], {
      duration: 420,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    });
  });

  if (loadError?.code === "CONVERSATION_MALFORMED") {
    return (
      <main className="chat-view empty-state" data-testid="malformed-state" inert={props.inert}>
        <h1>This conversation can’t be opened</h1>
        <p>
          Its file on the server isn’t valid ChatUI Markdown, so it can’t be shown or changed. The
          file is left untouched; you can delete it.
        </p>
        <button
          type="button"
          className="btn danger"
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
      <main className="chat-view empty-state" data-testid="missing-state" inert={props.inert}>
        <h1>This conversation does not exist</h1>
        <p>It may have been deleted.</p>
        <Link to={paths.newChat()} className="btn primary">
          Start a new chat
        </Link>
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

  const exportConversation = (id: string) => {
    // The exact canonical Markdown as a download (no attachments).
    const link = document.createElement("a");
    link.href = `/api/conversations/${encodeURIComponent(id)}/export`;
    link.download = "";
    link.click();
  };

  const headerItems: MenuItems = [
    ...(conversation
      ? ([
          {
            label: "Rename",
            icon: <Pencil size={20} aria-hidden />,
            onSelect: () => {
              actions.rename(conversation, headerTriggerRef.current);
            },
          },
          {
            label: pinned ? "Unpin" : "Pin",
            icon: pinned ? <PinOff size={20} aria-hidden /> : <Pin size={20} aria-hidden />,
            onSelect: () => {
              actions.togglePin({ ...conversation, pinned });
            },
          },
          {
            label: "Export as Markdown",
            icon: <Download size={20} aria-hidden />,
            onSelect: () => {
              exportConversation(conversation.id);
            },
          },
          {
            label: "Delete",
            icon: <Trash2 size={20} aria-hidden />,
            onSelect: () => {
              actions.remove(conversation, headerTriggerRef.current);
            },
          },
          "separator",
        ] satisfies MenuItems)
      : []),
    ...helpItems(help.open),
  ];
  const headerLabel = conversation ? `Actions for ${conversation.title}` : "More options";

  return (
    <main
      className={`chat-view${empty ? " empty" : ""}`}
      data-testid="conversation"
      inert={props.inert}
    >
      <header className="app-header">
        {narrow ? (
          <span className="header-nav">
            <button
              ref={setDrawerTrigger}
              type="button"
              className="icon-btn"
              aria-label="Open sidebar"
              aria-expanded={drawerOpen}
              aria-haspopup="dialog"
              title="Open sidebar"
              onPointerDown={warmDrawer}
              onFocus={warmDrawer}
              onClick={showSidebar}
            >
              <PanelLeft size={20} aria-hidden />
            </button>
          </span>
        ) : null}
        <div className="header-title">
          {conversation ? <h1 className="title-text">{conversation.title}</h1> : null}
        </div>
        <div className="header-actions">
          {narrow ? (
            <Link to={paths.newChat()} className="icon-btn" aria-label="New chat" title="New chat">
              <SquarePen size={20} aria-hidden />
            </Link>
          ) : null}
          {!narrow || conversation ? (
            headerMenuUsed ? (
              <Suspense
                fallback={
                  <button type="button" className="icon-btn title-trigger" aria-label={headerLabel}>
                    <Ellipsis size={20} aria-hidden />
                  </button>
                }
              >
                <HeaderMenu
                  label={headerLabel}
                  items={headerItems}
                  defaultOpen={headerMenu}
                  triggerRef={headerTriggerRef}
                  onOpen={() => void preloadDialogs()}
                />
              </Suspense>
            ) : (
              <button
                type="button"
                className="icon-btn title-trigger"
                aria-label={headerLabel}
                title="More options"
                onPointerEnter={() => void import("./Menus")}
                onClick={(event) => {
                  setHeaderMenu(menuRequest(event));
                  setHeaderMenuUsed(true);
                }}
              >
                <Ellipsis size={20} aria-hidden />
              </button>
            )
          ) : null}
        </div>
      </header>

      {/* Not a Tab stop itself: keyboard users reach its buttons, and the arrow
          keys scroll it from any of them. */}
      <div
        className="transcript"
        ref={transcriptRef}
        {...scrollHandlers}
        tabIndex={-1}
        role="region"
        aria-label="Transcript"
        aria-busy={loading}
        data-testid="transcript"
      >
        {empty ? (
          conversation ? (
            <h2 className="greeting">Hello! How can I help?</h2>
          ) : (
            <>
              {draftProject ? (
                <Link to={paths.projects(draftProject.id)} className="draft-project">
                  <FolderClosed size={16} aria-hidden /> {draftProject.name}
                </Link>
              ) : null}
              <h1 className="greeting">Hello! How can I help?</h1>
            </>
          )
        ) : null}
        <ol className="transcript-inner" aria-label="Messages" hidden={empty}>
          {conversation?.messages.map((message) => (
            <Fragment key={message.id}>
              {separators.has(message.id) ? (
                <TimeSeparator iso={separators.get(message.id) ?? ""} hydrated={hydrated} />
              ) : null}
              <Message
                messageId={message.id}
                role={message.role}
                content={message.content}
                reasoning={message.reasoning}
                status={message.status}
                attachments={message.attachments}
                onOpenImage={openImage}
                suggestions={suggestionsByReply.get(message.id)}
                artifacts={artifactsByReply.get(message.id)}
                onOpenArtifact={onOpenArtifact}
                userId={userId}
                conversationId={conversationId}
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
                        onSave={(content) => void saveEdit(message.id, content)}
                      />
                    </Suspense>
                  ) : undefined
                }
              />
            </Fragment>
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
            <li
              className={`turn turn-assistant live${running ? " streaming" : ""}`}
              data-testid="response"
              aria-busy={running}
            >
              <span className="visually-hidden">Assistant</span>
              {live.reasoning ? (
                <Reasoning
                  text={live.reasoning}
                  done={!running || live.content !== ""}
                  testId="reasoning"
                />
              ) : null}
              {/* Streaming Markdown block by block: unfinished fences and tables
                  render stably, and finished blocks keep their DOM. */}
              <div data-testid="content">
                <Markdown text={live.content} live growing={!isTerminalState(live.state)} />
              </div>
              {running && live.content === "" ? (
                <span className="thinking" role="status" aria-label="Generating a reply">
                  <span className="breathe" aria-hidden />
                </span>
              ) : null}
              {live.error ? (
                <div className="alert danger" role="alert">
                  <span className="alert-text">
                    {STATE_LABEL[live.state]} — {live.error.message}
                  </span>
                </div>
              ) : null}
              <p
                className={running || live.error ? "visually-hidden" : "status-line"}
                data-testid="generation-status"
              >
                {STATE_LABEL[live.state]}
                {live.error ? ` — ${live.error.message}` : ""}
              </p>
              {live.proposals.some((p) => p.status === "pending") ? (
                <p className="status-line" data-testid="memory-previews">
                  Memory suggestions to review when the reply finishes:{" "}
                  {live.proposals
                    .filter((p) => p.status === "pending")
                    .map((p) => `“${p.name}”`)
                    .join(", ")}
                </p>
              ) : null}
            </li>
          ) : null}
        </ol>
        <div ref={spacerRef} className="transcript-spacer" aria-hidden />
        {loading ? (
          <Spinner label="Loading conversation…" testId="transcript-loading" />
        ) : fetchError ? (
          <div
            className="alert danger transcript-error"
            role="alert"
            data-testid="transcript-error"
          >
            <span className="alert-text">This conversation couldn’t be loaded.</span>
            <button type="button" className="btn" onClick={() => void conversationQuery.refetch()}>
              Try again
            </button>
          </div>
        ) : null}
        {showJump ? (
          <div className="jump-anchor">
            <button
              type="button"
              className="btn"
              onClick={jumpToLatest}
              data-testid="jump-to-latest"
            >
              <ArrowDown size={16} aria-hidden /> Jump to latest
            </button>
          </div>
        ) : null}
      </div>
      <div className="composer-dock" ref={dockRef}>
        {queued.length > 0 ? (
          <QueueCard
            items={queued}
            onSendNow={sendNow}
            onEdit={(id) => {
              const item = queued.find((q) => q.id === id);
              const el = textareaRef.current;
              if (!item || !el) return;
              shell.removeQueued(draftKey, id);
              restoreReady(userId, draftKey, item.attachments ?? []);
              setBox(el, [item.content, el.value].filter((t) => t !== "").join("\n\n"));
              el.focus();
            }}
            onRemove={(id) => {
              shell.removeQueued(draftKey, id);
            }}
            onClear={() => {
              shell.takeQueue(draftKey);
            }}
          />
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
          manageModelsHref={
            authStore.get().session?.user?.role === "admin" ? paths.settings("models") : undefined
          }
        />
      </div>
      {empty ? (
        <div className="suggestions" data-testid="suggestions">
          {STARTERS.map((s) => (
            <button
              key={s.label}
              type="button"
              className="suggestion"
              onClick={() => {
                const el = textareaRef.current;
                if (!el) return;
                setBox(el, s.prompt);
                el.focus();
              }}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </div>
      ) : null}
      {actions.dialogs}
      {help.dialogs}
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
            tone={confirmOp?.kind === "delete" ? "danger" : "primary"}
            returnFocus={() => confirmOp?.trigger ?? null}
            onConfirm={() => void confirmOperation()}
          />
        </Suspense>
      ) : null}
      {openArtifact ? (
        <Suspense fallback={null}>
          <ArtifactPanel
            userId={userId}
            artifact={openArtifact.artifact}
            trigger={openArtifact.trigger}
            onClose={() => {
              setOpenArtifact(null);
            }}
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

/**
 * Items grouped by the reply that made them (suggestions, files). Cached per
 * query-data array, so each message keeps a stable prop and stays memoized
 * while another reply streams.
 */
const byReplyCache = new WeakMap<object, Map<string, unknown[]>>();
function groupByReply<T extends { assistantMessageId: string }>(
  items: readonly T[] | undefined,
): Map<string, T[]> {
  if (!items || items.length === 0) return new Map();
  const cached = byReplyCache.get(items);
  if (cached) return cached as Map<string, T[]>;
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const list = grouped.get(item.assistantMessageId) ?? [];
    list.push(item);
    grouped.set(item.assistantMessageId, list);
  }
  byReplyCache.set(items, grouped);
  return grouped;
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
      {props.status === "pending" ? <span className="status-line">Sending…</span> : null}
      {unknown ? (
        <div className="pending-note" role="alert">
          <span className="badge danger">Outcome unknown</span>
          <p>
            {notFound
              ? "The server has no record of this message. It was probably not saved."
              : "We couldn’t confirm whether this message was saved. Refresh the conversation to check."}
          </p>
          <div className="pending-buttons">
            <button
              type="button"
              className="btn sm"
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
                className="btn sm"
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
