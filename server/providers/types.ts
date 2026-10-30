import type { PromptMessage } from "../chat/prompt.ts";
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
  /** Discovered input modalities, when the provider reports them reliably. */
  inputModalities?: ("text" | "image" | "audio")[] | undefined;
  contextTokens: number | undefined;
  status: "loaded" | "unloaded" | "loading" | "unknown";
}

/** The assistant's tool calls of an earlier round (D2 tool loop; never stored). */
export interface ToolCallMessage {
  role: "assistant";
  content: string | null;
  tool_calls: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

/** A tool result for one call id (D2 tool loop; never stored). */
export interface ToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type ProviderMessage = PromptMessage | ToolCallMessage | ToolResultMessage;

export interface ChatRequest {
  model: string;
  /** Text or typed content parts (images, audio; Phase 12), plus tool-loop messages. */
  messages: ProviderMessage[];
  /** Offered tools (D2); omitted on the last request of a tool loop. */
  tools?: {
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }[];
  maxTokens: number;
  /** Reasoning on or off (Phase 15); omitted leaves the model's default. */
  think?: boolean;
  /** Per-model sampling overrides (Phase 10, validated by the admin settings schema). */
  sampling?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    minP?: number;
    repeatPenalty?: number;
  };
}

export type ProviderEvent =
  /** Upstream accepted the request (HTTP 200 headers received). */
  | { type: "start" }
  | { type: "content"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "finish"; reason: string }
  /** A streamed fragment of tool call `index` (id and name usually arrive first). */
  | { type: "tool_call"; index: number; id?: string; name?: string; arguments?: string }
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
    | "blocked"
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
