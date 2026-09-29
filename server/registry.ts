import { Router, type Request, type Response } from "express";
import type { z } from "zod";
import type { HealthDto } from "@shared/api";
import type { ModelCatalog } from "./generations/catalog.ts";
import type { GenerationManager } from "./generations/manager.ts";
import type { SseOptions } from "./generations/sse.ts";
import type { Logger } from "./logger.ts";
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
  sse: SseOptions;
  logger: Logger;
  /**
   * The pre-auth chat demo (Phases 2–3) is available only on the
   * loopback-guarded host process, never in the container (contracts §9.2b).
   */
  chatDemoEnabled: boolean;
}

export interface RouteContext {
  req: Request;
  res: Response;
  services: RouteServices;
}

interface RouteBase<S extends RequestSchemas> {
  method: HttpMethod;
  /** Express path, always under /api. */
  path: `/api/${string}`;
  /** Authentication policy. Only `public` exists before Phase 4. */
  auth: "public";
  /** CSRF policy. Only `none` exists before Phase 4. */
  csrf: "none";
  /**
   * `chat-demo` routes are registered only when the pre-auth chat demo is
   * enabled; otherwise they do not exist (404).
   */
  availability?: "always" | "chat-demo";
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

export function defineRoute<S extends RequestSchemas, R extends z.ZodType>(
  route: ApiRoute<S, R>,
): ApiRoute<S, R> {
  return route;
}

export function defineSseRoute<S extends RequestSchemas>(route: SseRoute<S>): SseRoute<S> {
  return route;
}

/** Type-erased form for heterogeneous route lists. */
export type AnyApiRoute = ApiRoute | SseRoute;

export function erase<S extends RequestSchemas, R extends z.ZodType>(
  route: ApiRoute<S, R> | SseRoute<S>,
): AnyApiRoute {
  return route;
}

export function buildApiRouter(routes: readonly AnyApiRoute[], services: RouteServices): Router {
  const router = Router();
  const seen = new Set<string>();
  for (const route of routes) {
    const key = `${route.method.toUpperCase()} ${route.path}`;
    if (seen.has(key)) throw new Error(`Duplicate API route registration: ${key}`);
    seen.add(key);
    if (route.availability === "chat-demo" && !services.chatDemoEnabled) continue;
    // Paths are relative to the /api mount point.
    const mountedPath = route.path.slice("/api".length);
    if (route.kind === "sse") {
      router[route.method](mountedPath, (req, res) => {
        route.handler(parseRequest(route.request, req), { req, res, services });
      });
      continue;
    }
    router[route.method](mountedPath, async (req, res) => {
      const input = parseRequest(route.request, req);
      const output: unknown = await route.handler(input, { req, res, services });
      const dto: unknown = route.response.parse(output);
      res
        .status(route.status ?? 200)
        .set("Cache-Control", "no-store")
        .json(dto);
    });
  }
  return router;
}
