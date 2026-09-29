/**
 * Canonical API error contract (contracts §5). Each phase adds only the codes it
 * uses: Phase 1a the four foundation codes, Phase 2 provider/generation codes,
 * Phase 3 persistence and send-acceptance codes.
 */
export const ErrorCode = {
  VALIDATION: "VALIDATION",
  NOT_FOUND: "NOT_FOUND",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  INTERNAL: "INTERNAL",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  GENERATION_NOT_FOUND: "GENERATION_NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  CONVERSATION_MALFORMED: "CONVERSATION_MALFORMED",
  GENERATION_IN_PROGRESS: "GENERATION_IN_PROGRESS",
  CONTEXT_TOO_LARGE: "CONTEXT_TOO_LARGE",
  OPERATION_KEY_MISMATCH: "OPERATION_KEY_MISMATCH",
  OPERATION_EXPIRED: "OPERATION_EXPIRED",
  CONFLICT: "CONFLICT",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
  PROVIDER_UNAVAILABLE: 502,
  PROVIDER_ERROR: 502,
  PROVIDER_TIMEOUT: 504,
  MODEL_NOT_FOUND: 400,
  GENERATION_NOT_FOUND: 404,
  RATE_LIMITED: 429,
  CONVERSATION_MALFORMED: 422,
  GENERATION_IN_PROGRESS: 409,
  CONTEXT_TOO_LARGE: 422,
  OPERATION_KEY_MISMATCH: 409,
  OPERATION_EXPIRED: 409,
  CONFLICT: 409,
};

/** `details` never contains stack traces, paths, upstream bodies or secrets. */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}
