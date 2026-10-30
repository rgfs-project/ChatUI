// Profile statistics (Phase 12b), computed from canonical conversations only.
import type { ProfileStats } from "@shared/profile";
import type { ConversationModel } from "../storage/markdown.ts";

const DAY_MS = 86_400_000;
/** The activity grid covers 53 weeks. */
const ACTIVITY_DAYS = 53 * 7;

function dayFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** `YYYY-MM-DD` → days since the epoch (calendar arithmetic, no time zone). */
function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

/**
 * Counts, streaks and daily activity from user messages in `timeZone`.
 * Streaks are consecutive calendar days with a message; the current streak
 * still counts when today has no message yet but yesterday did.
 */
export function computeStats(
  conversations: readonly ConversationModel[],
  options: { timeZone: string; now: Date; files: number },
): ProfileStats {
  const days = dayFormatter(options.timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: options.timeZone,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  });
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const perDay = new Map<string, number>();
  const weekdays = Array<number>(7).fill(0);
  const hours = Array<number>(24).fill(0);
  const models = new Map<string, number>();
  let messages = 0;
  let replies = 0;
  for (const conversation of conversations) {
    for (const block of conversation.blocks) {
      if (block.type === "assistant") {
        replies++;
        if (block.model) models.set(block.model, (models.get(block.model) ?? 0) + 1);
      }
      if (block.type !== "user") continue;
      messages++;
      if (!block.time) continue;
      const at = new Date(block.time);
      if (Number.isNaN(at.getTime())) continue;
      const day = days.format(at);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
      const fields = Object.fromEntries(parts.formatToParts(at).map((p) => [p.type, p.value]));
      const weekday = WEEKDAYS.indexOf(fields.weekday ?? "");
      if (weekday >= 0) weekdays[weekday] = (weekdays[weekday] ?? 0) + 1;
      const hour = Number(fields.hour);
      if (Number.isInteger(hour) && hour >= 0 && hour < 24) hours[hour] = (hours[hour] ?? 0) + 1;
    }
  }

  const today = days.format(options.now);
  const todayNumber = dayNumber(today);
  const active = new Set([...perDay.keys()].map(dayNumber));
  let longest = 0;
  let run = 0;
  for (const day of [...active].sort((a, b) => a - b)) {
    run = active.has(day - 1) ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  let current = 0;
  let cursor = active.has(todayNumber) ? todayNumber : todayNumber - 1;
  while (active.has(cursor)) {
    current++;
    cursor--;
  }

  const since = todayNumber - ACTIVITY_DAYS + 1;
  const argmax = (values: number[]) => {
    const max = Math.max(...values);
    return max > 0 ? values.indexOf(max) : null;
  };
  let favoriteModel: string | null = null;
  let best = 0;
  for (const [model, count] of models) {
    if (count > best) {
      best = count;
      favoriteModel = model;
    }
  }
  return {
    timeZone: options.timeZone,
    today,
    chats: conversations.length,
    messages,
    replies,
    files: options.files,
    activeDays: active.size,
    currentStreak: current,
    longestStreak: longest,
    days: [...perDay]
      .filter(([date]) => dayNumber(date) >= since && dayNumber(date) <= todayNumber)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count })),
    favoriteModel,
    busiestWeekday: argmax(weekdays),
    busiestHour: argmax(hours),
  };
}
