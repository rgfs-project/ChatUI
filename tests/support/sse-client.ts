/** Minimal SSE client for tests: parses `id`/`event`/`data` frames from fetch. */
export interface SseFrame {
  id: number | undefined;
  event: string;
  data: unknown;
}

export interface SseResult {
  status: number;
  headers: Headers;
  frames: SseFrame[];
  comments: number;
  raw: string;
}

export async function readSse(
  url: string,
  options: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    until?: (frame: SseFrame, frames: SseFrame[]) => boolean;
  } = {},
): Promise<SseResult> {
  const res = await fetch(url, {
    headers: { Accept: "text/event-stream", ...options.headers },
    signal: options.signal,
  });
  const result: SseResult = {
    status: res.status,
    headers: res.headers,
    frames: [],
    comments: 0,
    raw: "",
  };
  if (!res.body || !res.headers.get("content-type")?.startsWith("text/event-stream")) {
    result.raw = await res.text();
    return result;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      result.raw += text;
      buffer += text;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith(":")) {
          result.comments++;
          continue;
        }
        const frame: SseFrame = { id: undefined, event: "message", data: undefined };
        for (const line of block.split("\n")) {
          const [field, ...rest] = line.split(":");
          const value = rest.join(":").replace(/^ /, "");
          if (field === "id") frame.id = Number(value);
          if (field === "event") frame.event = value;
          if (field === "data") frame.data = JSON.parse(value) as unknown;
        }
        result.frames.push(frame);
        if (options.until?.(frame, result.frames)) {
          await reader.cancel();
          return result;
        }
      }
    }
  } catch (error) {
    if (!options.signal?.aborted) throw error;
  }
  return result;
}
