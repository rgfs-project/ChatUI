/**
 * Avatar colours and the photo URL: zod-free, so the sidebar can show a
 * profile on the critical path without pulling in the schema library.
 */
export const AVATAR_COLORS = {
  black: "#0d0d0d",
  blue: "#2563eb",
  green: "#16a34a",
  amber: "#b45309",
  red: "#dc2626",
  purple: "#9333ea",
  pink: "#db2777",
} as const;
export type AvatarColor = keyof typeof AVATAR_COLORS;
export const AVATAR_COLOR_NAMES = Object.keys(AVATAR_COLORS) as AvatarColor[];

export function isAvatarColor(value: unknown): value is AvatarColor {
  return typeof value === "string" && value in AVATAR_COLORS;
}

/** Where a photo is served; the version busts caches after a change. */
export function photoUrl(userId: string, version: string): string {
  return `/api/account/photo?u=${encodeURIComponent(userId)}&v=${encodeURIComponent(version)}`;
}
