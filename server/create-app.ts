import { AccountAdmin } from "./admin/accounts.ts";
import { AuditLog } from "./admin/audit.ts";
import { ProviderAdmin } from "./admin/providers.ts";
import { SettingsStore } from "./admin/settings.ts";
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
import { loadProviders, type ProviderEntry } from "./providers/config.ts";
import { createSafeFetch, systemResolver, type Resolver } from "./providers/ssrf.ts";
import { PasswordHasher } from "./auth/passwords.ts";
import { AuthService, type AuthContext } from "./auth/service.ts";
import { SessionStore } from "./auth/sessions.ts";
import { PreferencesStore } from "./storage/preferences.ts";
import { UserStore } from "./storage/users.ts";
import { SendService, type SendServiceOptions } from "./chat/send-service.ts";
import { ChatIndex } from "./storage/chat-index.ts";
import { CheckpointStore } from "./storage/checkpoints.ts";
import { ConversationStore } from "./storage/conversations.ts";
import { KeyedLocks, UserBarrier } from "./storage/locks.ts";
import { AccountWrites } from "./storage/account.ts";
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
import { precompressedAssets } from "./static-compressed.ts";

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
  /** Builds a provider for a configured entry (tests: alternative implementations). */
  providerFactory?: (entry: ProviderEntry) => Provider;
  /** DNS resolver for the SSRF guard (tests: rebinding scenarios). */
  resolver?: Resolver;
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
  /** Generation checkpoint store (diagnostics and tests). */
  checkpoints: CheckpointStore;
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
  const safeFetch = createSafeFetch(providerConfig.ssrf, options.resolver);
  const paths = new DataPaths(options.config.dataDir);
  const checkpoints = new CheckpointStore(paths);
  const generations = new GenerationManager({
    checkpoints,
    checkpointMs: storageConfig.generationCheckpointMs,
    replayEvents: storageConfig.sseReplayEvents,
    retentionMs: storageConfig.generationRetentionMs,
    logger,
    maxOutputTokens: providerConfig.maxOutputTokens,
    generationMaxMs: providerConfig.generationMaxMs,
    // Until discovery reports the provider's parallel slots, admit one (contracts §4).
    maxActiveGenerations: providerConfig.maxActiveGenerations ?? 1,
    maxActivePerUser: authConfig.maxActiveGenerationsPerUser,
    now,
    ...options.generationRetention,
  });
  /** Global cap: explicit MAX_ACTIVE_GENERATIONS, else the sum of provider limits. */
  const updateGlobalLimit = () => {
    if (providerConfig.maxActiveGenerations !== undefined) return;
    const sum = models
      .providerIds()
      .reduce((total, id) => total + generations.providerLimit(id), 0);
    generations.setMaxActiveGenerations(Math.max(1, sum));
  };
  const slotsLearned = new Set<string>();
  const models = new ModelCatalog({
    providers: [],
    defaultContextTokens: providerConfig.defaultContextTokens,
    logger,
    // Per-provider admission defaults to the provider's discovered slots, else 1.
    onDiscovered: (providerId, provider) => {
      if (
        slotsLearned.has(providerId) ||
        models.entry(providerId)?.maxActiveGenerations !== undefined
      )
        return;
      slotsLearned.add(providerId);
      provider.discoverSlots().then(
        (slots) => {
          if (slots === undefined) return;
          generations.setProviderLimit(providerId, slots);
          updateGlobalLimit();
          logger.info({ providerId, slots }, "provider admission limit discovered");
        },
        () => undefined,
      );
    },
  });

  const locks = new KeyedLocks();
  // Every write into a user's directory runs under the account barrier (INV-61).
  const barrier = new UserBarrier();
  const accountWrites = new AccountWrites(paths, barrier);
  const index = new ChatIndex(paths, logger);
  const conversations = new ConversationStore({ paths, locks, index, now, writes: accountWrites });
  const operations = new OperationStore(paths, accountWrites);
  // Instance settings (Phase 10) apply live: generation limits and registration.
  const settings = new SettingsStore({
    paths,
    locks,
    logger,
    onChange: (next) => {
      generations.setMaxActivePerUser(next.generation?.maxActivePerUser);
    },
  });
  const audit = new AuditLog({ paths, locks, now });
  const send = new SendService({
    store: conversations,
    checkpoints,
    operations,
    catalog: models,
    generations,
    logger,
    maxOutputTokens: providerConfig.maxOutputTokens,
    operationRetentionMs: storageConfig.operationRetentionMs,
    contextTrimStep: storageConfig.contextTrimStep,
    templateOverheadTokens: storageConfig.templateOverheadTokens,
    now,
    settings,
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
  const auth = new AuthService({
    users,
    sessions,
    hasher,
    config: authConfig,
    logger,
    // A disabled or removed account's generations are cancelled (Phase 6).
    onAccountRejected: (userId) => {
      generations.cancelForUser(userId);
    },
    registrationMode: () => settings.get().registrationMode,
  });
  const accountAdmin = new AccountAdmin({
    users,
    sessions,
    auth,
    generations,
    barrier,
    paths,
    index,
    checkpoints,
    logger,
  });
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
    // Finish interrupted account closures before anything reads accounts (INV-61).
    await accountAdmin.resumeClosures();
    const report = await recoverStorage({
      paths,
      operations,
      index,
      logger,
      retentionMs: storageConfig.operationRetentionMs,
      startedAt: options.startedAt ?? now(),
      now: now(),
      generations: {
        store: conversations,
        checkpoints,
        retentionMs: storageConfig.generationRetentionMs,
      },
    });
    await users.rebuildIndex();
    await sessions.sweep();
    await settings.load();
    // Providers: authoritative providers.json (bootstrapped once from LLAMA_*).
    await installProviders();
    // Discovery never blocks startup.
    models.warmUp();
    return report;
  })();

  /** (Re)loads providers.json into the running registry (startup and admin edits). */
  async function installProviders() {
    const loaded = await loadProviders({
      paths,
      policy: providerConfig.ssrf,
      logger,
      bootstrap: { baseUrl: providerConfig.baseUrl, apiKey: providerConfig.apiKey },
    });
    models.configure(
      loaded.valid.map((entry) => ({
        entry,
        provider:
          options.providerFactory?.(entry) ??
          createLlamaCppProvider({
            baseUrl: entry.baseUrl,
            apiKey: entry.apiKey,
            timeoutMs: entry.timeoutMs ?? providerConfig.timeoutMs,
            maxResponseBytes: providerConfig.maxResponseBytes,
            fetch: safeFetch,
          }),
      })),
      loaded.invalid,
    );
    slotsLearned.clear();
    for (const entry of loaded.valid)
      generations.setProviderLimit(entry.id, entry.maxActiveGenerations ?? 1);
    updateGlobalLimit();
    return loaded;
  }
  const providerAdmin = new ProviderAdmin({
    paths,
    locks,
    policy: providerConfig.ssrf,
    resolver: options.resolver ?? systemResolver,
    catalog: models,
    reload: async () => {
      const loaded = await installProviders();
      models.warmUp();
      return { invalid: loaded.invalid };
    },
  });
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
    preferences: new PreferencesStore(paths, locks, accountWrites),
    modelList: async (role, listOptions) => {
      const providers = await models.listModels(listOptions);
      const visible =
        role === "admin"
          ? providers
          : providers.map((group) => ({
              ...group,
              models: group.models.filter((m) => !settings.isHidden(m.providerId, m.id)),
            }));
      const fallback = settings.get().defaultModel ?? null;
      const defaultModel =
        fallback &&
        visible.some((g) =>
          g.models.some((m) => m.providerId === fallback.providerId && m.id === fallback.modelId),
        )
          ? fallback
          : null;
      return { providers: visible, defaultModel };
    },
    admin: {
      accounts: accountAdmin,
      providers: providerAdmin,
      settings,
      audit,
      rebuildIndex: async (userId) => {
        const ids = userId ? [userId] : await accountIds(paths);
        let total = 0;
        for (const id of ids)
          total += (await accountWrites.run(id, () => index.rebuild(id))).length;
        return total;
      },
    },
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
    assets.use(precompressedAssets(path.join(options.clientDir, "assets")));
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
  // (HTML and `.data` route data are marked private, no-store in entry.server.)
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
    checkpoints,
    ready,
    shutdown: async () => {
      clearInterval(retentionTimer);
      await generations.shutdown();
    },
  };
}
