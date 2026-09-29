import { ErrorCode } from "@shared/errors";
import type { ProviderConfig } from "../config.ts";
import { SsrfError, type SafeFetch } from "./ssrf.ts";
import {
  ProviderError,
  type ChatRequest,
  type Provider,
  type ProviderEvent,
  type ProviderModel,
} from "./types.ts";

/**
 * OpenAI-compatible llama-server client. Behaviour follows what the Phase 2
 * probe observed (docs/provider-notes.md): router-mode `/v1/models` entries
 * carry `status.value` and, when loaded, `meta.n_ctx`; streaming chunks carry
 * `delta.content` / `delta.reasoning_content`, a finish chunk, and a final
 * `usage` + `timings` chunk before `data: [DONE]`.
 */

const DISCOVERY_TIMEOUT_MS = 10_000;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** OpenAI-compatible and llama.cpp sampling parameters, only those configured. */
function samplingFields(sampling: ChatRequest["sampling"]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!sampling) return out;
  if (sampling.temperature !== undefined) out.temperature = sampling.temperature;
  if (sampling.topP !== undefined) out.top_p = sampling.topP;
  if (sampling.topK !== undefined) out.top_k = sampling.topK;
  if (sampling.minP !== undefined) out.min_p = sampling.minP;
  if (sampling.repeatPenalty !== undefined) out.repeat_penalty = sampling.repeatPenalty;
  return out;
}

