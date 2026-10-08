import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, PanelLeft, SquarePen } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { AttachmentDto, AttachmentKind, MessageAttachmentDto } from "@shared/attachments";
import type { MessageArtifactDto } from "@shared/artifacts";
import type { ConversationDto, MessageDto } from "@shared/conversations";
import { isTerminalState } from "@shared/generation-state";
import type { ProposalDto } from "@shared/memories";
import { api, ApiError, messageOf } from "../lib/api";
import { DEFAULT_IMAGE_MAX_EDGE } from "../lib/attachments";
import { useGeneration, type LiveReply } from "../lib/generation";
import { findModel, resolveModel, type ModelChoice } from "../lib/models";
import { paths } from "../lib/paths";
import {
  fetchConversation,
  keys,
  useAttachmentLimits,
  useConversation,
  useConversations,
  useModels,
  usePreferences,
  useSkills,
  type Preferences,
} from "../lib/query";
import { accept } from "../lib/send";
import { useShell } from "../lib/shell";
import { ArtifactPanel, type OpenArtifact } from "./ArtifactPanel";
import { Composer, type BuiltIn } from "./Composer";
import { useConversationActions } from "./ConversationActions";
import { AssistantMessage, UserMessage } from "./Message";
import { ProposalPreviews, Proposals } from "./Proposals";
import { ConfirmDialog, IconButton, Menu, MenuContent, MenuTrigger } from "./ui";

interface Pending {
  content: string;
  attachments: MessageAttachmentDto[];
}

function toMessageAttachment(a: AttachmentDto): MessageAttachmentDto {
  return {
    id: a.id,
    missing: false,
    filename: a.filename,
    mediaType: a.mediaType,
    kind: a.kind,
    size: a.size,
    width: a.width,
    height: a.height,
  };
}

function groupBy<T>(items: readonly T[] | undefined, key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items ?? []) {
    const k = key(item);
    map.set(k, [...(map.get(k) ?? []), item]);
  }
  return map;
}

/** The last reply's model, if any: a chat keeps using it. */
function lastModel(dto: ConversationDto | undefined): ModelChoice | null {
  const last = dto?.messages.findLast((m) => m.role === "assistant" && m.provider && m.model);
  return last?.provider && last.model ? { providerId: last.provider, model: last.model } : null;
}

/** Keeps the transcript at the bottom while the reader is there. */
function useStickToBottom(dependency: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [dependency]);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  const pin = useCallback(() => {
    pinned.current = true;
  }, []);
  return [ref, onScroll, pin] as const;
}

