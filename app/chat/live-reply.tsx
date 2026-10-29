import { isTerminalState } from "@shared/generation-state";
import { useRenderProbe } from "../lib/render-probe";
import { useLiveGeneration } from "./generation";
import { LIVE_LABEL, Reasoning } from "./message";
import { Markdown } from "./markdown";

/**
 * The reply being generated. The only component subscribed to deltas, so a
 * token re-renders this subtree alone (INV-32). Shown only for its own
 * conversation, and until the stored copy is in the transcript.
 */
export function LiveReply({
  userId,
  generationId,
  conversationId,
  storedIds,
}: {
  userId: string;
  generationId: string;
  conversationId: string;
  storedIds: ReadonlySet<string>;
}) {
  useRenderProbe("LiveReply");
  const live = useLiveGeneration(userId, generationId);
  if (live?.conversationId !== conversationId) return null;
  if (isTerminalState(live.state) && storedIds.has(live.assistantMessageId)) return null;
  const label = LIVE_LABEL[live.state];
  return (
    <div
      className="msg msg-assistant is-live"
      data-testid="live-reply"
      aria-busy={!isTerminalState(live.state)}
    >
      {live.reasoning ? <Reasoning text={live.reasoning} /> : null}
      <div data-testid="content">{live.content ? <Markdown>{live.content}</Markdown> : null}</div>
      {label ? (
        <p className="msg-status" data-testid="generation-status">
          {label}
          {live.error ? ` — ${live.error.message}` : ""}
        </p>
      ) : null}
    </div>
  );
}
