/**
 * Canonical API error contract (contracts §5). Each phase adds only the codes it
 * uses; Phase 1a introduces the four foundation codes.
 */
export const ErrorCode = {
  VALIDATION: "VALIDATION",
  NOT_FOUND: "NOT_FOUND",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
};

/** `details` never contains stack traces, paths, upstream bodies or secrets. */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}
