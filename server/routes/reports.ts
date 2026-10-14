import { z } from "zod";
import { REPORT_LIMITS } from "@shared/reports";
import { defineRoute, userOf } from "../registry.ts";

/**
 * Help → Report a problem: the user's own description (and, if they chose,
 * the page and browser) becomes a log entry administrators read in
 * Settings → Logs. Recorded whatever the log level is set to.
 */
const reportSchema = z.strictObject({
  description: z.string().trim().min(1).max(REPORT_LIMITS.maxDescription),
  page: z.string().max(REPORT_LIMITS.maxPage).optional(),
  userAgent: z.string().max(REPORT_LIMITS.maxUserAgent).optional(),
});

export const createReportRoute = defineRoute({
  method: "post",
  path: "/api/reports",
  auth: "user",
  csrf: "token",
  rateLimit: "upload",
  request: { body: reportSchema },
  response: z.strictObject({ ok: z.literal(true) }),
  status: 201,
  handler: async ({ body }, ctx) => {
    const user = userOf(ctx);
    const first = body.description.split("\n")[0] ?? "";
    await ctx.services.admin.events.record({
      // Reports are kept even when the level hides warnings and below.
      level: "error",
      source: "reports",
      message: `Problem report: ${first.length > 120 ? `${first.slice(0, 119)}…` : first}`,
      user: { id: user.userId, username: user.username },
      details: [
        body.description,
        ...(body.page ? ["", `Page: ${body.page}`] : []),
        ...(body.userAgent ? [`Browser: ${body.userAgent}`] : []),
      ].join("\n"),
    });
    return { ok: true as const };
  },
  fixture: { body: { description: "Fixture report" } },
});
