import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { useNavigate } from "react-router";
import type { ConversationResult } from "@shared/conversations";
import { isTerminalState } from "@shared/generation-state";
import type { ProviderModelsDto, StartGenerationResponse } from "@shared/generations";
import {
  AccountChangedError,
  ACCOUNT_CHANGED_EVENT,
  apiError,
  apiFetch,
  apiJson,
  currentSession,
} from "../lib/api";
import { paths } from "../lib/paths";
import { mark } from "../lib/perf";
import { qk } from "../lib/query/keys";
import {
  conversationQuery,
  conversationsQuery,
  instanceQuery,
  modelsQuery,
  preferencesQuery,
  refreshModels as refreshModelList,
  storeConversation,
} from "../lib/query/queries";
import { applySession, purgeUserCache } from "../lib/session";
import { useConfirm } from "../ui/dialog";
import { useToast } from "../ui/toast";
import { draftStore } from "./drafts";
import { useGenerationObserver, useLiveGeneration, type LiveGeneration } from "./generation";
import {
  chooseModel,
  pairKey,
  pairOfKey,
  readLastUsed,
  writeLastUsed,
  type ModelPair,
} from "./model-choice";
import type { ConversationDto, ConversationSummary } from "@shared/conversations";

/** Resends of an unresolved send with the same operation key (contracts §4.1). */
const SEND_RETRIES = 3;
/** Backoff between resends: base × attempt (tests shorten it). */
export const sendTiming = { baseDelayMs: 1_000 };

/** A user message accepted (or being accepted) but not yet in the fetched transcript. */
export interface PendingSend {
  conversationId: string | null;
  content: string;
  userMessageId: string | null;
  /**
   * `sending`: in flight or being resent with the same key; `unknown`: retries
   * are exhausted or the key expired, so the user must check (contracts §4.1).
   */
  status: "sending" | "unknown";
}

export interface RenameTarget {
  id: string;
  title: string;
  revision?: string;
}

export interface ChatApi {
  userId: string;
  username: string;
  role: "user" | "admin";
  /** The displayed conversation (route-derived, INV-53); null is the draft. */
  conversationId: string | null;
  result: ConversationResult | undefined;
  conversationLoading: boolean;
  activeGenerationId: string | null;
  running: boolean;
  pending: PendingSend | null;
  /** Clears an unknown-outcome send after refreshing the conversation. */
  checkPending: () => Promise<void>;
  groups: ProviderModelsDto[];
  modelsState: "loading" | "error" | "ready";
  selectedPair: ModelPair | null;
  selectModel: (pair: ModelPair) => void;
  refreshModels: () => Promise<void>;
  send: (content: string) => Promise<boolean>;
  cancel: () => Promise<void>;
  rename: (target: RenameTarget) => void;
  renameTarget: RenameTarget | null;
  closeRename: () => void;
  submitRename: (title: string) => Promise<boolean>;
  remove: (id: string, title: string) => Promise<void>;
  logout: () => Promise<void>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  /** Set by the transcript view: sending re-pins the reader to the latest message. */
  jumpRef: RefObject<(() => void) | null>;
  hasDraft: boolean;
  setHasDraft: (value: boolean) => void;
}

const ChatContext = createContext<ChatApi | null>(null);

const noopSubscribe = () => () => undefined;

export function useChat(): ChatApi {
  const api = useContext(ChatContext);
  if (!api) throw new Error("useChat outside ChatProvider");
  return api;
}

