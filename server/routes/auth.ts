import { z } from "zod";
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
  sessionDtoSchema,
} from "@shared/auth";
import { defineRoute, userOf } from "../registry.ts";

/** Session status: public; the browser-safe bootstrap (contracts §5). */
export const sessionRoute = defineRoute({
  method: "get",
  path: "/api/auth/session",
  auth: "public",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: sessionDtoSchema,
  handler: (_input, ctx) => ctx.services.auth.sessionDto(ctx.auth),
  fixture: {},
});

export const loginRoute = defineRoute({
  method: "post",
  path: "/api/auth/login",
  auth: "public",
  csrf: "origin",
  request: { body: loginRequestSchema },
  response: sessionDtoSchema,
  handler: ({ body }, ctx) =>
    ctx.services.auth.login(ctx.req, ctx.res, body.username, body.password),
  fixture: { body: { username: "nobody", password: "wrong-password" }, expectStatus: 403 },
});

export const registerRoute = defineRoute({
  method: "post",
  path: "/api/auth/register",
  auth: "public",
  csrf: "origin",
  request: { body: registerRequestSchema },
  response: sessionDtoSchema,
  status: 201,
  handler: ({ body }, ctx) =>
    ctx.services.auth.register(ctx.req, ctx.res, body.username, body.password),
  fixture: { body: { username: "someone", password: "long-enough-pw" }, expectStatus: 403 },
});

export const logoutRoute = defineRoute({
  method: "post",
  path: "/api/auth/logout",
  auth: "user",
  csrf: "token",
  request: {},
  response: z.strictObject({ signedOut: z.literal(true) }),
  handler: async (_input, ctx) => {
    await ctx.services.auth.logout(ctx.res, userOf(ctx));
    return { signedOut: true as const };
  },
  fixture: { expectStatus: 401 },
});

/** Change own password: revokes every session and requires a new login. */
export const changePasswordRoute = defineRoute({
  method: "post",
  path: "/api/auth/password",
  auth: "user",
  csrf: "token",
  request: { body: changePasswordRequestSchema },
  response: z.strictObject({ reauthenticate: z.literal(true) }),
  handler: async ({ body }, ctx) => {
    await ctx.services.auth.changePassword(
      ctx.res,
      userOf(ctx),
      body.currentPassword,
      body.newPassword,
    );
    return { reauthenticate: true as const };
  },
  fixture: { body: { currentPassword: "x", newPassword: "y" }, expectStatus: 401 },
});
