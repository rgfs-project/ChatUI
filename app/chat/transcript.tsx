import { Fragment, memo, useMemo } from "react";
import type { MessageDto } from "@shared/conversations";
import { formatSeparator, separatorIndexes, type TimeFormat } from "../lib/time";
import { Message } from "./message";

/** Stored messages with time separators. Re-renders only when the conversation changes. */
export const Transcript = memo(function Transcript({
  messages,
  timeFormat,
}: {
  messages: MessageDto[];
  timeFormat: TimeFormat;
}) {
  const separators = useMemo(() => separatorIndexes(messages.map((m) => m.time)), [messages]);
  // Each reply's user turn, for Regenerate (contracts §4.2 exchanges).
  const turns = useMemo(() => {
    const map = new Map<string, string>();
    let user: string | null = null;
    for (const m of messages) {
      if (m.role === "user") user = m.id;
      else if (m.role === "assistant" && user) {
        map.set(m.id, user);
        user = null;
      } else if (m.role === "system") user = null;
    }
    return map;
  }, [messages]);
  return (
    <>
      {messages.map((message, i) => (
        <Fragment key={message.id}>
          {separators.has(i) && message.time ? (
            <p className="time-separator">{formatSeparator(message.time, timeFormat)}</p>
          ) : null}
          <Message message={message} turnUserId={turns.get(message.id)} />
        </Fragment>
      ))}
    </>
  );
});
