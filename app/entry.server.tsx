import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { renderToPipeableStream, type RenderToPipeableStreamOptions } from "react-dom/server";
import { ServerRouter, type EntryContext, type RouterContextProvider } from "react-router";
import { appContext } from "./context";

export const streamTimeout = 5_000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
): Response | Promise<Response> {
  // Documents can carry private, user-scoped markup and the CSRF bootstrap:
  // never stored by any cache (contracts §9.2a).
  responseHeaders.set("Cache-Control", "private, no-store");

  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, { status: responseStatusCode, headers: responseHeaders });
  }

  // The same per-response nonce as the Content-Security-Policy header (§9.2b).
  const { nonce } = loadContext.get(appContext);

  return new Promise((resolve, reject) => {
    let shellRendered = false;
    let status = responseStatusCode;
    const userAgent = request.headers.get("user-agent");
    const readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode ? "onAllReady" : "onShellReady";

    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      abort();
    }, streamTimeout + 1000);

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
      {
        nonce,
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough({
            final(callback) {
              clearTimeout(timeoutId);
              timeoutId = undefined;
              callback();
            },
          });
          responseHeaders.set("Content-Type", "text/html; charset=utf-8");
          pipe(body);
          resolve(
            new Response(createReadableStreamFromReadable(body), {
              headers: responseHeaders,
              status,
            }),
          );
        },
        onShellError(error: unknown) {
          reject(error instanceof Error ? error : new Error("Shell render failed"));
        },
        onError(error: unknown) {
          status = 500;
          if (shellRendered) console.error(error);
        },
      },
    );
  });
}

/**
 * Route data for client navigations (`<path>.data`) carries the same private,
 * dehydrated state as the document, so it is never cacheable either.
 */
export function handleDataRequest(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
