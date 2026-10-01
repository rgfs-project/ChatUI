/**
 * Transcript time separators (owner's request, after ChatGPT): a centered
 * "Tue, Sep 22 at 11:56 PM" before the first timed message and wherever a new
 * sitting starts. Only the stored `time` attribute is used (contracts §3);
 * messages without it never get a synthesized time.
 */

/** A pause this long (or a new calendar day) starts a new sitting. */
export const SITTING_GAP_MS = 60 * 60 * 1000;

/** Ids of the messages that get a separator before them. */
export function separatorsBefore(
  messages: readonly { id: string; time: string | null }[],
  timeZone?: string,
): Map<string, string> {
  const out = new Map<string, string>();
  let previous: Date | null = null;
  for (const message of messages) {
    if (!message.time) continue;
    const at = new Date(message.time);
    if (Number.isNaN(at.getTime())) continue;
    if (
      previous === null ||
      at.getTime() - previous.getTime() >= SITTING_GAP_MS ||
      dayKey(at, timeZone) !== dayKey(previous, timeZone)
    )
      out.set(message.id, message.time);
    previous = at;
  }
  return out;
}

function dayKey(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(date);
}

/** "Tue, Sep 22 at 11:56 PM" in the viewer's locale; the year only when it differs. */
export function formatSeparator(iso: string, now = new Date(), locale?: string, timeZone?: string) {
  const at = new Date(iso);
  const day = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(at);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  return `${day} at ${time}`;
}
