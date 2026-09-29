# llama.cpp provider notes

Observed behaviour of a live `llama-server`, recorded by `scripts/probe-provider.ts` (Phase 2). Everything below was **observed live** on 2026-09-29 unless marked **UNVERIFIED**. Re-run the probe after upgrading llama.cpp:

```bash
LLAMA_BASE_URL=http://<host>:<port> LLAMA_API_KEY=<key> node scripts/probe-provider.ts [model]
```

The probe exercises only one model (the named one, or the first `loaded` one), so it never makes a router-mode server load or evict other models.

## Environment probed

| Item          | Value                                                                                  |
| ------------- | -------------------------------------------------------------------------------------- |
| Server        | `llama-server` build `b11028-972d2313b`, **router mode** (`/props` → `role: "router"`) |
| Models listed | 8 (1 loaded: `Gemma 4`, a 12B QAT Q4 GGUF with vision/audio projector)                 |
| Model probed  | `Gemma 4`                                                                              |
| Hardware      | Remote GPU host on the LAN (not the ChatUI host)                                       |

## `/v1/models`

- Shape: `{ object: "list", data: [ { id, aliases, tags, object, owned_by, created, status: { value, args[], preset }, architecture: { input_modalities[], output_modalities[] }, source, can_remove, meta? } ] }`.
- `id` is the preset/alias name exactly as configured, **including spaces and dots** (`"Gemma 4"`, `"Qwen 3.6"`, `"gemma-4-12b-qat"`). ChatUI treats ids as opaque strings (1–200 chars).
- `status.value` is `loaded` or `unloaded` (router mode). `loading` is assumed from llama.cpp's router design: **UNVERIFIED**.
- `meta` (including `n_ctx`, `n_ctx_train`, `n_params`, `size`) is present **only for loaded models**.
- `status.args` and `status.preset` contain **server command lines and filesystem paths**. ChatUI never forwards them (INV-04); `/api/models` returns only `{ id, contextTokens, status }`.
- `architecture.input_modalities` reports `text`/`image`/`audio` per model. Not used before Phase 5/12.

## Authentication

- With `--api-key-file`, every `/v1/*`, `/props`, `/slots`, `/tokenize` and `/apply-template` request without a valid `Authorization: Bearer <key>` returns **401** `{ error: { message, type, code } }`. A wrong key also returns 401.
- `/health` is unauthenticated (`{"status":"ok"}`).
- ChatUI maps 401/403 to `PROVIDER_ERROR` ("rejected ChatUI's credentials") without the upstream body.
- Behaviour without `--api-key` configured on the server: **UNVERIFIED** (the probed server requires a key). llama.cpp documents that no key means no auth.

## Context length and slots

