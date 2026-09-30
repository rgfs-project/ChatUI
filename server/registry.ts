import type { ExportService } from "./portability/export.ts";
import type { ImportService } from "./portability/import.ts";
import type { ArtifactStore } from "./storage/artifacts.ts";
import type { MemoryStore } from "./storage/memories.ts";
import type { ProposalService } from "./chat/proposals.ts";
import { Router, type Request, type Response } from "express";
import type { ModelListDto } from "@shared/generations";
import type { AccountAdmin } from "./admin/accounts.ts";
import type { RateBucket, RequestLimits } from "./auth/rate-limit.ts";
import type { AuditLog } from "./admin/audit.ts";
import type { ProviderAdmin } from "./admin/providers.ts";
import type { SettingsStore } from "./admin/settings.ts";
import type { z } from "zod";
import type { HealthDto } from "@shared/api";
import type { ConversationDto } from "@shared/conversations";
import { ErrorCode } from "@shared/errors";
import type { AuthContext, AuthService } from "./auth/service.ts";
import type { SendService } from "./chat/send-service.ts";
import { AppError } from "./errors.ts";
import type { ModelCatalog } from "./generations/catalog.ts";
import type { GenerationManager } from "./generations/manager.ts";
import type { SseConnections, SseOptions } from "./generations/sse.ts";
import type { PreferencesStore } from "./storage/preferences.ts";
import type { SkillsStore } from "./storage/skills.ts";
import type { UserStore } from "./storage/users.ts";
import type { AttachmentStore } from "./storage/attachments.ts";
import type { ConversationMutations } from "./chat/mutations.ts";
import type { Logger } from "./logger.ts";
import type { ConversationStore } from "./storage/conversations.ts";
import type { OperationStore } from "./storage/operations.ts";
import { parseRequest, type ParsedRequest, type RequestSchemas } from "./validation.ts";

/**
 * Declarative API route registry (contracts §5). This is the only place that
 * registers Express API routes; ESLint forbids literal-path registrations
 * elsewhere in server/, and the coverage tests consume the same list.
 */

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/** Services a handler may use. Grows as phases add authorized services. */
export interface RouteServices {
  health: () => HealthDto;
  models: ModelCatalog;
  generations: GenerationManager;
  conversations: ConversationStore;
  operations: OperationStore;
  send: SendService;
  /** Loads a conversation DTO owned by `userId` (SSR loaders and API). */
  conversationDto: (userId: string, id: string) => Promise<ConversationDto>;
  auth: AuthService;
  /** Per-user request budgets (Phase 16). */
  limits: RequestLimits;
  users: UserStore;
  preferences: PreferencesStore;
  /** Edit, delete exchange, clear history, pins (Phase 13a). */
  mutations: ConversationMutations;
  /** Uploaded attachments (Phase 12). */
  attachments: AttachmentStore;
  /** Per-user skills (user request, Phase 10). */
  skills: SkillsStore;
  /** Approved memories and memory proposals (Phase 13b). */
  memories: MemoryStore;
  proposals: ProposalService;
  /** MEMORY_PROMPT_BUDGET: approved-note bytes a prompt may include. */
  memoryPromptBudgetBytes: number;
  /** Generated source artifacts (Phase 13c). */
  artifacts: ArtifactStore;
  /** Marks a generation's checkpoint `terminal` (artifact deletion, INV-40). */
  finalizeGeneration: (generationId: string) => Promise<void>;
  /** Portable export and import (Phase 13d). */
  exports: ExportService;
  imports: ImportService;
  /** Models a role may use: hidden pairs are removed for non-admins (Phase 10). */
  modelList: (role: "user" | "admin", options?: { fresh?: boolean }) => Promise<ModelListDto>;
  /** Phase 10 administration. */
  admin: {
    accounts: AccountAdmin;
    providers: ProviderAdmin;
    settings: SettingsStore;
    audit: AuditLog;
    /** Rebuilds the derived conversation index of one user, or every user. */
    rebuildIndex: (userId?: string) => Promise<number>;
  };
  sseConnections: SseConnections;
  sse: SseOptions;
  logger: Logger;
}

export interface RouteContext {
  req: Request;
  res: Response;
  services: RouteServices;
  /** The session identity, resolved server-side (INV-14); null when signed out. */
  auth: AuthContext | null;
}

/** The signed-in user of a `user` route (the registry guarantees it). */
export function userOf(ctx: RouteContext): AuthContext {
  if (!ctx.auth) throw new AppError(ErrorCode.UNAUTHENTICATED, "Sign in to continue");
  return ctx.auth;
}