export function createLlamaCppProvider(
  config: Pick<ProviderConfig, "baseUrl" | "apiKey" | "timeoutMs" | "maxResponseBytes"> & {
    /** SSRF-checked, pinned, non-redirecting fetch (defaults to global fetch in unit tests). */
    fetch?: SafeFetch;
  },
): Provider {
  const { baseUrl } = config;

  /** Every outbound request goes through the SSRF policy when configured. */
  async function http(url: string, init: RequestInit): Promise<Response> {
    if (!config.fetch) return fetch(url, init);
    try {
      return (await config.fetch(url, init as never)) as unknown as Response;
    } catch (error) {
      if (error instanceof SsrfError) {
        throw new ProviderError(
          ErrorCode.PROVIDER_ERROR,
          "blocked",
          "The provider address is not allowed by the server's network policy",
        );
      }
      throw error;
    }
  }

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (config.apiKey) h.Authorization = `Bearer ${config.apiKey}`;
    return h;
  }

  function requireBaseUrl(): string {
    if (!baseUrl) {
      throw new ProviderError(
        ErrorCode.PROVIDER_UNAVAILABLE,
        "unreachable",
        "No model server is configured",
      );
    }
    return baseUrl;
  }

  /** Classifies a non-2xx upstream response without exposing its body. */
  async function httpError(res: Response): Promise<ProviderError> {
    let type: unknown;
    try {
      const body: unknown = JSON.parse(await readCapped(res, 64 * 1024));
      type = isObject(body) && isObject(body.error) ? body.error.type : undefined;
    } catch {
      type = undefined;
    }
    if (res.status === 401 || res.status === 403) {
      return new ProviderError(
        ErrorCode.PROVIDER_ERROR,
        "auth",
        "The model server rejected ChatUI's credentials",
      );
    }
    if (type === "exceed_context_size_error") {
      return new ProviderError(
        ErrorCode.PROVIDER_ERROR,
        "context_overflow",
        "The conversation is too long for the model's context window",
      );
    }
    if (res.status === 404 || (res.status === 400 && type === "invalid_request_error")) {
      // llama-server reports unknown models as 400 invalid_request_error.
      return new ProviderError(
        ErrorCode.PROVIDER_ERROR,
        "http",
        "The model server rejected the request",
      );
    }
    return new ProviderError(
      ErrorCode.PROVIDER_ERROR,
      "http",
      "The model server returned an error",
    );
  }

  async function readCapped(res: Response, limit: number): Promise<string> {
    if (!res.body) return "";
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    for await (const chunk of res.body) {
      bytes += chunk.byteLength;
      if (bytes > limit) {
        await res.body.cancel().catch(() => undefined);
        throw new ProviderError(
          ErrorCode.PROVIDER_ERROR,
          "too_large",
          "The model server response was too large",
        );
      }
      text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
  }

  async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const url = `${requireBaseUrl()}${path}`;
    const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
    let res: Response;
    try {
      res = await http(url, {
        headers: headers(),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (timeout.aborted) {
        throw new ProviderError(
          ErrorCode.PROVIDER_TIMEOUT,
          "timeout",
          "The model server did not respond in time",
        );
      }
      if (signal?.aborted) throw error;
      throw new ProviderError(
        ErrorCode.PROVIDER_UNAVAILABLE,
        "unreachable",
        "The model server is unreachable",
      );
    }
    if (!res.ok) throw await httpError(res);
    try {
      return JSON.parse(await readCapped(res, config.maxResponseBytes)) as unknown;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        ErrorCode.PROVIDER_ERROR,
        "invalid_response",
        "The model server sent an invalid response",
      );
    }
  }

  async function listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    const body = await getJson("/v1/models", signal);
    const data = isObject(body) && Array.isArray(body.data) ? body.data : undefined;
    if (!data) {
      throw new ProviderError(
        ErrorCode.PROVIDER_ERROR,
        "invalid_response",
        "The model server sent an invalid model list",
      );
    }
    const models: ProviderModel[] = [];
    for (const entry of data) {
      if (
        !isObject(entry) ||
        typeof entry.id !== "string" ||
        entry.id.length === 0 ||
        entry.id.length > 200
      )
        continue;
      const meta = isObject(entry.meta) ? entry.meta : undefined;
      const nCtx = meta?.n_ctx;
      const statusValue = isObject(entry.status) ? entry.status.value : undefined;
      // Router mode reports per-model input modalities (docs/provider-notes.md).
      const arch = isObject(entry.architecture) ? entry.architecture : undefined;
      const modalities = Array.isArray(arch?.input_modalities)
        ? arch.input_modalities.filter(
            (m): m is "text" | "image" | "audio" => m === "text" || m === "image" || m === "audio",
          )
        : undefined;
      models.push({
        id: entry.id,
        inputModalities: modalities && modalities.length > 0 ? modalities : undefined,
        contextTokens:
          typeof nCtx === "number" && Number.isSafeInteger(nCtx) && nCtx > 0 ? nCtx : undefined,
        status:
          statusValue === "loaded" || statusValue === "unloaded" || statusValue === "loading"
            ? statusValue
            : "unknown",
      });
    }
    return models;
  }

  async function discoverSlots(signal?: AbortSignal): Promise<number | undefined> {
    // Router mode reports no total_slots at /props (each model instance has its
    // own); querying per-model props could trigger an autoload, so we don't.
    const props = await getJson("/props", signal);
    const slots = isObject(props) ? props.total_slots : undefined;
    return typeof slots === "number" && Number.isSafeInteger(slots) && slots > 0
      ? slots
      : undefined;
  }

  async function postJson(path: string, body: unknown): Promise<unknown> {
    const url = `${requireBaseUrl()}${path}`;
    let res: Response;
    try {
      res = await http(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if ((error as Error).name === "TimeoutError") {
        throw new ProviderError(
          ErrorCode.PROVIDER_TIMEOUT,
          "timeout",
          "The model server did not respond in time",
        );
      }
      throw new ProviderError(
        ErrorCode.PROVIDER_UNAVAILABLE,
        "unreachable",
        "The model server is unreachable",
      );
    }
    if (!res.ok) throw await httpError(res);
    try {
      return JSON.parse(await readCapped(res, config.maxResponseBytes)) as unknown;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        ErrorCode.PROVIDER_ERROR,
        "invalid_response",
        "The model server sent an invalid response",
      );
    }
  }

  // Router mode needs the model as a query parameter (docs/provider-notes.md).
  const modelQuery = (model: string) => `?model=${encodeURIComponent(model)}`;

  async function tokenize(
    model: string,
    text: string,
    options: { special?: boolean } = {},
  ): Promise<number> {
    const body = await postJson(`/tokenize${modelQuery(model)}`, {
      model,
      content: text,
      ...(options.special ? { add_special: true, parse_special: true } : {}),
    });
    const tokens = isObject(body) ? body.tokens : undefined;
    if (!Array.isArray(tokens)) {
      throw new ProviderError(
        ErrorCode.PROVIDER_ERROR,
        "invalid_response",
        "The model server sent an invalid token list",
      );
    }
    return tokens.length;
  }

  async function applyTemplate(
    model: string,
    messages: { role: string; content: string }[],
  ): Promise<string> {
    const body = await postJson(`/apply-template${modelQuery(model)}`, { model, messages });
    const prompt = isObject(body) ? body.prompt : undefined;
    if (typeof prompt !== "string") {
      throw new ProviderError(
        ErrorCode.PROVIDER_ERROR,
        "invalid_response",
        "The model server sent an invalid template result",
      );
    }
    return prompt;
  }

  async function* streamChat(
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    const url = `${requireBaseUrl()}/v1/chat/completions`;
    // Inactivity timeout: to the response headers, then between chunks.
    const inactivity = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        inactivity.abort();
      }, config.timeoutMs);
    };
    const combined = AbortSignal.any([signal, inactivity.signal]);
    const timeoutError = () =>
      new ProviderError(
        ErrorCode.PROVIDER_TIMEOUT,
        "timeout",
        "The model server stopped responding",
      );

    arm();
    try {
      let res: Response;
      try {
        res = await http(url, {
          method: "POST",
          headers: { ...headers(), Accept: "text/event-stream" },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            max_tokens: request.maxTokens,
            ...samplingFields(request.sampling),
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: combined,
        });
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (inactivity.signal.aborted) throw timeoutError();
        if (signal.aborted) throw error;
        throw new ProviderError(
          ErrorCode.PROVIDER_UNAVAILABLE,
          "unreachable",
          "The model server is unreachable",
        );
      }
      if (!res.ok) throw await httpError(res);
      if (!res.body) {
        throw new ProviderError(
          ErrorCode.PROVIDER_ERROR,
          "invalid_response",
          "The model server sent no stream",
        );
      }
      yield { type: "start" };
      arm();

      const decoder = new TextDecoder();
      let buffer = "";
      let bytes = 0;
      let done = false;
      try {
        for await (const chunk of res.body) {
          arm();
          bytes += chunk.byteLength;
          if (bytes > config.maxResponseBytes) {
            throw new ProviderError(
              ErrorCode.PROVIDER_ERROR,
              "too_large",
              "The model server response was too large",
            );
          }
          buffer += decoder.decode(chunk, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, "");
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith("data:")) continue; // comments, event:, id:, blank lines
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              done = true;
              break;
            }
            yield* parseChunk(data);
          }
          if (done) break;
        }
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (inactivity.signal.aborted) throw timeoutError();
        if (signal.aborted) throw error;
        throw new ProviderError(
          ErrorCode.PROVIDER_UNAVAILABLE,
          "unreachable",
          "The connection to the model server was lost",
        );
      } finally {
        if (!done) await res.body.cancel().catch(() => undefined);
      }
      if (!done) {
        throw new ProviderError(
          ErrorCode.PROVIDER_ERROR,
          "invalid_response",
          "The model server ended the stream early",
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  function* parseChunk(data: string): Generator<ProviderEvent> {
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new ProviderError(
        ErrorCode.PROVIDER_ERROR,
        "invalid_response",
        "The model server sent an invalid stream",
      );
    }
    if (!isObject(chunk)) {
      throw new ProviderError(
        ErrorCode.PROVIDER_ERROR,
        "invalid_response",
        "The model server sent an invalid stream",
      );
    }
    if (isObject(chunk.error)) {
      const type = chunk.error.type;
      throw type === "exceed_context_size_error"
        ? new ProviderError(
            ErrorCode.PROVIDER_ERROR,
            "context_overflow",
            "The conversation is too long for the model's context window",
          )
        : new ProviderError(ErrorCode.PROVIDER_ERROR, "http", "The model server reported an error");
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice: unknown = choices[0];
    if (isObject(choice)) {
      const delta = isObject(choice.delta) ? choice.delta : {};
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        yield { type: "reasoning", text: delta.reasoning_content };
      }
      if (typeof delta.content === "string" && delta.content) {
        yield { type: "content", text: delta.content };
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        yield { type: "finish", reason: choice.finish_reason.slice(0, 40) };
      }
    }
    if (isObject(chunk.usage)) {
      const { prompt_tokens: prompt, completion_tokens: completion } = chunk.usage;
      const details = isObject(chunk.usage.prompt_tokens_details)
        ? chunk.usage.prompt_tokens_details
        : {};
      if (typeof prompt === "number" && typeof completion === "number") {
        yield {
          type: "usage",
          promptTokens: prompt,
          completionTokens: completion,
          cachedTokens:
            typeof details.cached_tokens === "number" ? details.cached_tokens : undefined,
        };
      }
    }
  }

  return { listModels, discoverSlots, tokenize, applyTemplate, streamChat };
}
