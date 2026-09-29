import { memo, useEffect } from "react";
import type { MessageDto } from "@shared/conversations";
import { count } from "../lib/render-counters";
import { Markdown } from "./Markdown";

const STATUS_LABEL: Record<NonNullable<MessageDto["status"]>, string> = {
  complete: "",
  cancelled: "Stopped",
  failed: "Failed",
  timed_out: "Timed out",
  interrupted: "Interrupted",
};

export interface MessageViewProps {
  role: MessageDto["role"];
  content: string;
  reasoning: string | null;
  status: MessageDto["status"];
  testId?: string;
}

function MessageImpl({ role, content, reasoning, status, testId }: MessageViewProps) {
  count("messageRenders");
  useEffect(() => {
    count("messageMounts");
  }, []);
  const label = role === "user" ? "You" : role === "assistant" ? "Assistant" : "System";
  const statusLabel = status ? STATUS_LABEL[status] : "";
  return (
    <li className={`message message-${role}`} data-testid={testId ?? `message-${role}`}>
      <span className="message-role">
        {label}
        {statusLabel ? (
          <span className={`status-badge status-${status ?? ""}`}>{statusLabel}</span>
        ) : null}
      </span>
      {reasoning ? (
        <details className="reasoning">
          <summary>Reasoning</summary>
          <div className="reasoning-body">{reasoning}</div>
        </details>
      ) : null}
      {role === "assistant" ? <Markdown text={content} /> : <p className="plain-text">{content}</p>}
    </li>
  );
}

/** Memoized: unrelated messages never re-render while another one streams. */
export const Message = memo(MessageImpl);