export function ChatProvider({
  user,
  conversationId,
  children,
}: {
  user: { id: string; username: string; role: "user" | "admin" };
  conversationId: string | null;
  children: ReactNode;
}) {
  const userId = user.id;
  const client = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const jumpRef = useRef<(() => void) | null>(null);
  const [hasDraft, setHasDraft] = useState(false);

  const conversation = useQuery({
    ...conversationQuery(userId, conversationId ?? "none"),
    enabled: conversationId !== null,
  });
  const result = conversationId ? conversation.data : undefined;
  const models = useQuery(modelsQuery(userId));
  const preferences = useQuery(preferencesQuery(userId));
  const instance = useQuery(instanceQuery(userId));
  // Sidebar data loads alongside; it never gates the composer.
  useQuery(conversationsQuery(userId));

  // ── Generation observation (independent of the displaying component) ──
  const [started, setStarted] = useState<{ conversationId: string; generationId: string } | null>(
    null,
  );
  const loaded = result?.ok ? result.conversation : null;
  const activeGenerationId =
    (started?.conversationId === conversationId ? started.generationId : null) ??
    loaded?.activeGeneration?.generationId ??
    null;
  useGenerationObserver(userId, activeGenerationId);
  const liveState = useLiveGeneration(userId, activeGenerationId, (v) => v?.state);
  const finished = liveState === undefined ? false : isTerminalState(liveState);
  const running = activeGenerationId !== null && !finished;

  // ── Model selection: per conversation in tab memory, validated by the server ──
  const [chosen, setChosen] = useState<Map<string, ModelPair>>(() => new Map());
  // The stored hint is read after hydration (the server cannot see it).
  const storedLastUsed = useSyncExternalStore(
    noopSubscribe,
    () => readLastUsed(userId),
    () => null,
  );
  const [pickedLastUsed, setLastUsed] = useState<ModelPair | null>(null);
  const lastUsed = useMemo(
    () => pickedLastUsed ?? (storedLastUsed ? pairOfKey(storedLastUsed) : null),
    [pickedLastUsed, storedLastUsed],
  );
  const groups = useMemo(() => models.data ?? [], [models.data]);
  const chosenPair = chooseModel({
    groups,
    chosen: chosen.get(conversationId ?? "new") ?? null,
    conversation: loaded,
    lastUsed,
    preferences: preferences.data ?? null,
    instanceDefault: instance.data?.defaultModel
      ? [instance.data.defaultModel.providerId, instance.data.defaultModel.modelId]
      : null,
  });
  // Compared by value: a recomputed pair with the same ids is no change.
  const selectedKey = chosenPair ? pairKey(chosenPair) : null;
  const selectedPair = useMemo(() => (selectedKey ? pairOfKey(selectedKey) : null), [selectedKey]);
  const selectModel = useCallback(
    (pair: ModelPair) => {
      setChosen((map) => new Map(map).set(conversationId ?? "new", pair));
      setLastUsed(pair);
      writeLastUsed(userId, pair);
    },
    [conversationId, userId],
  );
  const refreshModels = useCallback(async () => {
    try {
      await refreshModelList(client, userId);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not refresh the models", "error");
    }
  }, [client, toast, userId]);

  // ── Sending ──
  const [pending, setPending] = useState<PendingSend | null>(null);
  const sending = useRef(false);

  const send = useCallback(
    async (content: string): Promise<boolean> => {
      const pair = selectedPair;
      if (sending.current || running) return false;
      if (!pair) {
        toast("Choose a model first.", "error");
        return false;
      }
      if (conversationId !== null && result && !result.ok) return false;
      sending.current = true;
      const target = conversationId;
      setPending({ conversationId: target, content, userMessageId: null, status: "sending" });
      const body = JSON.stringify({
        ...(target ? { conversationId: target } : {}),
        providerId: pair[0],
        model: pair[1],
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
            if (error instanceof AccountChangedError) {
              setPending(null);
              return false; // discarded, never re-sent under another account
            }
            response = undefined; // network error: unknown outcome, resend with the same key
          }
          if (response?.status === 202) {
            const accepted = (await response.json()) as StartGenerationResponse;
            mark("chatui:generation-accepted", { generationId: accepted.generationId });
            const live: LiveGeneration = {
              generationId: accepted.generationId,
              assistantMessageId: accepted.assistantMessageId,
              conversationId: accepted.conversationId,
              state: "pending",
              content: "",
              reasoning: "",
              finishReason: null,
              error: null,
            };
            client.setQueryData(qk.generation(userId, accepted.generationId), live);
            setStarted({
              conversationId: accepted.conversationId,
              generationId: accepted.generationId,
            });
            setPending({
              conversationId: accepted.conversationId,
              content,
              userMessageId: accepted.userMessageId,
              status: "sending",
            });
            setChosen((map) => new Map(map).set(accepted.conversationId, pair));
            setLastUsed(pair);
            writeLastUsed(userId, pair);
            void client.invalidateQueries({ queryKey: qk.conversations(userId) });
            if (target === null) {
              draftStore.set(`${userId}|new`, "");
              // The draft URL is replaced, so Back does not return to an empty draft.
              await navigate(paths.chat(accepted.conversationId), { replace: true });
            } else {
              await client.invalidateQueries({
                queryKey: qk.conversation(userId, accepted.conversationId),
              });
            }
            return true;
          }
          if (response) {
            const error = await apiError(response);
            // An expired key can never become a fresh send: the outcome stays unknown.
            if (error.code === "OPERATION_EXPIRED") break;
            // Any other contract error except INTERNAL means rejected: nothing was saved.
            if (error.code && error.code !== "INTERNAL") {
              setPending(null);
              if (error.code !== "UNAUTHENTICATED") toast(error.message, "error");
              return false;
            }
          }
          await new Promise((resolve) =>
            setTimeout(resolve, sendTiming.baseDelayMs * (attempt + 1)),
          );
        }
        // Unknown outcome: keep the message visible and never mint a new key for it.
        setPending((p) => (p ? { ...p, status: "unknown" } : p));
        toast("The outcome of this send is unknown. Check the conversation.", "error");
        return true;
      } finally {
        sending.current = false;
      }
    },
    [client, conversationId, navigate, result, running, selectedPair, toast, userId],
  );

  const checkPending = useCallback(async () => {
    const target = pending?.conversationId ?? conversationId;
    setPending(null);
    if (target) await client.invalidateQueries({ queryKey: qk.conversation(userId, target) });
    await client.invalidateQueries({ queryKey: qk.conversations(userId) });
  }, [client, conversationId, pending, userId]);

  const cancel = useCallback(async () => {
    if (!activeGenerationId) return;
    try {
      await apiJson(`/api/generations/${encodeURIComponent(activeGenerationId)}/cancel`, {
        method: "POST",
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not stop the reply", "error");
    }
  }, [activeGenerationId, toast]);

  // ── Rename / delete ──
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const submitRename = useCallback(
    async (title: string): Promise<boolean> => {
      if (!renameTarget) return false;
      try {
        const updated = await apiJson<ConversationDto>(
          `/api/conversations/${encodeURIComponent(renameTarget.id)}`,
          {
            method: "PATCH",
            json: {
              title,
              ...(renameTarget.revision ? { expectedRevision: renameTarget.revision } : {}),
            },
          },
        );
        storeConversation(client, userId, updated);
        void client.invalidateQueries({ queryKey: qk.conversations(userId) });
        setRenameTarget(null);
        return true;
      } catch (error) {
        toast(error instanceof Error ? error.message : "Could not rename the chat", "error");
        return false;
      }
    },
    [client, renameTarget, toast, userId],
  );

  const remove = useCallback(
    async (id: string, title: string) => {
      const ok = await confirm({
        title: "Delete chat?",
        body: `This will delete "${title}". This cannot be undone.`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      try {
        await apiJson(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch (error) {
        toast(error instanceof Error ? error.message : "Could not delete the chat", "error");
        return;
      }
      // Leave first: removing the cache entry while it is displayed would refetch it.
      if (id === conversationId) await navigate(paths.newChat(), { replace: true });
      client.removeQueries({ queryKey: qk.conversation(userId, id) });
      // Gone from the sidebar at once; the refetch then confirms it.
      client.setQueryData<ConversationSummary[]>(qk.conversations(userId), (list) =>
        list?.filter((c) => c.id !== id),
      );
      void client.invalidateQueries({ queryKey: qk.conversations(userId) });
      draftStore.set(`${userId}|${id}`, "");
      toast("Chat deleted.");
    },
    [client, confirm, conversationId, navigate, toast, userId],
  );

  // ── Sign-out and account changes (INV-59) ──
  const signedOut = useCallback(async () => {
    draftStore.clearAll();
    if (composerRef.current) composerRef.current.value = "";
    purgeUserCache(client);
    await navigate(paths.login(), { replace: true });
  }, [client, navigate]);

  const logout = useCallback(async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      // the session is dropped locally either way
    }
    applySession(client, {
      user: null,
      csrfToken: null,
      registrationOpen: currentSession()?.registrationOpen ?? false,
    });
    await signedOut();
  }, [client, signedOut]);

  useEffect(() => {
    const onChange = () => {
      void signedOut();
    };
    window.addEventListener(ACCOUNT_CHANGED_EVENT, onChange);
    return () => {
      window.removeEventListener(ACCOUNT_CHANGED_EVENT, onChange);
    };
  }, [signedOut]);

  const api = useMemo<ChatApi>(
    () => ({
      userId,
      username: user.username,
      role: user.role,
      conversationId,
      result,
      conversationLoading: conversationId !== null && conversation.isPending,
      activeGenerationId,
      running,
      pending,
      checkPending,
      groups,
      modelsState: models.isPending ? "loading" : models.isError ? "error" : "ready",
      selectedPair,
      selectModel,
      refreshModels,
      send,
      cancel,
      rename: setRenameTarget,
      renameTarget,
      closeRename: () => {
        setRenameTarget(null);
      },
      submitRename,
      remove,
      logout,
      composerRef,
      jumpRef,
      hasDraft,
      setHasDraft,
    }),
    [
      userId,
      user.username,
      user.role,
      conversationId,
      result,
      conversation.isPending,
      activeGenerationId,
      running,
      pending,
      checkPending,
      groups,
      models.isPending,
      models.isError,
      selectedPair,
      selectModel,
      refreshModels,
      send,
      cancel,
      renameTarget,
      submitRename,
      remove,
      logout,
      hasDraft,
    ],
  );

  return <ChatContext.Provider value={api}>{children}</ChatContext.Provider>;
}
