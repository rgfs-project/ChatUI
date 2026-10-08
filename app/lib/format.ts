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

/**
 * Escapes "$" signs that are prices, not math, before markdown parsing.
 * Pandoc's rule: an opening $ is followed by non-space, and a closing $
 * is preceded by non-space and not followed by a digit. "$350 card … $8,000"
 * fails it, so the first $ is escaped and stays literal. Code (fenced or
 * inline) and $$display$$ math are left alone; pairs never cross a blank line.
 */
export function escapeCurrency(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .split(/(\n\s*\n)/)
            .map(fixBlock)
            .join(""),
    )
    .join("");
}

function fixBlock(block: string): string {
  const singles: number[] = [];
  for (let i = 0; i < block.length; i++) {
    if (block[i] === "\\") {
      i++;
      continue;
    }
    if (block[i] !== "$") continue;
    if (block[i + 1] === "$") {
      i++;
      continue;
    }
    singles.push(i);
  }
  const escape = new Set<number>();
  let k = 0;
  while (k < singles.length) {
    const open = singles[k] ?? 0;
    const close = singles[k + 1];
    const opensOk = !/\s/.test(block[open + 1] ?? " ");
    if (
      close !== undefined &&
      opensOk &&
      !/\s/.test(block[close - 1] ?? " ") &&
      !/\d/.test(block[close + 1] ?? "")
    ) {
      k += 2;
      continue;
    }
    escape.add(open);
    k += 1;
  }
  if (escape.size === 0) return block;
  let out = "";
  for (let i = 0; i < block.length; i++) out += (escape.has(i) ? "\\" : "") + (block[i] ?? "");
  return out;
}
