import path from "node:path";
import express, { type Express, type RequestHandler } from "express";
import { pinoHttp } from "pino-http";
import { ErrorCode } from "@shared/errors";
import type { Config } from "./config.ts";
import { ModelCatalog } from "./generations/catalog.ts";
import { GenerationManager } from "./generations/manager.ts";
import { DEFAULT_SSE_OPTIONS, type SseOptions } from "./generations/sse.ts";
import { createLlamaCppProvider } from "./providers/llamacpp.ts";
import type { Provider } from "./providers/types.ts";
import { SendService, type SendServiceOptions } from "./chat/send-service.ts";
import { ChatIndex } from "./storage/chat-index.ts";
import { ConversationStore } from "./storage/conversations.ts";
import { KeyedLocks } from "./storage/locks.ts";
import { OperationStore } from "./storage/operations.ts";
import { DataPaths } from "./storage/paths.ts";
import { recoverStorage, resolveOperations, type RecoveryReport } from "./storage/recovery.ts";
import { toConversationDto } from "./routes/conversations.ts";
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
  config: Pick<Config, "nodeEnv" | "inContainer" | "provider" | "storage" | "dataDir">;
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
  /** Overrides the llama.cpp provider (tests only). */
  provider?: Provider;
  /** SSE tuning (tests only). */
  sse?: Partial<SseOptions>;
  /** Generation retention tuning (tests only). */
  generationRetention?: { retentionMs?: number; maxRetained?: number };
  /** Send-acceptance crash-simulation hooks and token counting (tests only). */
  send?: Pick<SendServiceOptions, "hooks" | "counterFor">;
  /** Clock (tests only). */
  now?: () => Date;
  /** Process start, for temp-file cleanup (defaults to now). */
  startedAt?: Date;
}

export interface ChatUiApp {
  handler: Express;
  services: RouteServices;
  /** Startup recovery (contracts §2); requests must not be served before it resolves. */
  ready: Promise<RecoveryReport | null>;
  /** Ends generations (persisting their outcomes) and closes SSE observers. */
  shutdown: () => Promise<void>;
}

/**
 * The single Express application. Order is the API/asset boundary (INV-57):
 * security headers → /assets → /api → other static files → SSR documents.
 * /api and /assets can never fall through to the HTML document handler.
 */
export function createApp(options: AppOptions): ChatUiApp {
  const { logger } = options;
  const now = options.now ?? (() => new Date());
  const providerConfig = options.config.provider;
  const storageConfig = options.config.storage;
  const chatDemoEnabled = !options.config.inContainer;
  const provider = options.provider ?? createLlamaCppProvider(providerConfig);
  const models = new ModelCatalog(provider, providerConfig.defaultContextTokens);
  const generations = new GenerationManager({
    provider,
    logger,
    maxOutputTokens: providerConfig.maxOutputTokens,
    generationMaxMs: providerConfig.generationMaxMs,
    // Until discovery reports the provider's parallel slots, admit one (contracts §4).
    maxActiveGenerations: providerConfig.maxActiveGenerations ?? 1,
    now,
    ...options.generationRetention,
  });
  if (
    providerConfig.maxActiveGenerations === undefined &&
    providerConfig.baseUrl &&
    chatDemoEnabled
  ) {
    provider.discoverSlots().then(
      (slots) => {
        if (slots !== undefined) generations.setMaxActiveGenerations(slots);
        logger.info(
          { maxActiveGenerations: generations.maxActiveGenerations },
          "generation admission limit",
        );
      },
      () => {
        logger.warn("could not discover provider slots; admitting one generation at a time");
      },
    );
  }

  const paths = new DataPaths(options.config.dataDir);
  const locks = new KeyedLocks();
  const index = new ChatIndex(paths, logger);
  const conversations = new ConversationStore({ paths, locks, index, now });
  const operations = new OperationStore(paths);
  const send = new SendService({
    store: conversations,
    operations,
    catalog: models,
    generations,
    provider,
    logger,
    maxOutputTokens: providerConfig.maxOutputTokens,
    operationRetentionMs: storageConfig.operationRetentionMs,
    contextTrimStep: storageConfig.contextTrimStep,
    templateOverheadTokens: storageConfig.templateOverheadTokens,
    now,
    ...options.send,
  });
  // The container (pre-auth) writes nothing: storage exists only with the demo.
  const ready: Promise<RecoveryReport | null> = chatDemoEnabled
    ? recoverStorage({
        paths,
        operations,
        index,
        logger,
        localUserId: storageConfig.localUserId,
        retentionMs: storageConfig.operationRetentionMs,
        startedAt: options.startedAt ?? now(),
        now: now(),
      })
    : Promise.resolve(null);
  // Committed operation records expire after OPERATION_RETENTION_MS.
  const retentionTimer = setInterval(() => {
    void resolveOperations(
      paths,
      operations,
      storageConfig.localUserId,
      logger,
      storageConfig.operationRetentionMs,
      now(),
    ).catch((error: unknown) => {
      logger.warn({ err: error }, "operation retention sweep failed");
    });
  }, 3_600_000);
  retentionTimer.unref();

  const services: RouteServices = {
    conversationDto: async (id) =>
      toConversationDto(await conversations.get(storageConfig.localUserId, id), services),
    health: createHealthService(options.version),
    models,
    generations,
    conversations,
    operations,
    send,
    userId: storageConfig.localUserId,
    sse: { ...DEFAULT_SSE_OPTIONS, ...options.sse },
    logger,
    chatDemoEnabled,
  };
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

  return {
    handler: app,
    services,
    ready,
    shutdown: async () => {
      clearInterval(retentionTimer);
      await generations.shutdown();
    },
  };
}
