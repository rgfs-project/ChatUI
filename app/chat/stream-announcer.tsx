import { useEffect, useRef, useState } from "react";
import type { MessageDto } from "@shared/conversations";

const ENDED: Record<NonNullable<MessageDto["status"]>, string> = {
  complete: "Response complete",
  cancelled: "Response stopped",
  failed: "Response failed",
  timed_out: "Response timed out",
  interrupted: "Response interrupted",
};

/**
 * One polite live region for replies (Phase 18): "Assistant is responding"
 * when a reply starts, and how it ended once it is stored. It never
 * announces tokens, never takes focus and is visually hidden, so scroll
 * pinning is unaffected.
 */
export function StreamAnnouncer({
  running,
  lastReply,
}: {
  running: boolean;
  /** The newest stored reply: a new id after the run means it ended. */
  lastReply: { id: string; status: MessageDto["status"] } | null;
}) {
  const [text, setText] = useState("");
  const startedAfter = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (running && startedAfter.current === undefined) {
      startedAfter.current = lastReply?.id ?? null;
      setText("Assistant is responding");
    } else if (
      !running &&
      startedAfter.current !== undefined &&
      lastReply &&
      lastReply.id !== startedAfter.current
    ) {
      startedAfter.current = undefined;
      setText(lastReply.status ? ENDED[lastReply.status] : ENDED.complete);
    }
  }, [running, lastReply]);
  return (
    <p className="visually-hidden" role="status" aria-live="polite" data-testid="stream-status">
      {text}
    </p>
  );
}
