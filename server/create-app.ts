import path from "node:path";
import express, { type Express, type RequestHandler } from "express";
import { pinoHttp } from "pino-http";
import { ErrorCode } from "@shared/errors";
import type { Config } from "./config.ts";
import { securityHeaders, type CspMode } from "./csp.ts";
import { AppError, apiErrorHandler, apiNotFound, sendError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { isLoopbackAddress } from "./loopback.ts";
import { buildApiRouter, type AnyApiRoute, type RouteServices } from "./registry.ts";
import { apiRoutes } from "./routes/index.ts";
import { createHealthService } from "./services/health.ts";

export const JSON_BODY_LIMIT = "256kb";

/** Values the document handler receives for each request (see app/context.ts). */
export interface DocumentRequestValues {
  nonce: string;
  services: RouteServices;
}

export interface AppOptions {
  config: Pick<Config, "nodeEnv" | "inContainer">;
  logger: Logger;
  version: string;
  /** Builds the React Router document handler; receives per-request values. */
  createDocumentHandler: (
    getValues: (res: express.Response) => DocumentRequestValues,
  ) => RequestHandler;
  /** Production browser build directory (build/client). Omitted in development. */
  clientDir?: string;
  /** Overrides the API inventory (tests only). */
  routes?: readonly AnyApiRoute[];
}

/**
 * The single Express application. Order is the API/asset boundary (INV-57):
 * security headers → /assets → /api → other static files → SSR documents.
 * /api and /assets can never fall through to the HTML document handler.
 */
export function createApp(options: AppOptions): Express {
  const { logger } = options;
  const services: RouteServices = { health: createHealthService(options.version) };
  const cspMode: CspMode = options.config.nodeEnv === "development" ? "development" : "production";

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);

  if (!options.config.inContainer) {
    // Host mode before authentication: serve loopback peers only, judged by the
    // socket address, never by forwarded headers (contracts §9.2b).
    app.use((req, _res, next) => {
      if (isLoopbackAddress(req.socket.remoteAddress)) {
        next();
        return;
      }
      logger.warn("rejected non-loopback peer");
      req.socket.destroy();
    });
  }

  app.use(
    pinoHttp({
      logger,
      genReqId: () => crypto.randomUUID(),
      // Never log query strings; they may carry user input.
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          path: req.url.split("?")[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(...securityHeaders(cspMode));

  const assets = express.Router();
  if (options.clientDir) {
    assets.use(
      express.static(path.join(options.clientDir, "assets"), {
        immutable: true,
        maxAge: "1y",
        index: false,
        redirect: false,
        fallthrough: true,
      }),
    );
  }
  assets.use((_req, res) => {
    sendError(res, new AppError(ErrorCode.NOT_FOUND, "Not found"));
  });
  app.use("/assets", assets);

  const api = express.Router();
  api.use(express.json({ limit: JSON_BODY_LIMIT, strict: true }));
  api.use(buildApiRouter(options.routes ?? apiRoutes, services));
  api.use(apiNotFound);
  api.use(apiErrorHandler(logger));
  app.use("/api", api);

  if (options.clientDir) {
    app.use(
      express.static(options.clientDir, {
        index: false,
        redirect: false,
        maxAge: "1h",
      }),
    );
  }

  const documentHandler = options.createDocumentHandler((res) => ({
    nonce: res.locals.cspNonce as string,
    services,
  }));
  app.use(documentHandler);

  // Only reached if the document handler itself fails before responding.
  app.use(((err, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    logger.error({ err }, "document handler failed");
    res
      .status(500)
      .type("text/plain")
      .set("Cache-Control", "no-store")
      .send("Internal server error");
  }) satisfies express.ErrorRequestHandler);

  return app;
}
