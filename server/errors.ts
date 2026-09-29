import type { ErrorRequestHandler, RequestHandler, Response } from "express";
import { ERROR_HTTP_STATUS, ErrorCode, type ErrorBody } from "@shared/errors";
import type { Logger } from "./logger.ts";

/** An error whose code and message are safe to show to the client. */
export class AppError extends Error {
  override name = "AppError";
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  /** Extra response headers, e.g. `Retry-After` for RATE_LIMITED. */
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.headers = headers;
  }

  get status(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}

export function errorBody(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ErrorBody {
  return { error: details ? { code, message, details } : { code, message } };
}

export function sendError(res: Response, error: AppError): void {
  res
    .status(error.status)
    .set(error.headers)
    .set("Cache-Control", "no-store")
    .json(errorBody(error.code, error.message, error.details));
}

/** Maps a body-parser error (`type` property) to a contract error, if it is one. */
function fromBodyParserError(err: unknown): AppError | undefined {
  if (typeof err !== "object" || err === null || !("type" in err)) return undefined;
  switch (err.type) {
    case "entity.too.large":
      return new AppError(ErrorCode.PAYLOAD_TOO_LARGE, "Request body is too large");
    case "entity.parse.failed":
      return new AppError(ErrorCode.VALIDATION, "Request body is not valid JSON");
    case "encoding.unsupported":
    case "charset.unsupported":
      return new AppError(ErrorCode.VALIDATION, "Unsupported request body encoding");
    case "request.aborted":
    case "request.size.invalid":
      return new AppError(ErrorCode.VALIDATION, "Request body was incomplete");
    default:
      return undefined;
  }
}

export function toAppError(err: unknown): AppError | undefined {
  if (err instanceof AppError) return err;
  return fromBodyParserError(err);
}

export const apiNotFound: RequestHandler = (_req, res) => {
  sendError(res, new AppError(ErrorCode.NOT_FOUND, "Not found"));
};

/**
 * Terminal API error middleware (INV-01). Contract errors pass through with
 * their safe message; anything else becomes INTERNAL without internals.
 */
export function apiErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const appError = toAppError(err);
    if (appError) {
      sendError(res, appError);
      return;
    }
    logger.error({ err, method: req.method, path: req.path }, "unhandled API error");
    sendError(res, new AppError(ErrorCode.INTERNAL, "Internal server error"));
  };
}
