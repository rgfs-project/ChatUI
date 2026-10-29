import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
// Runtime helpers come from the schema-free module: browser code never bundles zod.
import {
  isTerminalState,
  type GenerationState,
  type TerminalState,
} from "@shared/generation-state";
import type { GenerationError, GenerationSnapshot } from "@shared/generations";
import { refreshSession, reportSessionExpired } from "../lib/api";
import { mark } from "../lib/perf";
import { qk } from "../lib/query/keys";

/** The browser's view of one generation, kept under its query key. */
export interface LiveGeneration {
  generationId: string;
  assistantMessageId: string;
  conversationId: string;
  state: GenerationState;
  content: string;
  reasoning: string;
  finishReason: string | null;
  error: GenerationError | null;
}

export function fromSnapshot(s: GenerationSnapshot): LiveGeneration {
  return {
    generationId: s.generationId,
    assistantMessageId: s.assistantMessageId,
    conversationId: s.conversationId,
    state: s.state,
    content: s.content,
    reasoning: s.reasoning,
    finishReason: s.finishReason,
    error: s.error,
  };
}

/**
 * Observes one generation over SSE and writes its state into the query cache.
 * Mounted by the persistent shell, not by the component that displays it, so
 * re-renders and overlays never restart the stream. Closing it never cancels
 * the generation (INV-06). `resync` replaces like `snapshot` (INV-20).
 */
export function useGenerationObserver(userId: string, generationId: string | null): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!generationId) return;
    const key = qk.generation(userId, generationId);
    const update = (fn: (v: LiveGeneration) => LiveGeneration) => {
      client.setQueryData<LiveGeneration>(key, (v) => (v ? fn(v) : v));
    };
    const source = new EventSource(`/api/generations/${encodeURIComponent(generationId)}/stream`);
    let conversationId: string | null = null;
    const finish = () => {
      source.close();
      if (conversationId)
        void client.invalidateQueries({ queryKey: qk.conversation(userId, conversationId) });
      void client.invalidateQueries({ queryKey: qk.conversations(userId) });
    };
    const onFull = (event: MessageEvent<string>) => {
      const snapshot = JSON.parse(event.data) as GenerationSnapshot;
      conversationId = snapshot.conversationId;
      client.setQueryData<LiveGeneration>(key, fromSnapshot(snapshot));
      if (isTerminalState(snapshot.state)) finish();
    };
    source.addEventListener("snapshot", onFull);
    source.addEventListener("resync", onFull);
    source.addEventListener("state", (event: MessageEvent<string>) => {
      const { state } = JSON.parse(event.data) as { state: GenerationState };
      update((v) => ({ ...v, state }));
    });
    source.addEventListener("delta", (event: MessageEvent<string>) => {
      mark("chatui:first-assistant-event", { generationId });
      const delta = JSON.parse(event.data) as { content?: string; reasoning?: string };
      update((v) => ({
        ...v,
        content: v.content + (delta.content ?? ""),
        reasoning: v.reasoning + (delta.reasoning ?? ""),
      }));
    });
    source.addEventListener("terminal", (event: MessageEvent<string>) => {
      const t = JSON.parse(event.data) as {
        state: TerminalState;
        finishReason: string | null;
        error: GenerationError | null;
      };
      update((v) => ({ ...v, state: t.state, finishReason: t.finishReason, error: t.error }));
      mark("chatui:generation-complete", { generationId });
      finish();
    });
    // A closed stream that did not end with a terminal event may mean the
    // session ended (the server closes streams of revoked sessions, §5).
    source.addEventListener("error", () => {
      if (source.readyState !== EventSource.CLOSED) return; // the browser retries itself
      void refreshSession(false).then((session) => {
        if (session && !session.user) reportSessionExpired();
      });
    });
    return () => {
      source.close();
    };
  }, [client, userId, generationId]);
}

/** Subscribes to a generation written by the observer (no fetching of its own). */
export function useLiveGeneration<T = LiveGeneration | undefined>(
  userId: string,
  generationId: string | null,
  select?: (v: LiveGeneration | undefined) => T,
): T {
  const { data } = useQuery({
    queryKey: qk.generation(userId, generationId ?? "none"),
    queryFn: () => null as unknown as LiveGeneration,
    enabled: false,
    staleTime: Infinity,
    select: (v: LiveGeneration | undefined) => (select ? select(v) : (v as T)),
  });
  return data as T;
}
