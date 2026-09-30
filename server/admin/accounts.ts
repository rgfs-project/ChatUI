import { rm } from "node:fs/promises";
import type { AdminUserDto } from "@shared/admin";
import { ErrorCode } from "@shared/errors";
import type { AuthService } from "../auth/service.ts";
import type { SessionStore } from "../auth/sessions.ts";
import { AppError } from "../errors.ts";
import type { GenerationManager } from "../generations/manager.ts";
import type { Logger } from "../logger.ts";
import type { ChatIndex } from "../storage/chat-index.ts";
import type { CheckpointStore } from "../storage/checkpoints.ts";
import { listDir } from "../storage/fs.ts";
import type { UserBarrier } from "../storage/locks.ts";
import type { DataPaths } from "../storage/paths.ts";
import {
  publicUser,
  UserError,
  type Role,
  type UserRecord,
  type UserStore,
} from "../storage/users.ts";

function activeAdmins(all: UserRecord[]): UserRecord[] {
  return all.filter((u) => u.role === "admin" && u.status === "active");
}

/**
 * User administration (Phase 10). Reductions of privilege or status revoke
 * every session of the account and cancel its generations (INV-17); the last
 * active admin can't be demoted, disabled or deleted (INV-26). Deletion runs
 * the contracts §6 closure sequence (INV-61).
 */
export class AccountAdmin {
  private readonly o: {
    users: UserStore;
    sessions: SessionStore;
    auth: AuthService;
    generations: GenerationManager;
    barrier: UserBarrier;
    paths: DataPaths;
    index: ChatIndex;
    checkpoints: CheckpointStore;
    logger: Logger;
    /** Cancels the account's other in-flight work (uploads, Phase 12). */
    onClosing?: (id: string) => void;
  };

  constructor(options: AccountAdmin["o"]) {
    this.o = options;
  }

  private dto(user: UserRecord): AdminUserDto {
    const pub = publicUser(user);
    return {
      id: pub.id,
      username: pub.username,
      role: pub.role,
      // `closing` accounts are never listed.
      status: pub.status === "disabled" ? "disabled" : "active",
      createdAt: pub.createdAt,
      conversationCount: this.o.index.list(user.id).length,
    };
  }

  async list(): Promise<AdminUserDto[]> {
    const users = await this.o.users.all();
    return users
      .filter((u) => u.status !== "closing")
      .sort((a, b) => a.username.localeCompare(b.username))
      .map((u) => this.dto(u));
  }

  async get(id: string): Promise<AdminUserDto> {
    const user = await this.o.users.get(id);
    if (!user || user.status === "closing")
      throw new AppError(ErrorCode.NOT_FOUND, "Account not found");
    return this.dto(user);
  }

  async create(input: { username: string; password: string; role: Role }): Promise<AdminUserDto> {
    const passwordHash = await this.o.auth.hashPassword(input.password);
    try {
      return this.dto(
        await this.o.users.create({ username: input.username, passwordHash, role: input.role }),
      );
    } catch (error) {
      if (error instanceof UserError && error.kind === "taken")
        throw new AppError(ErrorCode.CONFLICT, "That username is taken");
      if (error instanceof UserError && error.kind === "invalid")
        throw new AppError(ErrorCode.VALIDATION, error.message);
      throw error;
    }
  }

  /** Sets a new password and revokes every session of the account. */
  async setPassword(id: string, password: string): Promise<AdminUserDto> {
    const passwordHash = await this.o.auth.hashPassword(password);
    const user = await this.update(id, () => ({ passwordHash }));
    await this.o.sessions.revokeUser(id);
    return this.dto(user);
  }

  /** Role and status changes with last-admin protection; reductions lock the account out. */
  async change(
    id: string,
    patch: { role?: Role; status?: "active" | "disabled" },
  ): Promise<AdminUserDto> {
    const outcome = { reduced: false };
    const user = await this.update(id, (current, all) => {
      const demote = patch.role === "user" && current.role === "admin";
      const disable = patch.status === "disabled" && current.status === "active";
      if (
        (demote || disable) &&
        current.role === "admin" &&
        current.status === "active" &&
        activeAdmins(all).length <= 1
      )
        throw new AppError(ErrorCode.LAST_ADMIN, "This is the last active admin account");
      outcome.reduced = demote || disable;
      return {
        ...(patch.role ? { role: patch.role } : {}),
        ...(patch.status ? { status: patch.status } : {}),
      };
    });
    if (outcome.reduced) {
      // Takes effect immediately: no session survives, nothing keeps running.
      await this.o.sessions.revokeUser(id);
      await this.o.generations.cancelAndForgetUser(id);
    }
    return this.dto(user);
  }

  /**
   * Deletes an account (contracts §6, INV-61). The caller must type the
   * username. The sequence is crash-resumable: once `closing` is recorded,
   * startup finishes it.
   */
  async delete(id: string, confirmUsername: string): Promise<void> {
    const user = await this.o.users.get(id);
    if (!user || user.status === "closing")
      throw new AppError(ErrorCode.NOT_FOUND, "Account not found");
    if (confirmUsername !== user.username)
      throw new AppError(ErrorCode.VALIDATION, "Type the account's username to confirm");
    await this.update(id, (current, all) => {
      if (current.role === "admin" && current.status === "active" && activeAdmins(all).length <= 1)
        throw new AppError(ErrorCode.LAST_ADMIN, "This is the last active admin account");
      return { status: "closing" };
    });
    await this.finishClosure(id);
  }

  /**
   * Steps 2–5 of closure: revoke sessions (closing their streams), cancel and
   * drain generations without holding the barrier, take the barrier
   * exclusively (waiting out in-flight writers, who recheck `closing` and
   * abort), detach the directory, then delete it. Also used by startup to
   * resume an interrupted closure.
   */
  async finishClosure(id: string): Promise<void> {
    await this.o.sessions.revokeUser(id);
    await this.o.generations.cancelAndForgetUser(id);
    this.o.onClosing?.(id);
    const detached = await this.o.barrier.exclusive(id, () => this.o.users.detach(id));
    // Generation checkpoints live outside the account directory: remove them too.
    for (const checkpoint of await this.o.checkpoints.all())
      if (checkpoint.userId === id) await this.o.checkpoints.delete(checkpoint.generationId);
    if (detached) await rm(detached, { recursive: true, force: true });
    this.o.logger.info({ userId: id }, "account closed and removed");
  }

  /** Startup: resume closures and finish interrupted directory removals. */
  async resumeClosures(): Promise<number> {
    let resumed = 0;
    for (const user of await this.o.users.all()) {
      if (user.status !== "closing") continue;
      await this.finishClosure(user.id);
      resumed++;
    }
    for (const name of await listDir(this.o.paths.deletingDir()))
      await rm(`${this.o.paths.deletingDir()}/${name}`, { recursive: true, force: true });
    return resumed;
  }

  private async update(
    id: string,
    change: Parameters<UserStore["updateChecked"]>[1],
  ): Promise<UserRecord> {
    try {
      return await this.o.users.updateChecked(id, (current, all) => {
        if (current.status === "closing") throw new UserError("not_found", "Account not found");
        return change(current, all);
      });
    } catch (error) {
      if (error instanceof UserError && error.kind === "not_found")
        throw new AppError(ErrorCode.NOT_FOUND, "Account not found");
      throw error;
    }
  }
}
