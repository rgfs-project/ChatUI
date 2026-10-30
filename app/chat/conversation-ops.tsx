import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { ConversationDto } from "@shared/conversations";
import type { StartGenerationResponse } from "@shared/generations";
import type { PreferencesDto } from "@shared/preferences";
import { ApiError, apiJson } from "../lib/api";
import { qk } from "../lib/query/keys";
import { storeConversation } from "../lib/query/queries";
import { useConfirm } from "../ui/dialog";
import { useToast } from "../ui/toast";
import { useChat } from "./chat-context";

/**
 * Conversation operations (Phase 13a, contracts §4.2). The callbacks are
 * stable for the provider's lifetime and read the latest state through a
 * ref, so memoized messages that use them never re-render while a reply
 * streams (INV-32).
 */
export interface ConversationOps {
  /** Edit a user turn, then regenerate its reply (the "edit and resubmit" chain). */
  editAndResend: (messageId: string, content: string) => Promise<boolean>;
  /** Replace the reply to a user turn (asks first). */
  regenerate: (messageId: string) => Promise<boolean>;
  /** Remove one exchange (asks first). */
  deleteExchange: (messageId: string) => Promise<boolean>;
  togglePin: (conversationId: string) => Promise<void>;
  /** Thumbs up/down on a reply, or null to clear it (Phase 14b). */
  setFeedback: (messageId: string, value: "up" | "down" | null) => Promise<void>;
  /** Save (accept) or dismiss (reject) a memory suggestion (Phase 13b, INV-37). */
  decideProposal: (proposalId: string, accept: boolean) => Promise<void>;
}

const OpsContext = createContext<ConversationOps | null>(null);

export function useConversationOps(): ConversationOps {
  const ops = useContext(OpsContext);
  if (!ops) throw new Error("useConversationOps outside ConversationOpsProvider");
  return ops;
}

