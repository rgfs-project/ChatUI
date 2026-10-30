import { isTerminalState } from "@shared/generation-state";
import { useRenderProbe } from "../lib/render-probe";
import { useLiveGeneration } from "./generation";
import { LIVE_LABEL, Reasoning } from "./message";
import { Markdown } from "./markdown";
import { LiveToolChips } from "./tool-chips";
import { useQuery } from "@tanstack/react-query";
import { preferencesQuery } from "../lib/query/queries";
import { UiBlocksContext } from "./ui/context";

const STREAMING_ON = { enabled: true, streaming: true };
const STREAMING_OFF = { enabled: false, streaming: true };
const streamingBlocks = (enabled: boolean) => (enabled ? STREAMING_ON : STREAMING_OFF);

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
  const uiEnabled =
    useQuery({ ...preferencesQuery(userId), select: (p) => p.uiBlocks !== false }).data ?? true;
  if (live?.conversationId !== conversationId) return null;
  if (isTerminalState(live.state) && storedIds.has(live.assistantMessageId)) return null;
  const label = LIVE_LABEL[live.state];
  return (
    <div
      className="msg msg-assistant is-live"
      data-testid="live-reply"
      aria-busy={!isTerminalState(live.state)}
    >
      {live.reasoning ? (
        <Reasoning text={live.reasoning} label={live.content ? "Thought" : "Thinking…"} />
      ) : null}
      <LiveToolChips tools={live.tools} />
      <div data-testid="content">
        {live.content ? (
          <UiBlocksContext.Provider value={streamingBlocks(uiEnabled)}>
            <Markdown>{live.content}</Markdown>
          </UiBlocksContext.Provider>
        ) : null}
      </div>
      {label ? (
        <p className="msg-status" data-testid="generation-status">
          {label}
          {live.error ? ` — ${live.error.message}` : ""}
        </p>
      ) : null}
    </div>
  );
}
