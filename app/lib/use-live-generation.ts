import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  isTerminalState,
  type GenerationState,
  type TerminalState,
} from "@shared/generation-state";
import type {
  GenerationError,
  GenerationSnapshot,
  StartGenerationResponse,
} from "@shared/generations";
import { refreshSession } from "./api";
import { markGeneration } from "./perf";
import { queryKeys } from "./query";

export interface LiveGeneration {
  generationId: string;
  assistantMessageId: string;
  state: GenerationState;
  content: string;
  reasoning: string;
  error: GenerationError | null;
}

/**
 * Observes the conversation's running generation over SSE (replay/resync
 * aware, INV-20). The observed id is the one started here, else the server's
 * `activeGeneration`; events for any other id are ignored, so a late event
 * from a superseded stream never overwrites newer state (INV-23). Browser
 * lifecycle events never cancel anything.
 */
export function useLiveGeneration(options: {
  userId: string;
  conversationId: string | undefined;
  serverActive: string | null;
  disabled: boolean;
}) {
  const { userId, conversationId, serverActive, disabled } = options;
  const client = useQueryClient();
  const [live, setLive] = useState<LiveGeneration | null>(null);
  const observedId = live && !isTerminalState(live.state) ? live.generationId : serverActive;

  useEffect(() => {
    if (!observedId || disabled) return;
    const source = new EventSource(`/api/generations/${observedId}/stream`);
    const refresh = () => {
      void client.invalidateQueries({
        queryKey: queryKeys.conversation(userId, conversationId ?? ""),
      });
      void client.invalidateQueries({ queryKey: queryKeys.conversations(userId) });
    };
    const id = observedId;
    source.addEventListener("open", () => {
      markGeneration("chatui:stream-open", id);
    });
    const onFullState = (event: MessageEvent<string>) => {
      const s = JSON.parse(event.data) as GenerationSnapshot;
      if (s.generationId !== observedId) return;
      if (s.content || s.reasoning) markGeneration("chatui:first-assistant-event", id);
      setLive({
        generationId: s.generationId,
        assistantMessageId: s.assistantMessageId,
        state: s.state,
        content: s.content,
        reasoning: s.reasoning,
        error: s.error,
      });
      if (isTerminalState(s.state)) {
        source.close();
        refresh();
      }
    };
    source.addEventListener("snapshot", onFullState);
    source.addEventListener("resync", onFullState);
    source.addEventListener("state", (event: MessageEvent<string>) => {
      const { state } = JSON.parse(event.data) as { state: GenerationState };
      setLive((v) => (v?.generationId === observedId ? { ...v, state } : v));
    });
    source.addEventListener("delta", (event: MessageEvent<string>) => {
      const delta = JSON.parse(event.data) as { content?: string; reasoning?: string };
      if (delta.content || delta.reasoning) markGeneration("chatui:first-assistant-event", id);
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
      markGeneration("chatui:generation-complete", id);
      setLive((v) =>
        v?.generationId === observedId ? { ...v, state: t.state, error: t.error } : v,
      );
      source.close();
      // The reply is stored now: refresh the canonical transcript and list.
      refresh();
    });
    // EventSource retries network drops itself. A closed stream (an HTTP
    // error such as 401 or 404) may mean the session ended: ask the server,
    // which moves auth to unauthenticated if so, and resync the transcript.
    const onError = () => {
      if (source.readyState !== EventSource.CLOSED) return;
      void refreshSession();
      refresh();
    };
    source.addEventListener("error", onError);
    return () => {
      source.close();
    };
  }, [observedId, disabled, client, userId, conversationId]);

  return {
    live,
    observedId,
    /** The server accepted a send in this view: observe it right away. */
    started: (started: StartGenerationResponse) => {
      setLive({
        generationId: started.generationId,
        assistantMessageId: started.assistantMessageId,
        state: "pending",
        content: "",
        reasoning: "",
        error: null,
      });
    },
  };
}
