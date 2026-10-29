import { ArrowDown, Trash2 } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Link } from "react-router";
import type { MessageDto } from "@shared/conversations";
import { useHydrated } from "../lib/hydrated";
import { useNonce } from "../lib/nonce";
import { paths } from "../lib/paths";
import { useRenderProbe } from "../lib/render-probe";
import { useUi } from "../lib/ui-context";
import { useChat } from "./chat-context";
import { Composer } from "./composer";
import { Header } from "./header";
import { LiveReply } from "./live-reply";
import { UserBubble } from "./message";
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
  const failure = result && !result.ok ? result.code : null;
  const { scrollerRef, contentRef, state, jumpToLatest } = useScrollIntent(conversationId ?? "new");
  const { jumpRef } = chat;
  useEffect(() => {
    jumpRef.current = jumpToLatest;
    return () => {
      jumpRef.current = null;
    };
  }, [jumpRef, jumpToLatest]);

  return (
    <div className={`chat-area${empty ? " is-empty" : ""}`}>
      <title>{conversation ? `${conversation.title} · ChatUI` : "ChatUI"}</title>
      <Header />
      <div className="scroller" id="transcript-scroller" ref={scrollerRef}>
        <div className="thread" ref={contentRef} data-testid="transcript">
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
                Its file is malformed. It can be deleted, but not opened or changed. Nothing in the
                file has been modified.
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
          <Transcript messages={messages} timeFormat={timeFormat} />
          {showPending ? <UserBubble content={pending.content} pending /> : null}
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
        {failure ? null : <Composer />}
        {empty && !chat.hasDraft ? <Suggestions /> : null}
      </div>
    </div>
  );
}
