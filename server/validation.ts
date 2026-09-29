import type { Request } from "express";
import { z } from "zod";
import { ErrorCode } from "@shared/errors";
import { AppError } from "./errors.ts";

/**
 * Strict request schemas (INV-02). Every part is a strict object: unknown
 * fields are rejected. An omitted part must be empty.
 */
export interface RequestSchemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}

type Infer<S, K extends keyof RequestSchemas> =
  S extends Record<K, infer T extends z.ZodType> ? z.infer<T> : Record<string, never>;

export interface ParsedRequest<S extends RequestSchemas> {
  params: Infer<S, "params">;
  query: Infer<S, "query">;
  body: Infer<S, "body">;
}

const empty = z.strictObject({});

function isEmptyBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  return typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0;
}

function issuesOf(part: string, error: z.ZodError): { path: string; message: string }[] {
  return error.issues.slice(0, 20).map((issue) => ({
    path: [part, ...issue.path.map(String)].join("."),
    message: issue.message,
  }));
}

export function parseRequest<S extends RequestSchemas>(
  schemas: S,
  req: Pick<Request, "params" | "query" | "body">,
): ParsedRequest<S> {
  const issues: { path: string; message: string }[] = [];
  const result: Record<string, unknown> = {};

  for (const part of ["params", "query", "body"] as const) {
    const schema = schemas[part];
    const raw: unknown = req[part];
    if (!schema) {
      if (part === "body" ? !isEmptyBody(raw) : !empty.safeParse(raw ?? {}).success) {
        issues.push({ path: part, message: "Not accepted by this endpoint" });
      }
      result[part] = {};
      continue;
    }
    const parsed = schema.safeParse(part === "body" ? raw : { ...(raw as object) });
    if (parsed.success) {
      result[part] = parsed.data;
    } else {
      issues.push(...issuesOf(part, parsed.error));
    }
  }

  if (issues.length > 0) {
    throw new AppError(ErrorCode.VALIDATION, "Request validation failed", { issues });
  }
  return result as unknown as ParsedRequest<S>;
}
