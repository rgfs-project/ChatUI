import type { ChatMessage } from "@shared/generations";
import type { ErrorCode } from "@shared/errors";

/** Minimal provider surface for generation: list models, stream, cancel (abort). */
export interface Provider {
  listModels(signal?: AbortSignal): Promise<ProviderModel[]>;
  /** Discovered parallel slot count, if the provider reports one. */
  discoverSlots(signal?: AbortSignal): Promise<number | undefined>;
  /** Token count of `text` with the model's tokenizer. */
  tokenize(model: string, text: string, options?: { special?: boolean }): Promise<number>;
  /** The model's chat template applied to `messages` (the formatted prompt). */
  applyTemplate(model: string, messages: { role: string; content: string }[]): Promise<string>;
  /** Streams one chat completion. Aborting `signal` cancels the upstream request. */
  streamChat(request: ChatRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent>;
}

export interface ProviderModel {
  id: string;
  contextTokens: number | undefined;
  status: "loaded" | "unloaded" | "loading" | "unknown";
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
}

export type ProviderEvent =
  /** Upstream accepted the request (HTTP 200 headers received). */
  | { type: "start" }
  | { type: "content"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "finish"; reason: string }
  | {
      type: "usage";
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number | undefined;
    };

export type ProviderErrorCode =
  | typeof ErrorCode.PROVIDER_UNAVAILABLE
  | typeof ErrorCode.PROVIDER_ERROR
  | typeof ErrorCode.PROVIDER_TIMEOUT
  | typeof ErrorCode.MODEL_NOT_FOUND;

/**
 * Normalized provider failure. `message` is always ours and safe for clients;
 * upstream bodies are never included (INV-04).
 */
export class ProviderError extends Error {
  override name = "ProviderError";
  readonly code: ProviderErrorCode;
  /** Finer classification for UI/tests, never an upstream string. */
  readonly kind:
    | "unreachable"
    | "http"
    | "invalid_response"
    | "too_large"
    | "timeout"
    | "context_overflow"
    | "unknown_model"
    | "auth";

  constructor(code: ProviderErrorCode, kind: ProviderError["kind"], message: string) {
    super(message);
    this.code = code;
    this.kind = kind;
  }
}