export function ConversationOpsProvider({ children }: { children: ReactNode }) {
  const chat = useChat();
  const client = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const latest = useRef({ chat, client, confirm, toast });
  // Synced after each render, before any click can reach the callbacks.
  useLayoutEffect(() => {
    latest.current = { chat, client, confirm, toast };
  });

  const ops = useMemo<ConversationOps>(() => {
    const current = () => {
      const { chat: c } = latest.current;
      return c.result?.ok ? c.result.conversation : null;
    };
    const fail = (error: unknown, fallback: string) => {
      latest.current.toast(error instanceof Error ? error.message : fallback, "error");
    };
    const refresh = (conversationId: string) =>
      latest.current.client.invalidateQueries({
        queryKey: qk.conversation(latest.current.chat.userId, conversationId),
      });

    const regenerateAt = async (messageId: string, revision: string): Promise<boolean> => {
      const { chat: c } = latest.current;
      const conversation = current();
      const pair = c.selectedPair;
      if (!conversation || !pair) return false;
      const body = {
        providerId: pair[0],
        model: pair[1],
        expectedRevision: revision,
        ...(c.canThink ? { think: c.think } : {}),
        operationKey: crypto.randomUUID(),
        operationIssuedAt: new Date().toISOString(),
      };
      const url = `/api/conversations/${conversation.id}/messages/${messageId}/regenerate`;
      // A dropped answer is resolved by resending the same key (contracts §4.1).
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const accepted = await apiJson<StartGenerationResponse>(url, {
            method: "POST",
            json: body,
          });
          c.beginLive(accepted, pair);
          await refresh(conversation.id);
          c.jumpRef.current?.();
          return true;
        } catch (error) {
          const unknown =
            !(error instanceof ApiError) || error.code === null || error.code === "INTERNAL";
          if (unknown && attempt === 0) continue;
          fail(error, "The reply could not be regenerated");
          await refresh(conversation.id);
          return false;
        }
      }
      return false;
    };

    return {
      regenerate: async (messageId) => {
        const conversation = current();
        if (!conversation) return false;
        const yes = await latest.current.confirm({
          title: "Regenerate this reply?",
          body: "The current reply will be replaced, along with any later messages.",
          confirmLabel: "Regenerate",
        });
        return yes ? regenerateAt(messageId, conversation.revision) : false;
      },
      editAndResend: async (messageId, content) => {
        const { chat: c, client } = latest.current;
        const conversation = current();
        if (!conversation) return false;
        let edited: ConversationDto;
        try {
          edited = await apiJson<ConversationDto>(
            `/api/conversations/${conversation.id}/messages/${messageId}`,
            { method: "PATCH", json: { content, expectedRevision: conversation.revision } },
          );
        } catch (error) {
          fail(error, "The message could not be edited");
          await refresh(conversation.id);
          return false;
        }
        storeConversation(client, c.userId, edited);
        // If another change lands first, regenerate is a CONFLICT and the edit stays visible.
        await regenerateAt(messageId, edited.revision);
        return true;
      },
      deleteExchange: async (messageId) => {
        const { chat: c, client } = latest.current;
        const conversation = current();
        if (!conversation) return false;
        const yes = await latest.current.confirm({
          title: "Delete this message?",
          body: "The message and its reply are removed. Later replies may refer to them.",
          confirmLabel: "Delete",
          danger: true,
        });
        if (!yes) return false;
        try {
          const updated = await apiJson<ConversationDto>(
            `/api/conversations/${conversation.id}/messages/${messageId}`,
            { method: "DELETE", json: { expectedRevision: conversation.revision } },
          );
          storeConversation(client, c.userId, updated);
          void client.invalidateQueries({ queryKey: qk.conversations(c.userId) });
          return true;
        } catch (error) {
          fail(error, "The message could not be deleted");
          await refresh(conversation.id);
          return false;
        }
      },
      setFeedback: async (messageId, value) => {
        const { chat: c, client } = latest.current;
        const conversation = current();
        if (!conversation) return;
        const key = qk.preferences(c.userId);
        const before = client.getQueryData<PreferencesDto>(key);
        if (before) {
          const feedback = Object.fromEntries(
            Object.entries(before.feedback).filter(([id]) => id !== messageId),
          );
          if (value) feedback[messageId] = value;
          client.setQueryData(key, { ...before, feedback });
        }
        try {
          client.setQueryData(
            key,
            await apiJson<PreferencesDto>(
              `/api/conversations/${conversation.id}/messages/${messageId}/feedback`,
              { method: "PUT", json: { value } },
            ),
          );
        } catch (error) {
          if (before) client.setQueryData(key, before);
          fail(error, "Could not save the feedback");
        }
      },
      decideProposal: async (proposalId, accept) => {
        const { chat: c, client } = latest.current;
        const conversation = current();
        if (!conversation) return;
        try {
          await apiJson(
            `/api/conversations/${conversation.id}/proposals/${proposalId}/${accept ? "accept" : "reject"}`,
            { method: "POST" },
          );
          if (accept) latest.current.toast("Saved to memory.");
          void client.invalidateQueries({ queryKey: qk.memories(c.userId) });
        } catch (error) {
          fail(error, "The suggestion could not be updated");
        }
        await refresh(conversation.id);
      },
      togglePin: async (conversationId) => {
        const { chat: c, client } = latest.current;
        const key = qk.preferences(c.userId);
        const prefs = client.getQueryData<PreferencesDto>(key);
        const pins = prefs?.pins ?? [];
        const next = pins.includes(conversationId)
          ? pins.filter((id) => id !== conversationId)
          : [conversationId, ...pins];
        if (prefs) client.setQueryData(key, { ...prefs, pins: next });
        try {
          client.setQueryData(
            key,
            await apiJson<PreferencesDto>("/api/preferences", {
              method: "PATCH",
              json: { pins: next },
            }),
          );
        } catch (error) {
          if (prefs) client.setQueryData(key, prefs);
          fail(error, "Could not update pins");
        }
      },
    };
  }, []);

  return <OpsContext.Provider value={ops}>{children}</OpsContext.Provider>;
}