interface RouteBase<S extends RequestSchemas> {
  method: HttpMethod;
  /** Express path, always under /api. */
  path: `/api/${string}`;
  /**
   * `public` routes work signed out; `user` routes require a session (401);
   * `admin` routes additionally require the admin role, resolved from the
   * fresh user record on every request, never from the client (403, INV-24).
   */
  auth: "public" | "user" | "admin";
  /**
   * `none` for safe methods; `token`: synchronizer token + X-Expected-User
   * (contracts §5); `origin`: same-origin check for login/registration.
   */
  csrf: "none" | "token" | "origin";
  /**
   * Per-user request budget (Phase 16): `generation` for routes that start a
   * generation, `upload` for uploads. Admin mutations default to `admin`.
   * Over budget → RATE_LIMITED with Retry-After, before validation.
   */
  rateLimit?: RateBucket;
  request: S;
  /**
   * Request used by the registry coverage tests, and the status it must
   * produce with no other state present (e.g. 404 for an unknown id).
   */
  fixture: {
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
    expectStatus?: number;
  };
}

export interface ApiRoute<
  S extends RequestSchemas = RequestSchemas,
  R extends z.ZodType = z.ZodType,
> extends RouteBase<S> {
  kind?: "json";
  /** Explicit response DTO schema; handler output is parsed through it (INV-03). */
  response: R;
  status?: number;
  handler: (input: ParsedRequest<S>, ctx: RouteContext) => z.input<R> | Promise<z.input<R>>;
}

/** A Server-Sent Events route: validated like any route, then owns the response. */
export interface SseRoute<S extends RequestSchemas = RequestSchemas> extends RouteBase<S> {
  kind: "sse";
  /** Must validate everything and throw AppErrors BEFORE opening the stream. */
  handler: (input: ParsedRequest<S>, ctx: RouteContext) => void;
}

/**
 * A route that writes its own non-JSON response (attachment bytes): validated
 * and policy-checked like any route; errors thrown before it writes headers
 * become contract errors.
 */
export interface RawRoute<S extends RequestSchemas = RequestSchemas> extends RouteBase<S> {
  kind: "raw";
  /** The handler chooses its own status. */
  status?: never;
  handler: (input: ParsedRequest<S>, ctx: RouteContext) => Promise<void>;
}

export function defineRawRoute<S extends RequestSchemas>(route: RawRoute<S>): RawRoute<S> {
  return route;
}

export function defineRoute<S extends RequestSchemas, R extends z.ZodType>(
  route: ApiRoute<S, R>,
): ApiRoute<S, R> {
  return route;
}

export function defineSseRoute<S extends RequestSchemas>(route: SseRoute<S>): SseRoute<S> {
  return route;
}

/** Type-erased form for heterogeneous route lists. */
export type AnyApiRoute = ApiRoute | SseRoute | RawRoute;

export function erase<S extends RequestSchemas, R extends z.ZodType>(
  route: ApiRoute<S, R> | SseRoute<S> | RawRoute<S>,
): AnyApiRoute {
  return route;
}

/** The request budget a route draws from (admin mutations by default). */
export function rateBucketOf(route: AnyApiRoute): RateBucket | undefined {
  if (route.rateLimit) return route.rateLimit;
  return route.auth === "admin" && route.method !== "get" ? "admin" : undefined;
}

export function buildApiRouter(routes: readonly AnyApiRoute[], services: RouteServices): Router {
  const router = Router();
  const seen = new Set<string>();
  for (const route of routes) {
    const key = `${route.method.toUpperCase()} ${route.path}`;
    if (seen.has(key)) throw new Error(`Duplicate API route registration: ${key}`);
    seen.add(key);
    // Paths are relative to the /api mount point.
    const mountedPath = route.path.slice("/api".length);
    // Policies run before validation and before the handler, for every route.
    const guard = async (req: Request, res: Response): Promise<RouteContext> => {
      const auth = await services.auth.resolve(req);
      if (route.auth !== "public" && !auth)
        throw new AppError(ErrorCode.UNAUTHENTICATED, "Sign in to continue");
      if (route.auth === "admin" && auth?.role !== "admin")
        throw new AppError(ErrorCode.FORBIDDEN, "Administrators only");
      if (route.csrf === "token") services.auth.checkMutation(req, auth);
      if (route.csrf === "origin") services.auth.checkOrigin(req);
      const bucket = rateBucketOf(route);
      if (bucket && auth) {
        const wait = services.limits.hit(bucket, auth.userId);
        if (wait > 0)
          throw new AppError(
            ErrorCode.RATE_LIMITED,
            "Too many requests; try again later",
            undefined,
            {
              "Retry-After": String(wait),
            },
          );
      }
      return { req, res, services, auth };
    };
    if (route.kind === "sse") {
      router[route.method](mountedPath, async (req, res) => {
        const ctx = await guard(req, res);
        route.handler(parseRequest(route.request, req), ctx);
      });
      continue;
    }
    if (route.kind === "raw") {
      router[route.method](mountedPath, async (req, res) => {
        const ctx = await guard(req, res);
        await route.handler(parseRequest(route.request, req), ctx);
      });
      continue;
    }
    router[route.method](mountedPath, async (req, res) => {
      const ctx = await guard(req, res);
      const input = parseRequest(route.request, req);
      const output: unknown = await route.handler(input, ctx);
      const dto: unknown = route.response.parse(output);
      res
        .status(route.status ?? 200)
        .set("Cache-Control", "no-store")
        .json(dto);
    });
  }
  return router;
}
