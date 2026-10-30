import { ArrowDown, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { Link, useNavigation } from "react-router";
import type { MessageDto } from "@shared/conversations";
import { useHydrated } from "../lib/hydrated";
import { useNonce } from "../lib/nonce";
import { mark } from "../lib/perf";
import { conversationIdOfPath, paths } from "../lib/paths";
import { useRenderProbe } from "../lib/render-probe";
import { useUi } from "../lib/ui-context";
import { ErrorBoundary as AreaBoundary } from "../ui/error-boundary";
import { useChat } from "./chat-context";
import { Composer, useAddFiles } from "./composer";
import { Header } from "./header";
import { NoticeBanner } from "./notice";
import { LiveReply } from "./live-reply";
import { UserBubble } from "./message";
import { draftKey } from "./drafts";
import { ViewerProvider, type ViewerImage } from "./viewer";
import { useSearchMarks } from "./search-marks";
import { useScrollIntent } from "./scroll-intent";
import { Suggestions } from "./suggestions";
import { Transcript } from "./transcript";

const NO_MESSAGES: MessageDto[] = [];

const GREETINGS = [
  "Where should we begin?",
  "What's on your mind today?",
  "Ready when you are.",
  "What are we working on?",
];

/** Deterministic per day, so the server and hydration pick the same one. */
export function greetingFor(renderedAt: string): string {
  const day = Math.floor(new Date(renderedAt).getTime() / 86_400_000);
  return GREETINGS[(Number.isFinite(day) ? day : 0) % GREETINGS.length] ?? GREETINGS[0] ?? "";
}

/**
 * Runs while the server HTML is parsed, before first paint: an opened chat
 * starts at its latest message with no visible jump.
 */
const SCROLL_TO_LATEST =
  'var e=document.getElementById("transcript-scroller");if(e)e.scrollTop=e.scrollHeight;';

function ScrollToLatestOnLoad() {
  const nonce = useNonce();
  return (
    <script
      nonce={nonce}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: SCROLL_TO_LATEST }}
    />
  );
}

/** Chat-to-chat navigation that takes longer than this shows a spinner. */
const SWITCH_SPINNER_DELAY_MS = 250;

function useDelayedSwitch(): boolean {
  const navigation = useNavigation();
  const target = navigation.location?.pathname;
  const loadingChat =
    navigation.state === "loading" &&
    target !== undefined &&
    conversationIdOfPath(target) !== undefined;
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!loadingChat) return;
    const timer = setTimeout(() => {
      setShown(target);
    }, SWITCH_SPINNER_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [loadingChat, target]);
  return loadingChat && shown === target;
}

