import { z } from "zod";
import { PHOTO_SHAPES } from "./photo-shapes";

/** Profile DTOs (Phase 12b). Browser code imports only the types. */

export { PHOTO_SHAPES, type PhotoShape } from "./photo-shapes";

export const profileDtoSchema = z.strictObject({
  username: z.string(),
  role: z.enum(["user", "admin"]),
  createdAt: z.string(),
  /** Changes whenever the photo does (cache-busting query value); null without a photo. */
  photoVersion: z.string().nullable(),
  shape: z.enum(PHOTO_SHAPES),
});
export type ProfileDto = z.infer<typeof profileDtoSchema>;

export const profileStatsSchema = z.strictObject({
  timeZone: z.string(),
  /** Today in that time zone, `YYYY-MM-DD`. */
  today: z.string(),
  chats: z.number().int().nonnegative(),
  /** Messages you sent. */
  messages: z.number().int().nonnegative(),
  replies: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  activeDays: z.number().int().nonnegative(),
  currentStreak: z.number().int().nonnegative(),
  longestStreak: z.number().int().nonnegative(),
  /** Days with at least one message in the last 53 weeks. */
  days: z.array(z.strictObject({ date: z.string(), count: z.number().int().positive() })),
  favoriteModel: z.string().nullable(),
  /** 0 = Sunday … 6 = Saturday; null without messages. */
  busiestWeekday: z.number().int().min(0).max(6).nullable(),
  /** Hour 0–23 in that time zone; null without messages. */
  busiestHour: z.number().int().min(0).max(23).nullable(),
});
export type ProfileStats = z.infer<typeof profileStatsSchema>;
