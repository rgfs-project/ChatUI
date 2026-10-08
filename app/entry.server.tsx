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
  // Documents carry private markup and the CSRF bootstrap: never cached.
  responseHeaders.set("Cache-Control", "private, no-store");
  if (request.method.toUpperCase() === "HEAD")
    return new Response(null, { status: responseStatusCode, headers: responseHeaders });

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

/** Route data for client navigations is as private as the document. */
export function handleDataRequest(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
