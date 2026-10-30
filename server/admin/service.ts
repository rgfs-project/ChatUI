// Administration (Phase 10): accounts, providers, models, instance settings,
// maintenance. Every method is reached only through `admin` routes, which the
// registry authorizes from the fresh user record (INV-24).
import { randomBytes } from "node:crypto";
import { readdir, rename, rm } from "node:fs/promises";
import { z } from "zod";
import { ErrorCode } from "@shared/errors";
import type { AuthContext, AuthService } from "../auth/service.ts";
import type { PasswordHasher } from "../auth/passwords.ts";
import type { SessionStore } from "../auth/sessions.ts";
import { AppError } from "../errors.ts";
import type { ModelCatalog } from "../generations/catalog.ts";
import type { GenerationManager } from "../generations/manager.ts";
import type { Logger } from "../logger.ts";
import { providerEntrySchema, type ProviderEntry } from "../providers/config.ts";
import {
  checkUrl,
  resolveChecked,
  SsrfError,
  type Resolver,
  type SsrfPolicy,
} from "../providers/ssrf.ts";
import type { Provider } from "../providers/types.ts";
import type { ChatIndex } from "../storage/chat-index.ts";
import { atomicWrite, ensureDir, readOrNull } from "../storage/fs.ts";
import type { KeyedLocks } from "../storage/locks.ts";
import { isUuid, type DataPaths } from "../storage/paths.ts";
import {
  REGISTRY_LOCK,
  UserError,
  USERNAME_RE,
  normalizeUsername,
  type Role,
  type UserRecord,
  type UserStore,
} from "../storage/users.ts";
import type { AuditEntry, AuditLog } from "./audit.ts";
import {
  modelSettingsSchema,
  validTimeZone,
  type InstanceSettings,
  type ModelSettings,
  type SettingsStore,
} from "./settings.ts";

export interface AdminUserDto {
  id: string;
  username: string;
  role: Role;
  status: UserRecord["status"];
  createdAt: string;
  conversationCount: number;
}

export interface AdminProviderDto {
  id: string;
  name: string;
  kind: "openai-compatible";
  baseUrl: string;
  /** Secrets are write-only (INV-25): only whether one is set. */
  hasApiKey: boolean;
  timeoutMs: number | null;
  maxActiveGenerations: number | null;
  capabilities: ProviderEntry["capabilities"];
  contextTokens: number | null;
}

export const providerInputSchema = providerEntrySchema.omit({ apiKey: true }).extend({
  apiKey: z.string().min(1).max(4096).optional(),
});
export const providerPatchSchema = providerEntrySchema
  .omit({ id: true, kind: true, apiKey: true })
  .partial()
  .extend({
    /** Replaces the key; `clearApiKey: true` removes it; neither keeps it. */
    apiKey: z.string().min(1).max(4096).optional(),
    clearApiKey: z.literal(true).optional(),
  })
  .strict();

const CLOSURE_DRAIN_MS = 10_000;

export interface AdminServiceOptions {
  paths: DataPaths;
  locks: KeyedLocks;
  users: UserStore;
  sessions: SessionStore;
  auth: AuthService;
  hasher: PasswordHasher;
  generations: GenerationManager;
  index: ChatIndex;
  models: ModelCatalog;
  settings: SettingsStore;
  audit: AuditLog;
  logger: Logger;
  policy: SsrfPolicy;
  resolver: Resolver;
  /** Upper bound for the instance output-token setting (the environment's). */
  maxOutputTokens: number;
  /** Environment file size cap (MAX_ATTACHMENT_BYTES); admin settings may only lower it. */
  maxAttachmentBytes: number;
  /** Re-reads providers.json and swaps the provider registry in-process. */
  reloadProviders: () => Promise<void>;
  /** A provider for an entry (the same SSRF-guarded client as production). */
  providerFor: (entry: ProviderEntry) => Provider;
}

export class AdminService {
  private readonly o: AdminServiceOptions;

  constructor(options: AdminServiceOptions) {
    this.o = options;
  }