- Router `/props`: `role: "router"`, **no `total_slots`**, `default_generation_settings.n_ctx` absent/0.
- Per-model `/props?model=Gemma%204`: `total_slots: 1`, `default_generation_settings.n_ctx: 262144`, `modalities: { vision, video, audio }`, `chat_template` present.
- `/slots` without `?model=` → 400 in router mode. `/slots?model=Gemma%204` → 1 slot with `n_ctx: 262144` (the full context goes to the single slot).
- **ChatUI behaviour:**
  - Context length comes from `/v1/models` `meta.n_ctx` for loaded models, else `DEFAULT_CONTEXT_TOKENS`.
  - The default `MAX_ACTIVE_GENERATIONS` comes from `/props` `total_slots` (non-router servers), else **1**.
  - ChatUI deliberately does **not** call `/props?model=` for discovery, because in router mode it can autoload a model (`models_autoload`). Whether a per-model `/props` call on an _unloaded_ model triggers a load: **UNVERIFIED** (not tried, to avoid evicting the operator's loaded model).
- Non-router servers report `total_slots` at `/props` per llama.cpp docs: **UNVERIFIED** here.

## Tokenization and chat templates

- `POST /tokenize?model=<id>` with `{ content, model }` → `{ tokens: [...] }` (router mode needs the model).
- `POST /apply-template?model=<id>` with `{ messages, model }` → `{ prompt }` (the model's chat template applied). Tokenizing that prompt with `add_special: true, parse_special: true` counts the **formatted** prompt: a 2-message sample was 36 tokens.
- Token counts vs UTF-8 bytes (Gemma 4 tokenizer):

| Sample                          | Tokens | UTF-8 bytes |
| ------------------------------- | -----: | ----------: |
| English sentence                |     10 |          44 |
| Multilingual (de/ja/ru/ar)      |     16 |         100 |
| Emoji incl. ZWJ family and flag |     15 |          52 |
| TypeScript code                 |     24 |          69 |

All counts are ≤ bytes, consistent with the contracts §4 pessimistic fallback (1 token per byte). Exact counting is used from Phase 3.

## Streaming (`POST /v1/chat/completions`, `stream: true`)

- `Content-Type: text/event-stream`. Frames are `data: <json>\n\n`, terminated by `data: [DONE]`.
- Chunk sequence observed:
  1. `choices[0].delta = { role: "assistant", content: null }`
  2. zero or more `delta.reasoning_content` chunks (**Gemma 4 emits reasoning by default** on this server)
  3. `delta.content` chunks
  4. a finish chunk: `delta: {}`, `finish_reason: "stop"` (or `"length"` when `max_tokens` is hit, also observed)
  5. with `stream_options.include_usage: true`: a final chunk with `choices: []`, `usage { prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details.cached_tokens }` and `timings { cache_n, prompt_n, prompt_ms, predicted_n, predicted_ms, … }`
- Every chunk carries `id`, `created`, `model`, `system_fingerprint`, `object`. ChatUI forwards none of these.
- `reasoning_content` and `content` never appeared in the same chunk. ChatUI handles both anyway, emitting reasoning first.
- Reasoning _without_ `--reasoning-format` settings, or with models that inline `<think>` tags: **UNVERIFIED**. ChatUI only separates `reasoning_content`.

## Latency and prompt-cache reuse

| Request                         | prompt tokens | `cache_n` | `prompt_n` |   TTFT |
| ------------------------------- | ------------: | --------: | ---------: | -----: |
| Short prompt (cold)             |            33 |         6 |         27 | 47.9 s |
| Same prompt, `max_tokens: 4`    |            33 |        28 |          5 | 28.9 s |
| 1,228-token prefix (first)      |         1,228 |         5 |      1,223 | 39.4 s |
| Same prefix, different question |         1,228 |     1,221 |          7 | 18.8 s |

- **Prefix reuse works.** A request sharing the previous prompt's prefix reprocessed only 7 of 1,228 tokens, which is the basis for the prefix-stable truncation in contracts §4.
- **High fixed latency.** Even a handful of new tokens took 18–36 s of `prompt_ms`, and generation ran at ~22 tokens/s. This looks like a property of this deployment (e.g. f16 KV cache at 262k context with flash attention off), not of ChatUI. `PROVIDER_TIMEOUT_MS` therefore defaults to **300 s** of inactivity, covering the time to the first chunk and the gaps between chunks.
- Whether llama-server sends the role chunk before prompt processing completes: **UNVERIFIED** (TTFT was measured on the first content/reasoning chunk). ChatUI enters `streaming` when response headers arrive.

## Errors

| Case                                           | Status                         | Body shape                                                   | `error.type`                |
| ---------------------------------------------- | ------------------------------ | ------------------------------------------------------------ | --------------------------- |
| Unknown model                                  | 400                            | `{ error: { code, message, type } }`                         | `invalid_request_error`     |
| Prompt over context (340,804 > 262,144 tokens) | 400 after ~12 s (tokenization) | `{ error: { code, message, type, n_prompt_tokens, n_ctx } }` | `exceed_context_size_error` |
| Missing/wrong key                              | 401                            | `{ error: { message, type, code } }`                         | —                           |

ChatUI classifies only by status and `error.type`. Messages are ChatUI's own; upstream text never reaches clients. A context overflow after `202` ends the generation as `failed` with "The conversation is too long for the model's context window".

## Router / multi-model behaviour

- One process serves many presets. Requests name a model; unloaded models are loaded on demand (`models_autoload`). Autoload latency and eviction policy: **UNVERIFIED** (not triggered by the probe).
- The UI marks unloaded models "(not loaded)" and preselects a loaded one.

## Container networking (Docker / rootless Podman)

- Inside the ChatUI container, `localhost` is the container itself. Use:
  - a LAN address (as in this deployment: the llama host is a different machine), or
  - `host.containers.internal` (Podman, built in), or
  - `host.docker.internal` plus `extra_hosts: ["host.docker.internal:host-gateway"]` (Docker Engine on Linux; commented in `compose.yaml`).
- `node server/cli.ts provider:check` tests DNS, routing and credentials from inside the container without printing secrets. `verify:compose` runs it against a mock llama-server on the CI host for Docker (LAN address and `host-gateway`) and rootless Podman (LAN address and `host.containers.internal`). Results are in the Phase 2 report.
- The llama-server must listen beyond `127.0.0.1` on its host for a container to reach it.
