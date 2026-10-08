/** "1.2 MB" style sizes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit] ?? "TB"}`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The letter shown in an avatar. */
export function initial(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toUpperCase();
}

/** Minimum quiet time before a new timestamp is shown in a chat. */
export const TIME_GAP_MS = 60 * 60 * 1000;

/**
 * Which messages get a timestamp above them: the first one, and any that
 * follows the previous message by an hour or more.
 */
export function timestampedIds(
  messages: readonly { id: string; time: string | null }[],
): Set<string> {
  const ids = new Set<string>();
  let previous: number | null = null;
  for (const m of messages) {
    const t = m.time ? Date.parse(m.time) : Number.NaN;
    if (Number.isNaN(t)) continue;
    if (previous === null || t - previous >= TIME_GAP_MS) ids.add(m.id);
    previous = t;
  }
  return ids;
}

/** "Sat, Sep 12 at 2:26 a.m.", with the year when it isn't this one. */
export function formatStamp(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
}
