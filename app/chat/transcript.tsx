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
  return (
    <>
      {messages.map((message, i) => (
        <Fragment key={message.id}>
          {separators.has(i) && message.time ? (
            <p className="time-separator">{formatSeparator(message.time, timeFormat)}</p>
          ) : null}
          <Message message={message} />
        </Fragment>
      ))}
    </>
  );
});
