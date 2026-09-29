import path from "node:path";
import express, { type Express, type RequestHandler } from "express";
import { pinoHttp } from "pino-http";
import { ErrorCode } from "@shared/errors";
import type { Config } from "./config.ts";
import { ModelCatalog } from "./generations/catalog.ts";
import { GenerationManager } from "./generations/manager.ts";
import { DEFAULT_SSE_OPTIONS, SseConnections, type SseOptions } from "./generations/sse.ts";
import { createLlamaCppProvider } from "./providers/llamacpp.ts";
import type { Provider } from "./providers/types.ts";
import { PasswordHasher } from "./auth/passwords.ts";
import { AuthService, type AuthContext } from "./auth/service.ts";
import { SessionStore } from "./auth/sessions.ts";
import { PreferencesStore } from "./storage/preferences.ts";
import { UserStore } from "./storage/users.ts";
import { SendService, type SendServiceOptions } from "./chat/send-service.ts";
import { ChatIndex } from "./storage/chat-index.ts";
import { ConversationStore } from "./storage/conversations.ts";
import { KeyedLocks } from "./storage/locks.ts";
import { OperationStore } from "./storage/operations.ts";
import { DataPaths } from "./storage/paths.ts";
import {
  accountIds,
  recoverStorage,
  resolveOperations,
  type RecoveryReport,
} from "./storage/recovery.ts";
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
  /** The document request's session, resolved server-side (INV-54, INV-55). */
  auth: AuthContext | null;
}

export interface AppOptions {
  config: Pick<Config, "nodeEnv" | "inContainer" | "provider" | "storage" | "dataDir" | "auth">;
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
  /** Password hasher (tests use cheap Argon2 parameters). */
  hasher?: PasswordHasher;
  /** Clock (tests only). */
  now?: () => Date;
  /** Process start, for temp-file cleanup (defaults to now). */
  startedAt?: Date;
}

export interface ChatUiApp {
  handler: Express;
  services: RouteServices;
  /** Startup recovery (contracts §2); requests must not be served before it resolves. */
  ready: Promise<RecoveryReport>;
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
  const authConfig = options.config.auth;
  const provider = options.provider ?? createLlamaCppProvider(providerConfig);
  const models = new ModelCatalog(provider, providerConfig.defaultContextTokens);
  const generations = new GenerationManager({
    provider,
    logger,
    maxOutputTokens: providerConfig.maxOutputTokens,
    generationMaxMs: providerConfig.generationMaxMs,
    // Until discovery reports the provider's parallel slots, admit one (contracts §4).
    maxActiveGenerations: providerConfig.maxActiveGenerations ?? 1,
    maxActivePerUser: authConfig.maxActiveGenerationsPerUser,
    now,
    ...options.generationRetention,
  });
  if (providerConfig.maxActiveGenerations === undefined && providerConfig.baseUrl) {
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
  const users = new UserStore({ paths, locks, now });
  const sessions = new SessionStore({
    paths,
    absoluteTtlMs: authConfig.sessionAbsoluteTtlMs,
    idleTtlMs: authConfig.sessionIdleTtlMs,
    now,
  });
  const hasher =
    options.hasher ??
    new PasswordHasher({ concurrency: authConfig.hashConcurrency, queue: authConfig.hashQueue });
  const auth = new AuthService({ users, sessions, hasher, config: authConfig, logger });
  const sseConnections = new SseConnections({
    maxPerUser: authConfig.maxSsePerUser,
    maxTotal: authConfig.maxSseTotal,
  });
  // A revoked session's streams close immediately (logout, password change).
  sessions.onRevoked((tokenHash) => {
    sseConnections.closeSession(tokenHash);
  });

  // Startup recovery (contracts §2) and account/session housekeeping.
  const ready: Promise<RecoveryReport> = (async () => {
    const report = await recoverStorage({
      paths,
      operations,
      index,
      logger,
      retentionMs: storageConfig.operationRetentionMs,
      startedAt: options.startedAt ?? now(),
      now: now(),
    });
    await users.rebuildIndex();
    await sessions.sweep();
    return report;
  })();
  // Expired sessions and committed operation records are removed hourly.
  const retentionTimer = setInterval(() => {
    void (async () => {
      await sessions.sweep();
      for (const userId of await accountIds(paths)) {
        await resolveOperations(
          paths,
          operations,
          userId,
          logger,
          storageConfig.operationRetentionMs,
          now(),
        );
      }
    })().catch((error: unknown) => {
      logger.warn({ err: error }, "housekeeping sweep failed");
    });
  }, 3_600_000);
  retentionTimer.unref();

  const services: RouteServices = {
    conversationDto: async (userId, id) =>
      toConversationDto(await conversations.get(userId, id), services, userId),
    auth,
    users,
    preferences: new PreferencesStore(paths, locks),
    sseConnections,
    health: createHealthService(options.version),
    models,
    generations,
    conversations,
    operations,
    send,
    sse: { ...DEFAULT_SSE_OPTIONS, ...options.sse },
    logger,
  };
  const cspMode: CspMode = options.config.nodeEnv === "development" ? "development" : "production";

  const app = express();
  app.disable("x-powered-by");
  // Trusted hops for the client address only; the protocol is never taken
  // from X-Forwarded-Proto (cookie security follows PUBLIC_ORIGIN).
  app.set("trust proxy", authConfig.trustProxy > 0 ? authConfig.trustProxy : false);

  if (!options.config.inContainer && !authConfig.secureCookies) {
    // http://localhost origin: host-only transport. Serve loopback peers only,
    // judged by the socket address, never by forwarded headers (§6, §9.2b).
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

  // Every document request resolves the real session before rendering, so no
  // private markup is produced for anonymous, expired or disabled sessions.
  app.use((req, res, next) => {
    auth.resolve(req).then(
      (resolved) => {
        res.locals.auth = resolved;
        next();
      },
      (error: unknown) => {
        next(error);
      },
    );
  });
  const documentHandler = options.createDocumentHandler((res) => ({
    nonce: res.locals.cspNonce as string,
    services,
    auth: (res.locals.auth as AuthContext | null | undefined) ?? null,
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
