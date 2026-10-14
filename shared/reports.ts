/**
 * Problem reports (Help → Report a problem): a user's description plus,
 * optionally, the page and browser they were on. Stored as log entries an
 * administrator reads in Settings → Logs. Kept free of zod: the client imports
 * the limits; the server owns the request schema.
 */
export const REPORT_LIMITS = {
  maxDescription: 4_000,
  maxPage: 300,
  maxUserAgent: 300,
} as const;

export interface ReportInput {
  description: string;
  page?: string;
  userAgent?: string;
}
