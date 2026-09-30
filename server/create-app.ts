import { AccountAdmin } from "./admin/accounts.ts";
import { DEFAULT_RATE_LIMITS, RequestLimits, type RateLimitConfig } from "./auth/rate-limit.ts";
import { AuditLog } from "./admin/audit.ts";
import { ProviderAdmin } from "./admin/providers.ts";
import { SettingsStore } from "./admin/settings.ts";
import path from "node:path";
import express, { type Express, type RequestHandler } from "express";
import { pinoHttp } from "pino-http";
import { ErrorCode } from "@shared/errors";
import {
  DEFAULT_ATTACHMENT_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  type AttachmentConfig,
  type Config,
  type MemoryConfig,
} from "./config.ts";
import { MemoryStore } from "./storage/memories.ts";
import { ProposalStore } from "./storage/proposals.ts";
import { ProposalService, type ProposalHooks } from "./chat/proposals.ts";
import { ArtifactStore, type ArtifactConfig, type ArtifactHooks } from "./storage/artifacts.ts";
import { ExportService, type ExportHooks } from "./portability/export.ts";
import { ImportService, type ImportHooks } from "./portability/import.ts";
import type { ImportLimits } from "./portability/archive.ts";
import { AttachmentStore, type AttachmentStoreHooks } from "./storage/attachments.ts";
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
import { SkillsStore } from "./storage/skills.ts";
import { UserStore } from "./storage/users.ts";
import { SendService, type SendServiceOptions } from "./chat/send-service.ts";
import { ConversationMutations } from "./chat/mutations.ts";
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
  config: Pick<Config, "nodeEnv" | "inContainer" | "provider" | "storage" | "dataDir" | "auth"> & {
    /** Attachment limits (Phase 12); defaults when omitted (tests). */
    attachments?: Partial<AttachmentConfig>;
    /** Memory and proposal-tool limits (Phase 13b); defaults when omitted (tests). */
    memories?: Partial<MemoryConfig>;
    /** Artifact capture limits (Phase 13c); defaults when omitted (tests). */
    artifacts?: Partial<ArtifactConfig>;
    /** Import bounds (Phase 13d); defaults when omitted (tests). */
    imports?: Partial<ImportLimits>;
    /** Per-user request budgets (Phase 16); defaults when omitted (tests). */
    rateLimits?: Partial<RateLimitConfig>;
  };
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
  /** Attachment store test hooks. */
  attachmentHooks?: AttachmentStoreHooks;
  /** Proposal acceptance crash-simulation hooks (tests). */
  proposalHooks?: ProposalHooks;
  /** Artifact capture crash-simulation hooks (tests). */
  artifactHooks?: ArtifactHooks;
  /** Export and import test hooks. */
  exportHooks?: ExportHooks;
  importHooks?: ImportHooks;
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
  const skills = new SkillsStore(paths, locks, accountWrites, now);
  const index = new ChatIndex(paths, logger);
  const attachmentConfig: AttachmentConfig = {
    ...DEFAULT_ATTACHMENT_CONFIG,
    ...options.config.attachments,
  };
  // Environment defaults with the admin's overrides (Phase 10 settings) applied live.
  const attachmentLimits = () => {
    const overrides = settings.get().attachments ?? {};
    return {
      maxFileBytes: overrides.maxFileBytes ?? attachmentConfig.maxFileBytes,
      maxPerMessage: overrides.maxPerMessage ?? attachmentConfig.maxPerMessage,
      quotaBytes: overrides.quotaBytes ?? attachmentConfig.quotaBytes,
      textInlineBytes: overrides.textInlineBytes ?? attachmentConfig.textInlineBytes,
    };
  };
  const attachments = new AttachmentStore({
    paths,
    locks,
    writes: accountWrites,
    logger,
    config: attachmentConfig,
    limits: attachmentLimits,
    now,
    ...(options.attachmentHooks ? { hooks: options.attachmentHooks } : {}),
  });
  const memoryConfig: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG, ...options.config.memories };
  const memories = new MemoryStore({ paths, locks, writes: accountWrites, now });
  const proposalStore = new ProposalStore({ paths, locks, writes: accountWrites });
  const artifacts = new ArtifactStore({
    paths,
    locks,
    writes: accountWrites,
    logger,
    now,
    ...(options.config.artifacts ? { config: options.config.artifacts } : {}),
  });
  if (options.artifactHooks) artifacts.hooks = options.artifactHooks;
  const conversations = new ConversationStore({
    paths,
    locks,
    index,
    now,
    writes: accountWrites,
    // Pending memory acceptance intents are settled before the Markdown goes (§4.3).
    beforeDelete: async (userId: string, id: string): Promise<void> => {
      await proposals.reconcileBeforeDelete(userId, id);
    },
    afterDelete: async (userId, id) => {
      // Markdown first (done), then the proposal sidecar, its attachments and its stale pin.
      await proposalStore.delete(userId, id);
      await attachments.deleteForConversation(userId, id);
      await mutations.dropPin(userId, id);
    },
  });
  const proposals: ProposalService = new ProposalService({
    conversations,
    proposals: proposalStore,
    memories,
    logger,
    maxToolCalls: memoryConfig.maxToolCalls,
    maxToolArgumentBytes: memoryConfig.maxToolArgumentBytes,
    now,
  });
  if (options.proposalHooks) proposals.hooks = options.proposalHooks;
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
  const preferences = new PreferencesStore(paths, locks, accountWrites);
  const mutations = new ConversationMutations({
    store: conversations,
    generations,
    attachments,
    preferences,
    logger,
    proposals,
  });
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
    skills,
    attachments,
    preferences,
    memories,
    proposals,
    memoryConfig,
    artifacts,
    ...options.send,
  });
  const exportsService = new ExportService({
    paths,
    writes: accountWrites,
    generations,
    logger,
    version: options.version,
    now,
  });
  if (options.exportHooks) exportsService.hooks = options.exportHooks;
  const importsService = new ImportService({
    paths,
    writes: accountWrites,
    locks,
    index,
    attachments,
    artifacts,
    memories,
    preferences,
    logger,
    ...(options.config.imports ? { limits: options.config.imports } : {}),
    now,
  });
  if (options.importHooks) importsService.hooks = options.importHooks;
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
    onClosing: (id) => {
      attachments.cancelUploads(id);
      artifacts.forget(id);
    },
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
        // A completed reply's staged proposals, then its captures, exactly once.
        staged: async (checkpoint, model) => {
          await proposals.persistStaged(
            checkpoint.userId,
            checkpoint.conversationId,
            model,
            checkpoint.outcome?.proposals ?? [],
          );
          const captures = checkpoint.outcome?.captures ?? [];
          const reply = model.blocks.find(
            (b) => b.type === "assistant" && b.id === checkpoint.assistantMessageId,
          );
          if (captures.length > 0 && reply?.type === "assistant" && reply.status === "complete")
            await artifacts.captureStaged(
              checkpoint.userId,
              {
                conversationId: checkpoint.conversationId,
                assistantMessageId: checkpoint.assistantMessageId,
                generationId: checkpoint.generationId,
              },
              captures,
            );
        },
      },
      // Step 3: interrupted import commits roll back; old staging and exports go.
      imports: async (userId) => {
        const report = await importsService.recover(userId);
        report.removed += await exportsService.sweep(userId, true);
        return report;
      },
      // Step 6: memory acceptance intents, by before/after hashes.
      memoryIntents: (userId) => proposals.recoverIntents(userId),
      // Step 7: link attachments the Markdown references, GC stale pending ones.
      attachments: (userId) => attachments.reconcile(userId, { startup: true, now: now() }),
      // After step 5 every capture that can still be finalized has been.
      artifacts: async (userId) => {
        const open = new Set(
          (await checkpoints.all())
            .filter((c) => c.state === "terminal-decided")
            .map((c) => c.generationId),
        );
        return artifacts.reconcile(userId, open);
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
        await attachments.reconcile(userId, { startup: false, now: now() });
        await exportsService.sweep(userId, false);
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
    limits: new RequestLimits({ ...DEFAULT_RATE_LIMITS, ...options.config.rateLimits }),
    users,
    preferences,
    attachments,
    mutations,
    skills,
    memories,
    proposals,
    memoryPromptBudgetBytes: memoryConfig.promptBudgetBytes,
    artifacts,
    // Deleting an artifact finalizes its generation's checkpoint first, so no
    // recovery can recreate it (INV-40).
    exports: exportsService,
    imports: importsService,
    finalizeGeneration: async (generationId) => {
      const checkpoint = await checkpoints.read(generationId);
      if (checkpoint && checkpoint.state !== "terminal")
        await checkpoints.write({
          ...checkpoint,
          state: "terminal",
          updatedAt: now().toISOString(),
        });
    },
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
