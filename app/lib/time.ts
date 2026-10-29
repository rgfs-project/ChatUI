/** Messages further apart than this get their own time separator. */
export const SEPARATOR_GAP_MS = 60 * 60 * 1000;

export interface TimeFormat {
  locale: string;
  timeZone: string;
  /** Reference "now", fixed per render so server and hydration agree. */
  now: string;
}

function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** "Today 3:06 PM", "Yesterday 9:12 AM", "Mon, Oct 27, 3:06 PM", or with the year. */
export function formatSeparator(iso: string, format: TimeFormat): string {
  const date = new Date(iso);
  const now = new Date(format.now);
  if (Number.isNaN(date.getTime())) return "";
  const time = new Intl.DateTimeFormat(format.locale, {
    timeZone: format.timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  const day = dayKey(date, format.timeZone);
  if (day === dayKey(now, format.timeZone)) return `Today ${time}`;
  if (day === dayKey(new Date(now.getTime() - 86_400_000), format.timeZone))
    return `Yesterday ${time}`;
  const sameYear =
    new Intl.DateTimeFormat("en", { timeZone: format.timeZone, year: "numeric" }).format(date) ===
    new Intl.DateTimeFormat("en", { timeZone: format.timeZone, year: "numeric" }).format(now);
  return new Intl.DateTimeFormat(format.locale, {
    timeZone: format.timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** Indexes (into `times`) that start a new separator group. */
export function separatorIndexes(times: (string | null)[]): Set<number> {
  const out = new Set<number>();
  let last: number | null = null;
  times.forEach((time, i) => {
    if (!time) return;
    const t = new Date(time).getTime();
    if (Number.isNaN(t)) return;
    if (last === null || t - last >= SEPARATOR_GAP_MS) out.add(i);
    last = t;
  });
  return out;
}