  /**
   * Service-boundary authorization (Phase 16): every change re-reads the
   * actor's account and requires an active admin, so no caller can reach
   * these operations by skipping the route guard.
   */
  private async authorize(actor: AuthContext): Promise<void> {
    const user = await this.o.users.get(actor.userId);
    if (user?.status !== "active" || user.role !== "admin")
      throw new AppError(ErrorCode.FORBIDDEN, "Administrators only");
  }

  private audit(
    actor: AuthContext,
    action: string,
    target: Parameters<AuditLog["record"]>[0]["target"],
    outcome: "ok" | "error" = "ok",
    detail?: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    return this.o.audit.record({
      actor: { id: actor.userId, username: actor.username },
      action,
      target,
      outcome,
      ...(detail ? { detail } : {}),
    });
  }

  // ── Accounts ──

  private dto(user: UserRecord): AdminUserDto {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      conversationCount: this.o.index.list(user.id).length,
    };
  }

  async listUsers(actor: AuthContext): Promise<AdminUserDto[]> {
    await this.authorize(actor);
    const users = await this.o.users.all();
    return users.sort((a, b) => a.username.localeCompare(b.username)).map((u) => this.dto(u));
  }

  private async mustGet(id: string): Promise<UserRecord> {
    const user = isUuid(id) ? await this.o.users.get(id) : null;
    if (!user || user.status === "closing")
      throw new AppError(ErrorCode.NOT_FOUND, "Account not found");
    return user;
  }

  /** INV-26: the change must leave at least one active admin. */
  private async assertNotLastAdmin(target: UserRecord): Promise<void> {
    if (target.role !== "admin" || target.status !== "active") return;
    const admins = (await this.o.users.all()).filter(
      (u) => u.role === "admin" && u.status === "active",
    );
    if (admins.length <= 1)
      throw new AppError(ErrorCode.LAST_ADMIN, "There must always be at least one active admin");
  }

  async createUser(
    actor: AuthContext,
    input: { username: string; password: string; role: Role },
  ): Promise<AdminUserDto> {
    await this.authorize(actor);
    const username = normalizeUsername(input.username);
    if (!USERNAME_RE.test(username))
      throw new AppError(ErrorCode.VALIDATION, "Usernames are 3-32 characters: a-z, 0-9, _ . -");
    this.o.auth.validatePassword(input.password);
    const passwordHash = await this.o.hasher.hash(input.password);
    try {
      const user = await this.o.users.create({ username, passwordHash, role: input.role });
      await this.audit(actor, "user.create", { type: "user", id: user.id }, "ok", {
        username,
        role: input.role,
      });
      return this.dto(user);
    } catch (error) {
      if (error instanceof UserError && error.kind === "taken")
        throw new AppError(ErrorCode.CONFLICT, "That username is taken");
      throw error;
    }
  }

  /** Sets a new password and revokes every session of that account. */
  async setPassword(actor: AuthContext, id: string, password: string): Promise<void> {
    await this.authorize(actor);
    const user = await this.mustGet(id);
    this.o.auth.validatePassword(password);
    const passwordHash = await this.o.hasher.hash(password);
    await this.o.users.update(user.id, { passwordHash });
    await this.o.sessions.revokeUser(user.id);
    await this.audit(actor, "user.password", { type: "user", id: user.id });
  }

  /** Role/status changes; any change revokes sessions, a reduction cancels generations (INV-17). */
  async updateUser(
    actor: AuthContext,
    id: string,
    patch: { role?: Role; status?: "active" | "disabled" },
  ): Promise<AdminUserDto> {
    await this.authorize(actor);
    const user = await this.mustGet(id);
    const demote = patch.role === "user" && user.role === "admin";
    const disable = patch.status === "disabled" && user.status === "active";
    if (demote || disable) await this.assertNotLastAdmin(user);
    const updated = await this.o.users.update(user.id, {
      ...(patch.role ? { role: patch.role } : {}),
      ...(patch.status ? { status: patch.status } : {}),
    });
    if (updated.role !== user.role || updated.status !== user.status) {
      await this.o.sessions.revokeUser(user.id);
      if (disable || demote) this.o.generations.cancelForUser(user.id);
    }
    await this.audit(actor, "user.update", { type: "user", id: user.id }, "ok", {
      role: updated.role,
      status: updated.status,
    });
    return this.dto(updated);
  }

  async deleteUser(actor: AuthContext, id: string, confirmUsername: string): Promise<void> {
    await this.authorize(actor);
    const user = await this.mustGet(id);
    if (normalizeUsername(confirmUsername) !== user.username)
      throw new AppError(ErrorCode.VALIDATION, "Type the username to confirm the deletion");
    await this.assertNotLastAdmin(user);
    await this.closeAccount(user.id);
    await this.audit(actor, "user.delete", { type: "user", id: user.id }, "ok", {
      username: user.username,
    });
  }

  /**
   * Account closure (contracts §6, INV-61): mark `closing` (sessions invalid
   * from here on) → revoke sessions and streams → cancel generations and wait
   * for them to settle (their terminal writes are skipped) → rename the
   * directory into `_system/deleting/` under the registry lock → forget its
   * derived entries → delete the renamed directory. Writers never recreate a
   * missing account root, and startup resumes an interrupted closure.
   */
  async closeAccount(userId: string): Promise<void> {
    const user = await this.o.users.get(userId);
    if (user && user.status !== "closing") await this.o.users.update(userId, { status: "closing" });
    await this.o.sessions.revokeUser(userId);
    this.o.generations.cancelForUser(userId);
    const deadline = Date.now() + CLOSURE_DRAIN_MS;
    while (this.o.generations.activeCountForUser(userId) > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const target = this.o.paths.deletingEntry(userId, randomBytes(8).toString("hex"));
    await this.o.locks.run(REGISTRY_LOCK, async () => {
      await ensureDir(this.o.paths.deletingDir());
      await rename(this.o.paths.userDir(userId), target).catch((error: unknown) => {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      });
      await this.o.users.rebuildIndex();
    });
    this.o.index.forgetUser(userId);
    await rm(target, { recursive: true, force: true });
    this.o.logger.info({ userId }, "account removed");
  }

  /** Startup step 2 (contracts §2): finish closures and pending removals. */
  async recoverClosures(): Promise<number> {
    let finished = 0;
    for (const user of await this.o.users.all()) {
      if (user.status !== "closing") continue;
      await this.closeAccount(user.id);
      finished++;
    }
    const pending = await readdir(this.o.paths.deletingDir()).catch(() => []);
    for (const name of pending) {
      const id = name.slice(0, 36);
      const suffix = name.slice(37);
      if (!isUuid(id) || !/^[0-9a-f]{16}$/.test(suffix)) continue;
      await rm(this.o.paths.deletingEntry(id, suffix), { recursive: true, force: true });
      finished++;
    }
    return finished;
  }

  // ── Providers (`_system/providers.json`) ──

  private async readProviders(): Promise<ProviderEntry[]> {
    const bytes = await readOrNull(this.o.paths.providersFile());
    if (!bytes) return [];
    try {
      const raw = JSON.parse(bytes.toString("utf8")) as { providers?: unknown };
      return Array.isArray(raw.providers)
        ? raw.providers.flatMap((entry) => {
            const parsed = providerEntrySchema.safeParse(entry);
            return parsed.success ? [parsed.data] : [];
          })
        : [];
    } catch {
      return [];
    }
  }

  private providerDto(entry: ProviderEntry): AdminProviderDto {
    return {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      baseUrl: entry.baseUrl,
      hasApiKey: entry.apiKey !== undefined,
      timeoutMs: entry.timeoutMs ?? null,
      maxActiveGenerations: entry.maxActiveGenerations ?? null,
      capabilities: entry.capabilities,
      contextTokens: entry.contextTokens ?? null,
    };
  }

  async listProviders(actor: AuthContext): Promise<AdminProviderDto[]> {
    await this.authorize(actor);
    return (await this.readProviders()).map((p) => this.providerDto(p));
  }

  /**
   * Every create/edit re-runs the full SSRF validation (INV-19): the URL
   * policy and every resolved address; requests are checked again at send time.
   */
  private async checkEndpoint(baseUrl: string): Promise<string> {
    try {
      const url = checkUrl(baseUrl, this.o.policy);
      await resolveChecked(url, this.o.policy, this.o.resolver);
    } catch (error) {
      throw new AppError(
        ErrorCode.ENDPOINT_NOT_ALLOWED,
        error instanceof SsrfError
          ? `That endpoint is not allowed: ${error.message}`
          : "That endpoint is not allowed",
      );
    }
    return baseUrl.replace(/\/+$/, "");
  }

  private async writeProviders(entries: ProviderEntry[]): Promise<void> {
    await ensureDir(this.o.paths.systemDir());
    await atomicWrite(
      this.o.paths.providersFile(),
      `${JSON.stringify({ version: 1, providers: entries }, null, 2)}\n`,
    );
    await this.o.reloadProviders();
  }

  async createProvider(
    actor: AuthContext,
    input: z.infer<typeof providerInputSchema>,
  ): Promise<AdminProviderDto> {
    await this.authorize(actor);
    return this.o.locks.run("providers", async () => {
      const entries = await this.readProviders();
      if (entries.some((e) => e.id === input.id))
        throw new AppError(ErrorCode.CONFLICT, "A provider with that id already exists");
      const entry = providerEntrySchema.parse({
        ...input,
        baseUrl: await this.checkEndpoint(input.baseUrl),
      });
      await this.writeProviders([...entries, entry]);
      await this.audit(actor, "provider.create", { type: "provider", id: entry.id }, "ok", {
        hasApiKey: entry.apiKey !== undefined,
      });
      return this.providerDto(entry);
    });
  }

  async updateProvider(
    actor: AuthContext,
    id: string,
    patch: z.infer<typeof providerPatchSchema>,
  ): Promise<AdminProviderDto> {
    await this.authorize(actor);
    return this.o.locks.run("providers", async () => {
      const entries = await this.readProviders();
      const current = entries.find((e) => e.id === id);
      if (!current) throw new AppError(ErrorCode.PROVIDER_NOT_FOUND, "Provider not found");
      const { apiKey, clearApiKey, ...fields } = patch;
      const next: ProviderEntry = providerEntrySchema.parse({
        ...current,
        ...fields,
        baseUrl: await this.checkEndpoint(fields.baseUrl ?? current.baseUrl),
        apiKey: clearApiKey ? undefined : (apiKey ?? current.apiKey),
      });
      await this.writeProviders(entries.map((e) => (e.id === id ? next : e)));
      await this.audit(actor, "provider.update", { type: "provider", id }, "ok", {
        keyChanged: apiKey !== undefined || clearApiKey === true,
        endpointChanged: next.baseUrl !== current.baseUrl,
      });
      return this.providerDto(next);
    });
  }

  async deleteProvider(actor: AuthContext, id: string): Promise<void> {
    await this.authorize(actor);
    await this.o.locks.run("providers", async () => {
      const entries = await this.readProviders();
      if (!entries.some((e) => e.id === id))
        throw new AppError(ErrorCode.PROVIDER_NOT_FOUND, "Provider not found");
      await this.writeProviders(entries.filter((e) => e.id !== id));
      await this.audit(actor, "provider.delete", { type: "provider", id });
    });
  }

  /** "Test connection" through the same SSRF-guarded client as production. */
  async testProvider(
    actor: AuthContext,
    id: string,
  ): Promise<{ ok: boolean; models: number; message: string }> {
    await this.authorize(actor);
    const entry = (await this.readProviders()).find((e) => e.id === id);
    if (!entry) throw new AppError(ErrorCode.PROVIDER_NOT_FOUND, "Provider not found");
    let result: { ok: boolean; models: number; message: string };
    try {
      await this.checkEndpoint(entry.baseUrl);
      const models = await this.o.providerFor(entry).listModels(AbortSignal.timeout(10_000));
      result = { ok: true, models: models.length, message: "Connected" };
    } catch (error) {
      result = {
        ok: false,
        models: 0,
        message:
          error instanceof AppError ? error.message : "The model server could not be reached",
      };
    }
    await this.audit(actor, "provider.test", { type: "provider", id }, result.ok ? "ok" : "error");
    return result;
  }

  // ── Models and settings (`_system/settings.json`) ──

  async listModels(actor: AuthContext): Promise<
    {
      providerId: string;
      providerName: string;
      modelId: string;
      status: string;
      settings: ModelSettings;
    }[]
  > {
    await this.authorize(actor);
    const groups = await this.o.models.listModels();
    return groups.flatMap((group) =>
      group.models.map((model) => ({
        providerId: group.provider.id,
        providerName: group.provider.name,
        modelId: model.id,
        status: model.status,
        settings: this.o.settings.forModel(group.provider.id, model.id) ?? {
          providerId: group.provider.id,
          modelId: model.id,
          hidden: false,
          sampling: {},
          systemPrompt: null,
        },
      })),
    );
  }

  async updateModel(actor: AuthContext, input: ModelSettings): Promise<ModelSettings> {
    await this.authorize(actor);
    const entry = modelSettingsSchema.parse(input);
    await this.o.settings.update((current) => ({
      ...current,
      models: [
        ...current.models.filter(
          (m) => !(m.providerId === entry.providerId && m.modelId === entry.modelId),
        ),
        entry,
      ],
    }));
    await this.audit(
      actor,
      "model.update",
      { type: "model", id: `${entry.providerId}/${entry.modelId}` },
      "ok",
      {
        hidden: entry.hidden,
        systemPrompt: entry.systemPrompt !== null,
      },
    );
    return entry;
  }

  async refreshModels(actor: AuthContext): Promise<number> {
    await this.authorize(actor);
    const groups = await this.o.models.listModels({ fresh: true });
    await this.audit(actor, "model.refresh", { type: "model", id: null });
    return groups.reduce((n, g) => n + g.models.length, 0);
  }

  getSettings(): Omit<InstanceSettings, "models"> {
    const { models: _models, ...rest } = this.o.settings.get();
    return rest;
  }

  async updateSettings(
    actor: AuthContext,
    patch: Partial<Omit<InstanceSettings, "models" | "version">>,
  ): Promise<Omit<InstanceSettings, "models">> {
    await this.authorize(actor);
    if (patch.timeZone !== undefined && !validTimeZone(patch.timeZone))
      throw new AppError(ErrorCode.VALIDATION, "Unknown time zone");
    if (patch.maxOutputTokens != null && patch.maxOutputTokens > this.o.maxOutputTokens)
      throw new AppError(
        ErrorCode.VALIDATION,
        `The output limit cannot exceed the server's ${String(this.o.maxOutputTokens)} tokens`,
      );
    if (patch.maxAttachmentBytes != null && patch.maxAttachmentBytes > this.o.maxAttachmentBytes)
      throw new AppError(
        ErrorCode.VALIDATION,
        `The file size limit cannot exceed the server's ${String(this.o.maxAttachmentBytes)} bytes`,
      );
    await this.o.settings.update((current) => ({ ...current, ...patch }));
    await this.audit(actor, "settings.update", { type: "settings", id: null }, "ok", {
      fields: Object.keys(patch).join(","),
    });
    return this.getSettings();
  }

  async readAudit(actor: AuthContext, month: string): Promise<AuditEntry[]> {
    await this.authorize(actor);
    return this.o.audit.read(month);
  }

  /** The settings for the admin page (authorized like every admin operation). */
  async settingsFor(actor: AuthContext): Promise<Omit<InstanceSettings, "models">> {
    await this.authorize(actor);
    return this.getSettings();
  }

  async rebuildIndex(actor: AuthContext, userId: string | undefined): Promise<number> {
    await this.authorize(actor);
    const ids = userId
      ? [(await this.mustGet(userId)).id]
      : (await this.o.users.all()).map((u) => u.id);
    for (const id of ids) await this.o.index.rebuild(id);
    await this.audit(
      actor,
      "maintenance.rebuild-index",
      { type: "maintenance", id: userId ?? null },
      "ok",
      {
        accounts: ids.length,
      },
    );
    return ids.length;
  }
}