/** One chat: a new one (no id) or an existing conversation. */
export function ChatView(props: {
  conversationId?: string;
  inert?: boolean;
  /** The server already knows this chat can’t be loaded (missing or not yours). */
  missing?: boolean;
}) {
  const { conversationId } = props;
  const shell = useShell();
  const userId = shell.user.id;
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const conversation = useConversation(userId, conversationId);
  const list = useConversations(userId);
  const models = useModels(userId);
  const prefs = usePreferences(userId);
  const skills = useSkills(userId);
  const limits = useAttachmentLimits(userId);
  const actions = useConversationActions(userId);
  const dto = conversation.data;

  const [override, setOverride] = useState<ModelChoice | null>(null);
  const [localGeneration, setLocalGeneration] = useState<string | null>(
    (location.state as { generationId?: string } | null)?.generationId ?? null,
  );
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<OpenArtifact | null>(null);
  const [deleting, setDeleting] = useState<MessageDto | null>(null);
  const [busy, setBusy] = useState(false);

  const prefDefault =
    prefs.data?.defaultProvider && prefs.data.defaultModel
      ? { providerId: prefs.data.defaultProvider, model: prefs.data.defaultModel }
      : null;
  const model = resolveModel(models.data, [override, lastModel(dto), prefDefault]);
  const modelInfo = findModel(models.data, model);
  const kinds: AttachmentKind[] = (modelInfo?.capabilities.inputModalities ?? []).filter(
    (k): k is AttachmentKind => k === "image" || k === "audio",
  );

  // The server's running reply wins; one started here covers the moment
  // before the conversation is refetched (and a stale id after a reload).
  const observed = dto?.activeGeneration?.generationId ?? localGeneration;
  const live = useGeneration(userId, conversationId, observed);
  const generating = observed !== null && !(live && isTerminalState(live.state));

  // A finished reply stored in the conversation replaces the live one.
  if (
    localGeneration !== null &&
    live?.generationId === localGeneration &&
    isTerminalState(live.state) &&
    dto?.messages.some((m) => m.id === live.assistantMessageId)
  )
    setLocalGeneration(null);

  useEffect(() => {
    if (dto?.title) document.title = `${dto.title} · ChatUI`;
  }, [dto?.title]);

  const [scrollRef, onScroll, pinScroll] = useStickToBottom(
    `${String(dto?.messages.length)}:${live?.content.length ?? 0}:${pending ? 1 : 0}`,
  );

  async function refetch(id: string) {
    const fresh = await fetchConversation(id);
    client.setQueryData(keys.conversation(userId, id), fresh);
    void client.invalidateQueries({ queryKey: keys.conversations(userId) });
    return fresh;
  }

  async function send(message: {
    content: string;
    attachments: AttachmentDto[];
  }): Promise<boolean> {
    if (!model) return false;
    setNotice(null);
    pinScroll();
    setPending({
      content: message.content,
      attachments: message.attachments.map(toMessageAttachment),
    });
    try {
      const result = await accept("/api/generations", {
        ...(conversationId ? { conversationId } : {}),
        providerId: model.providerId,
        model: model.model,
        content: message.content,
        ...(message.attachments.length
          ? { attachmentIds: message.attachments.map((a) => a.id) }
          : {}),
      });
      if (!conversationId) {
        await refetch(result.conversationId).catch(() => undefined);
        await navigate(paths.chat(result.conversationId), {
          state: { generationId: result.generationId },
        });
        return true;
      }
      setLocalGeneration(result.generationId);
      await refetch(conversationId).catch(() => undefined);
      setPending(null);
      return true;
    } catch (error) {
      setPending(null);
      throw error;
    }
  }

  async function stop() {
    if (!observed) return;
    try {
      await api(`/api/generations/${encodeURIComponent(observed)}/cancel`, { method: "POST" });
    } catch (e) {
      setNotice(messageOf(e));
    }
  }

  async function regenerate(userMessageId: string, revision: string) {
    if (!conversationId || !model) return;
    setNotice(null);
    pinScroll();
    try {
      const result = await accept(
        `/api/conversations/${encodeURIComponent(conversationId)}/regenerate`,
        {
          userMessageId,
          providerId: model.providerId,
          model: model.model,
          expectedRevision: revision,
        },
      );
      setLocalGeneration(result.generationId);
      await refetch(conversationId);
    } catch (e) {
      setNotice(conflictMessage(e));
      void refetch(conversationId).catch(() => undefined);
    }
  }

  async function edit(message: MessageDto, content: string) {
    if (!conversationId || !dto) return;
    setNotice(null);
    try {
      const updated = await api<ConversationDto>(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(message.id)}`,
        {
          method: "PATCH",
          body: {
            content,
            attachmentIds: message.attachments.filter((a) => !a.missing).map((a) => a.id),
            expectedRevision: dto.revision,
          },
        },
      );
      client.setQueryData(keys.conversation(userId, conversationId), updated);
      await regenerate(message.id, updated.revision);
    } catch (e) {
      setNotice(conflictMessage(e));
      throw e;
    }
  }

  async function deleteExchange() {
    if (!conversationId || !dto || !deleting) return;
    setBusy(true);
    try {
      const updated = await api<ConversationDto>(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(deleting.id)}?expectedRevision=${dto.revision}`,
        { method: "DELETE" },
      );
      client.setQueryData(keys.conversation(userId, conversationId), updated);
      void client.invalidateQueries({ queryKey: keys.conversations(userId) });
      setDeleting(null);
    } catch (e) {
      setNotice(conflictMessage(e));
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  }

  function changeModel(choice: ModelChoice) {
    setOverride(choice);
    client.setQueryData<Preferences>(keys.preferences(userId), (p) =>
      p ? { ...p, defaultProvider: choice.providerId, defaultModel: choice.model } : p,
    );
    void api("/api/preferences", {
      method: "PATCH",
      body: { defaultProvider: choice.providerId, defaultModel: choice.model },
    }).catch(() => undefined);
  }

  const summary = list.data?.conversations.find((c) => c.id === conversationId);
  const ref = conversationId
    ? {
        id: conversationId,
        title: dto?.title ?? summary?.title ?? "New chat",
        pinned: (summary?.pinnedRank ?? null) !== null,
      }
    : null;

  function command(name: BuiltIn) {
    if (name === "new") void navigate(paths.newChat());
    else if (name === "settings")
      void navigate(paths.settings(), { state: { background: location.pathname } });
    else if ((name === "rename" || name === "delete") && ref) actions.start(name, ref);
  }

  const noModels = models.isSuccess && model === null;
  const composer = (
    <Composer
      models={models.data}
      model={model}
      onModelChange={changeModel}
      kinds={kinds}
      maxPerMessage={limits.data?.maxPerMessage ?? 10}
      imageMaxEdge={prefs.data?.imageMaxEdge ?? DEFAULT_IMAGE_MAX_EDGE}
      skills={skills.data ?? []}
      inChat={conversationId !== undefined}
      generating={generating}
      onSend={send}
      onStop={() => void stop()}
      onCommand={command}
    />
  );
  const noModelsNote = noModels ? (
    <p className="composer-note">
      {shell.user.role === "admin" ? (
        <>
          No models are available yet.{" "}
          <Link to={paths.settings("providers")} state={{ background: location.pathname }}>
            Add a provider
          </Link>{" "}
          to start chatting.
        </>
      ) : (
        "No models are available yet. Ask your administrator to add one."
      )}
    </p>
  ) : null;

  const header = (
    <header className="chat-header">
      {shell.narrow ? (
        <IconButton label="Open conversations" onClick={shell.openSidebar}>
          <PanelLeft size={20} aria-hidden />
        </IconButton>
      ) : null}
      {ref ? (
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="title-button">
              <span className="title-text">{ref.title}</span>
              <ChevronDown size={16} aria-hidden />
            </button>
          </MenuTrigger>
          <MenuContent align="start">{actions.items(ref)}</MenuContent>
        </Menu>
      ) : (
        <span className="spacer" />
      )}
      {shell.narrow ? (
        <Link to={paths.newChat()} className="icon-button" aria-label="New chat" title="New chat">
          <SquarePen size={20} aria-hidden />
        </Link>
      ) : null}
    </header>
  );

  // ---- A new chat: the greeting, the composer and recent chats. ----
  if (!conversationId) {
    const recent = [...(list.data?.conversations ?? [])]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 3);
    return (
      <main className="chat" inert={props.inert}>
        {header}
        {pending ? (
          <div className="transcript" ref={scrollRef}>
            <div className="turns">
              <UserMessage content={pending.content} attachments={pending.attachments} pending />
              <AssistantMessage content="" reasoning={null} status={null} streaming />
            </div>
          </div>
        ) : (
          <div className="home">
            <div className="home-inner">
              <h1>How can I help?</h1>
              {composer}
              {noModelsNote}
              {recent.length > 0 ? (
                <nav aria-labelledby="home-recent" className="home-recent">
                  <p id="home-recent" className="list-heading">
                    Recent
                  </p>
                  {recent.map((c) => (
                    <Link key={c.id} to={paths.chat(c.id)}>
                      {c.title || "New chat"}
                    </Link>
                  ))}
                </nav>
              ) : null}
            </div>
          </div>
        )}
        {pending ? <div className="composer-dock">{composer}</div> : null}
        {actions.dialogs}
      </main>
    );
  }

  // ---- An existing conversation. ----
  const error = conversation.error;
  const malformed = error instanceof ApiError && error.code === "CONVERSATION_MALFORMED";
  const notFound = !malformed && (!error || (error instanceof ApiError && error.status === 404));
  if (!dto) {
    return (
      <main className="chat" inert={props.inert}>
        {header}
        <div className="center-fill">
          {error || props.missing ? (
            <div className="empty" role="alert">
              <h1>
                {malformed
                  ? "This chat can’t be shown"
                  : notFound
                    ? "This chat does not exist"
                    : "Couldn’t load this chat"}
              </h1>
              <p className="muted">
                {malformed ? (
                  <>
                    Its file is damaged. You can still{" "}
                    <a href={`/api/conversations/${encodeURIComponent(conversationId)}/export`}>
                      download it
                    </a>
                    .
                  </>
                ) : notFound ? (
                  "It may have been deleted, or the link is wrong."
                ) : (
                  messageOf(error)
                )}
              </p>
              <Link className="button primary" to={paths.newChat()}>
                New chat
              </Link>
            </div>
          ) : (
            <p className="muted">Loading…</p>
          )}
        </div>
      </main>
    );
  }

  const artifactsBy = groupBy<MessageArtifactDto>(dto.artifacts, (a) => a.assistantMessageId);
  const proposalsBy = groupBy<ProposalDto>(dto.proposals, (p) => p.assistantMessageId);
  const visible = dto.messages.filter((m) => m.role !== "system");
  const liveStored = live ? visible.some((m) => m.id === live.assistantMessageId) : false;
  const showLiveAtEnd = live !== null && !liveStored;
  const userBefore = (index: number) => visible.slice(0, index).findLast((m) => m.role === "user");

  const renderLive = (reply: LiveReply) => (
    <AssistantMessage
      key={reply.assistantMessageId}
      content={reply.content}
      reasoning={reply.reasoning || null}
      status={
        isTerminalState(reply.state)
          ? reply.state === "completed"
            ? "complete"
            : reply.state
          : null
      }
      streaming={!isTerminalState(reply.state)}
      errorMessage={reply.error?.message ?? null}
    >
      <ProposalPreviews proposals={reply.proposals} />
    </AssistantMessage>
  );

  return (
    <main className={`chat${artifact ? " with-panel" : ""}`} inert={props.inert}>
      <div className="chat-main">
        {header}
        <div className="transcript" ref={scrollRef} onScroll={onScroll}>
          <div className="turns">
            {visible.map((m, index) => {
              if (m.role === "user")
                return (
                  <UserMessage
                    key={m.id}
                    content={m.content}
                    attachments={m.attachments}
                    disabled={generating}
                    onEdit={(content) => edit(m, content)}
                    onDelete={() => {
                      setDeleting(m);
                    }}
                  />
                );
              if (live?.assistantMessageId === m.id && !isTerminalState(live.state))
                return renderLive(live);
              const prior = userBefore(index);
              return (
                <AssistantMessage
                  key={m.id}
                  content={m.content}
                  reasoning={m.reasoning}
                  status={m.status}
                  model={m.model}
                  artifacts={artifactsBy.get(m.id)}
                  onOpenArtifact={(a) => {
                    setArtifact(a);
                  }}
                  disabled={generating}
                  {...(prior
                    ? { onRegenerate: () => void regenerate(prior.id, dto.revision) }
                    : {})}
                >
                  <Proposals
                    userId={userId}
                    conversationId={conversationId}
                    proposals={proposalsBy.get(m.id) ?? []}
                  />
                </AssistantMessage>
              );
            })}
            {pending ? (
              <UserMessage content={pending.content} attachments={pending.attachments} pending />
            ) : null}
            {showLiveAtEnd ? renderLive(live) : null}
            {pending && !showLiveAtEnd ? (
              <AssistantMessage content="" reasoning={null} status={null} streaming />
            ) : null}
            {notice ? (
              <p className="notice" role="alert">
                {notice}
              </p>
            ) : null}
          </div>
        </div>
        <div className="composer-dock">
          {composer}
          {noModelsNote}
        </div>
      </div>
      {artifact ? (
        <ArtifactPanel
          userId={userId}
          artifact={artifact}
          onClose={() => {
            setArtifact(null);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this exchange?"
        description="This message and the reply to it will be removed from the chat."
        confirm="Delete"
        danger
        busy={busy}
        onConfirm={() => void deleteExchange()}
      />
      {actions.dialogs}
    </main>
  );
}

function conflictMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === "CONFLICT")
    return "This chat changed in another tab. It has been reloaded; try again.";
  if (error instanceof ApiError && error.code === "GENERATION_IN_PROGRESS")
    return "A reply is still being written. Wait for it or stop it first.";
  return messageOf(error);
}
