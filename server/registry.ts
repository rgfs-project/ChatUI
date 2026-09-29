import { Router, type Request, type Response } from "express";
import type { z } from "zod";
import type { HealthDto } from "@shared/api";
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
}

export interface RouteContext {
  req: Request;
  res: Response;
  services: RouteServices;
}

export interface ApiRoute<
  S extends RequestSchemas = RequestSchemas,
  R extends z.ZodType = z.ZodType,
> {
  method: HttpMethod;
  /** Express path, always under /api. */
  path: `/api/${string}`;
  /** Authentication policy. Only `public` exists before Phase 4. */
  auth: "public";
  /** CSRF policy. Only `none` exists before Phase 4 (no state-changing routes yet). */
  csrf: "none";
  request: S;
  /** Explicit response DTO schema; handler output is parsed through it (INV-03). */
  response: R;
  status?: number;
  handler: (input: ParsedRequest<S>, ctx: RouteContext) => z.input<R> | Promise<z.input<R>>;
  /** Minimal valid request used by the registry coverage tests. */
  fixture: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown };
}

export function defineRoute<S extends RequestSchemas, R extends z.ZodType>(
  route: ApiRoute<S, R>,
): ApiRoute<S, R> {
  return route;
}

/** Type-erased form for heterogeneous route lists. */
export type AnyApiRoute = ApiRoute;

export function erase<S extends RequestSchemas, R extends z.ZodType>(
  route: ApiRoute<S, R>,
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
    // Paths are relative to the /api mount point.
    const mountedPath = route.path.slice("/api".length);
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