export function ChatView() {
  useRenderProbe("ChatView");
  const chat = useChat();
  const { timeFormat } = useUi();
  const hydrated = useHydrated();
  const { result, conversationId, pending } = chat;
  const conversation = result?.ok ? result.conversation : null;
  const messages = conversation?.messages ?? NO_MESSAGES;
  const storedIds = useMemo(() => new Set(messages.map((m) => m.id)), [messages]);
  const showPending =
    pending !== null &&
    pending.conversationId === conversationId &&
    !storedIds.has(pending.userMessageId ?? "");
  const empty = conversationId === null && !showPending;
  // Every image in the conversation, in order, for the viewer's previous/next.
  const images = useMemo(
    () =>
      [
        ...messages.flatMap((m) => m.attachments),
        ...(showPending ? pending.attachments : []),
      ].filter((ref): ref is ViewerImage => !ref.missing && ref.kind === "image"),
    [messages, pending, showPending],
  );
  const addFiles = useAddFiles(chat.userId, draftKey(chat.userId, conversationId));
  const [dragging, setDragging] = useState(false);
  const failure = result && !result.ok ? result.code : null;
  const { scrollerRef, contentRef, state, jumpToLatest } = useScrollIntent(conversationId ?? "new");
  const { jumpRef } = chat;
  const visible = conversation !== null;
  useSearchMarks(visible, conversationId);
  useEffect(() => {
    if (visible) mark("chatui:conversation-visible");
  }, [visible]);
  const switching = useDelayedSwitch();
  const modelCount = chat.groups.reduce((n, g) => n + g.models.length, 0);
  const allUnavailable =
    chat.groups.length > 0 && chat.groups.every((g) => g.provider.status === "unavailable");
  const modelNotice =
    chat.modelsState !== "ready"
      ? chat.modelsState === "error"
        ? "The model list could not be loaded."
        : null
      : allUnavailable
        ? "The model servers can't be reached right now."
        : modelCount === 0
          ? "No models are available. An admin needs to add a model server."
          : null;
  useEffect(() => {
    jumpRef.current = jumpToLatest;
    return () => {
      jumpRef.current = null;
    };
  }, [jumpRef, jumpToLatest]);

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  return (
    <ViewerProvider images={images}>
      <div
        className={`chat-area${empty ? " is-empty" : ""}${dragging ? " is-dropping" : ""}`}
        onDragEnter={(event) => {
          if (hasFiles(event) && !failure) setDragging(true);
        }}
        onDragOver={(event) => {
          if (!hasFiles(event) || failure) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          if (!hasFiles(event) || failure) return;
          event.preventDefault();
          setDragging(false);
          addFiles(Array.from(event.dataTransfer.files));
        }}
      >
        {dragging ? (
          <div className="drop-overlay" aria-hidden>
            <p>Drop files to attach them</p>
          </div>
        ) : null}
        <title>{conversation ? `${conversation.title} · ChatUI` : "ChatUI"}</title>
        <Header />
        <NoticeBanner userId={chat.userId} />
        {switching ? (
          <div className="switch-spinner" role="status" aria-label="Opening chat">
            <span className="spinner" aria-hidden />
          </div>
        ) : null}
        <div className="scroller" id="transcript-scroller" ref={scrollerRef}>
          <div
            className="thread"
            ref={contentRef}
            data-testid="transcript"
            data-running={chat.running ? "true" : undefined}
          >
            {failure === "NOT_FOUND" ? (
              <div className="chat-error" role="alert">
                <h1>This conversation does not exist.</h1>
                <p>It may have been deleted, or the link may be wrong.</p>
                <Link to={paths.newChat()} className="pill-button pill-primary">
                  Start a new chat
                </Link>
              </div>
            ) : null}
            {failure === "CONVERSATION_MALFORMED" && conversationId ? (
              <div className="chat-error" role="alert">
                <h1>This conversation can't be opened.</h1>
                <p>
                  Its file is malformed. It can be deleted, but not opened or changed. Nothing in
                  the file has been modified.
                </p>
                <button
                  type="button"
                  className="pill-button pill-danger"
                  disabled={!hydrated}
                  onClick={() => {
                    void chat.remove(conversationId, "this conversation");
                  }}
                >
                  <Trash2 size={16} aria-hidden /> Delete it
                </button>
              </div>
            ) : null}
            <AreaBoundary
              area="Transcript"
              onRetry={() => {
                void chat.checkPending();
              }}
            >
              <Transcript
                messages={messages}
                timeFormat={timeFormat}
                proposals={conversation?.proposals}
              />
            </AreaBoundary>
            {showPending ? (
              <UserBubble
                content={pending.content}
                attachments={pending.attachments}
                pending={pending.status}
                onCheck={() => {
                  void chat.checkPending();
                }}
              />
            ) : null}
            {chat.activeGenerationId && conversationId ? (
              <LiveReply
                userId={chat.userId}
                generationId={chat.activeGenerationId}
                conversationId={conversationId}
                storedIds={storedIds}
              />
            ) : null}
          </div>
        </div>
        {/* Server HTML only: after hydration the layout effect does this job. */}
        {conversation && !hydrated ? <ScrollToLatestOnLoad /> : null}
        <div className="dock">
          {state.hasNew && !state.pinned ? (
            <button
              type="button"
              className="jump-latest"
              aria-label="Jump to latest"
              onClick={jumpToLatest}
            >
              <ArrowDown size={18} aria-hidden />
            </button>
          ) : null}
          {empty ? <h1 className="greeting">{greetingFor(timeFormat.now)}</h1> : null}
          {!empty && !failure ? (
            <p className="disclaimer">ChatUI can make mistakes. Check important info.</p>
          ) : null}
          {modelNotice ? (
            <p className="composer-notice" role="status" data-testid="model-notice">
              {modelNotice}{" "}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  void chat.refreshModels();
                }}
              >
                Try again
              </button>
            </p>
          ) : null}
          {failure ? null : <Composer />}
          {empty && !chat.hasDraft ? <Suggestions /> : null}
        </div>
      </div>
    </ViewerProvider>
  );
}
