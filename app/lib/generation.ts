import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { isTerminalState, type GenerationState } from "@shared/generation-state";
import type { GenerationError, GenerationSnapshot } from "@shared/generations";
import type { ProposalPreview } from "@shared/memories";
import { keys } from "./query";

export interface LiveReply {
  generationId: string;
  assistantMessageId: string;
  state: GenerationState;
  content: string;
  reasoning: string;
  error: GenerationError | null;
  proposals: ProposalPreview[];
}

/** Applies one SSE event to the reply being watched (pure; exported for tests). */
export function applyEvent(live: LiveReply | null, type: string, data: unknown): LiveReply | null {
  switch (type) {
    case "snapshot":
    case "resync": {
      const s = data as GenerationSnapshot;
      return {
        generationId: s.generationId,
        assistantMessageId: s.assistantMessageId,
        state: s.state,
        content: s.content,
        reasoning: s.reasoning,
        error: s.error,
        proposals: s.proposals ?? [],
      };
    }
    case "state":
      return live ? { ...live, state: (data as { state: GenerationState }).state } : live;
    case "delta": {
      if (!live) return live;
      const d = data as { content?: string; reasoning?: string };
      return {
        ...live,
        state: "streaming",
        content: live.content + (d.content ?? ""),
        reasoning: live.reasoning + (d.reasoning ?? ""),
      };
    }
    case "proposals":
      return live
        ? { ...live, proposals: (data as { proposals: ProposalPreview[] }).proposals }
        : live;
    case "terminal": {
      if (!live) return live;
      const t = data as { state: GenerationState; error: GenerationError | null };
      return { ...live, state: t.state, error: t.error };
    }
    default:
      return live;
  }
}

const EVENTS = ["snapshot", "resync", "state", "delta", "proposals", "terminal"] as const;

/**
 * Watches one generation over SSE. The stream replays from where it is, so a
 * reload or a second tab sees the same reply. When it ends, the conversation
 * and the list are refetched (the stored reply replaces the live one).
 */
export function useGeneration(
  userId: string,
  conversationId: string | undefined,
  generationId: string | null,
) {
  const client = useQueryClient();
  const [live, setLive] = useState<LiveReply | null>(null);

  useEffect(() => {
    if (!generationId) return;
    const source = new EventSource(`/api/generations/${encodeURIComponent(generationId)}/stream`);
    let ended = false;
    const finish = () => {
      ended = true;
      source.close();
      if (conversationId)
        void client.invalidateQueries({ queryKey: keys.conversation(userId, conversationId) });
      void client.invalidateQueries({ queryKey: keys.conversations(userId) });
      void client.invalidateQueries({ queryKey: keys.artifacts(userId) });
    };
    for (const type of EVENTS) {
      source.addEventListener(type, (event: MessageEvent<string>) => {
        const data: unknown = JSON.parse(event.data);
        setLive((current) =>
          applyEvent(current?.generationId === generationId ? current : null, type, data),
        );
        const state =
          type === "terminal"
            ? (data as { state: GenerationState }).state
            : type === "snapshot" || type === "resync"
              ? (data as GenerationSnapshot).state
              : null;
        if (state && isTerminalState(state)) finish();
      });
    }
    source.onerror = () => {
      // EventSource reconnects by itself (with Last-Event-ID). A closed stream
      // (404, the reply is gone) is settled by refetching the conversation.
      if (!ended && source.readyState === EventSource.CLOSED) finish();
    };
    return () => {
      source.close();
    };
  }, [client, userId, conversationId, generationId]);

  return live?.generationId === generationId ? live : null;
}
