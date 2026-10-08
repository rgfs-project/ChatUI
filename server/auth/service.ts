import type { Request, Response } from "express";
import type { SessionDto } from "@shared/auth";
import { ErrorCode } from "@shared/errors";
import type { AuthConfig } from "../config.ts";
import { AppError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import {
  UserError,
  USERNAME_RE,
  normalizeUsername,
  type Role,
  type UserStore,
} from "../storage/users.ts";
import {
  HashQueueFullError,
  PASSWORD_MAX,
  PASSWORD_MIN,
  type PasswordHasher,
} from "./passwords.ts";
import { RateLimiter } from "./rate-limit.ts";
import { hashToken, tokensEqual, type SessionStore } from "./sessions.ts";

/** The authenticated identity of one request. Identity comes only from here (INV-14). */
export interface AuthContext {
  userId: string;
  username: string;
  role: Role;
  /** SHA-256 of the session token (the token itself is never kept). */
  tokenHash: string;
  csrfToken: string;
}

const LOGIN_LIMIT = { limit: 10, windowMs: 15 * 60_000 };

function rateLimited(seconds: number): AppError {
  return new AppError(ErrorCode.RATE_LIMITED, "Too many attempts; try again later", undefined, {
    "Retry-After": String(Math.max(1, seconds)),
  });
}

export class AuthService {
  private readonly users: UserStore;
  private readonly sessions: SessionStore;
  private readonly hasher: PasswordHasher;
  private readonly config: AuthConfig;
  private readonly logger: Logger;
  private readonly onAccountRejected: (userId: string) => void;
  private readonly byAddress = new RateLimiter(LOGIN_LIMIT);
  private readonly byUsername = new RateLimiter(LOGIN_LIMIT);
  private readonly passwordAttempts = new RateLimiter(LOGIN_LIMIT);
  readonly cookieName: string;

  constructor(options: {
    users: UserStore;
    sessions: SessionStore;
    hasher: PasswordHasher;
    config: AuthConfig;
    logger: Logger;
    onAccountRejected?: (userId: string) => void;
    /** Instance setting that overrides REGISTRATION_MODE once saved (Phase 10). */
    registrationMode?: () => "open" | "closed" | undefined;
  }) {
    this.registrationMode = options.registrationMode ?? (() => undefined);
    this.users = options.users;
    this.sessions = options.sessions;
    this.hasher = options.hasher;
    this.config = options.config;
    this.logger = options.logger;
    this.onAccountRejected = options.onAccountRejected ?? (() => undefined);
    // __Host- cookies must be Secure, host-only and Path=/ (https origins).
    this.cookieName = this.config.secureCookies ? "__Host-chatui_session" : "chatui_session";
    void this.refreshFirstRun().catch(() => undefined);
  }

  private readonly registrationMode: () => "open" | "closed" | undefined;

  /** True once no account exists yet; cleared for good by the first account. */
  private firstRun = false;
  private firstAccount: Promise<unknown> = Promise.resolve();

  /** The configured or saved mode alone, without the first-run exception. */
  get registrationConfiguredOpen(): boolean {
    return (this.registrationMode() ?? this.config.registrationMode) === "open";
  }

  /** Open by mode, or open for the first account on an empty instance. */
  get registrationOpen(): boolean {
    return this.registrationConfiguredOpen || this.firstRun;
  }

  /**
   * Re-reads whether any account exists. Cheap once an account exists (no
   * disk access); while the instance is empty it also notices accounts the
   * CLI created behind the server's back.
   */
  async refreshFirstRun(): Promise<boolean> {
    if (this.firstRun || !this.checkedOnce) {
      this.firstRun = (await this.users.all()).length === 0;
      this.checkedOnce = true;
    }
    return this.firstRun;
  }

  private checkedOnce = false;

  private tokenFrom(req: Request): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === this.cookieName) {
        const value = part.slice(eq + 1).trim();
        return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
      }
    }
    return undefined;
  }

  /**
   * Resolves the request's session and loads the user record on every call,
   * so disabled accounts and role changes take effect immediately (INV-17).
   */
  async resolve(req: Request): Promise<AuthContext | null> {
    const token = this.tokenFrom(req);
    if (!token) return null;
    return this.resolveHash(hashToken(token));
  }

  async resolveHash(tokenHash: string): Promise<AuthContext | null> {
    const session = await this.sessions.read(tokenHash);
    if (!session) return null;
    const user = await this.users.get(session.userId);
    if (user?.status !== "active" || user.role !== session.role) {
      await this.sessions.revoke(tokenHash);
      if (user?.status !== "active") this.onAccountRejected(session.userId);
      return null;
    }
    await this.sessions.touch(tokenHash, session);
    return {
      userId: user.id,
      username: user.username,
      role: user.role,
      tokenHash,
      csrfToken: session.csrfToken,
    };
  }

  sessionDto(auth: AuthContext | null): SessionDto {
    return {
      user: auth ? { id: auth.userId, username: auth.username, role: auth.role } : null,
      csrfToken: auth?.csrfToken ?? null,
      registrationOpen: this.registrationOpen,
    };
  }

  private setCookie(res: Response, token: string): void {
    res.cookie(this.cookieName, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.config.secureCookies,
      path: "/",
      maxAge: this.config.sessionAbsoluteTtlMs,
    });
  }

  clearCookie(res: Response): void {
    res.clearCookie(this.cookieName, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.config.secureCookies,
      path: "/",
    });
  }

  /** Login/registration have no session yet: require a same-origin request (INV-16). */
  checkOrigin(req: Request): void {
    const origin = req.get("origin");
    const site = req.get("sec-fetch-site");
    if (origin === this.config.publicOrigin || (origin === undefined && site === "same-origin"))
      return;
    throw new AppError(ErrorCode.CSRF_INVALID, "Cross-site request rejected");
  }

  /** Synchronizer token + expected user for state-changing requests (contracts §5). */
  checkMutation(req: Request, auth: AuthContext | null): void {
    const token = req.get("x-csrf-token");
    if (!auth || !token || !tokensEqual(token, auth.csrfToken)) {
      throw new AppError(ErrorCode.CSRF_INVALID, "Invalid or missing CSRF token");
    }
    if (req.get("x-expected-user") !== auth.userId) {
      throw new AppError(
        ErrorCode.SESSION_CHANGED,
        "The signed-in account changed; reload to continue",
      );
    }
  }

  private limit(req: Request, username: string): void {
    // A blocked address is turned away before any per-username state is made.
    const address = `addr:${req.ip ?? "unknown"}`;
    const blocked = this.byAddress.blocked(address);
    if (blocked > 0) throw rateLimited(blocked);
    const byAddress = this.byAddress.hit(address);
    const byName = this.byUsername.hit(`user:${normalizeUsername(username)}`);
    const wait = Math.max(byAddress, byName);
    if (wait > 0) throw rateLimited(wait);
  }

  private async withHasher<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof HashQueueFullError) throw rateLimited(5);
      throw error;
    }
  }

  /** Issues a fresh session (rotation: the presented session is revoked). */
  private async startSession(
    req: Request,
    res: Response,
    userId: string,
    username: string,
    role: Role,
  ): Promise<SessionDto> {
    const previous = this.tokenFrom(req);
    if (previous) await this.sessions.revoke(hashToken(previous));
    const issued = await this.sessions.issue(userId, role);
    this.setCookie(res, issued.token);
    return this.sessionDto({
      userId,
      username,
      role,
      tokenHash: issued.tokenHash,
      csrfToken: issued.record.csrfToken,
    });
  }

  async login(
    req: Request,
    res: Response,
    username: string,
    password: string,
  ): Promise<SessionDto> {
    this.limit(req, username);
    const user = await this.users.findByUsername(username);
    const ok = await this.withHasher(() => this.hasher.verify(user?.passwordHash, password));
    if (!user || !ok || user.status !== "active") {
      throw new AppError(ErrorCode.UNAUTHENTICATED, "Incorrect username or password");
    }
    this.logger.info({ userId: user.id }, "login");
    return this.startSession(req, res, user.id, user.username, user.role);
  }

  /** Validates and hashes a password an admin sets (create user, reset password). */
  async hashPassword(password: string): Promise<string> {
    this.validatePassword(password);
    return this.withHasher(() => this.hasher.hash(password));
  }

  validatePassword(password: string): void {
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      throw new AppError(
        ErrorCode.VALIDATION,
        `Passwords are ${String(PASSWORD_MIN)}-${String(PASSWORD_MAX)} characters`,
      );
    }
  }

  async register(
    req: Request,
    res: Response,
    username: string,
    password: string,
  ): Promise<SessionDto> {
    await this.refreshFirstRun();
    if (!this.registrationOpen)
      throw new AppError(ErrorCode.REGISTRATION_CLOSED, "Registration is closed");
    this.limit(req, username);
    const name = normalizeUsername(username);
    if (!USERNAME_RE.test(name)) {
      throw new AppError(ErrorCode.VALIDATION, "Usernames are 3-32 characters: a-z, 0-9, _ . -");
    }
    this.validatePassword(password);
    const passwordHash = await this.withHasher(() => this.hasher.hash(password));
    try {
      const user = await this.createRegistered(name, passwordHash);
      return await this.startSession(req, res, user.id, user.username, user.role);
    } catch (error) {
      if (error instanceof UserError && error.kind === "taken") {
        throw new AppError(ErrorCode.CONFLICT, "That username is taken");
      }
      throw error;
    }
  }

  /**
   * Creates the account. On an empty instance with registration otherwise
   * closed, registrations are serialized so exactly one succeeds, and it
   * becomes the admin; everyone else is told registration is closed.
   */
  private async createRegistered(name: string, passwordHash: string) {
    if (this.registrationConfiguredOpen) {
      const first = this.firstRun ? await this.claimFirstAccount(name, passwordHash) : null;
      return first ?? (await this.users.create({ username: name, passwordHash, role: "user" }));
    }
    const created = await this.claimFirstAccount(name, passwordHash);
    if (!created) throw new AppError(ErrorCode.REGISTRATION_CLOSED, "Registration is closed");
    return created;
  }

  /** Creates an admin if (and only if) no account exists; null otherwise. */
  private claimFirstAccount(name: string, passwordHash: string) {
    const run = this.firstAccount.then(async () => {
      if (!(await this.refreshFirstRun())) return null;
      const user = await this.users.create({ username: name, passwordHash, role: "admin" });
      this.firstRun = false;
      return user;
    });
    this.firstAccount = run.catch(() => undefined);
    return run;
  }

  async logout(res: Response, auth: AuthContext | null): Promise<void> {
    if (auth) await this.sessions.revoke(auth.tokenHash);
    this.clearCookie(res);
  }

  /** Changes the password, revokes every session and requires a new login. */
  async changePassword(
    res: Response,
    auth: AuthContext,
    current: string,
    next: string,
  ): Promise<void> {
    this.validatePassword(next);
    // Guessing the current password here is held to the login limits, per
    // account across sessions, before any hashing work.
    const wait = this.passwordAttempts.hit(`user:${auth.userId}`);
    if (wait > 0) throw rateLimited(wait);
    const user = await this.users.get(auth.userId);
    const ok = await this.withHasher(() => this.hasher.verify(user?.passwordHash, current));
    if (!user || !ok) throw new AppError(ErrorCode.VALIDATION, "The current password is incorrect");
    const passwordHash = await this.withHasher(() => this.hasher.hash(next));
    await this.users.update(user.id, { passwordHash });
    await this.sessions.revokeUser(user.id);
    this.clearCookie(res);
  }
}
