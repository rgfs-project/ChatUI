import { createHash } from "node:crypto";
import type { ProfileDto, ProfileStats } from "@shared/profile";
import type { AttachmentStore } from "../attachments/store.ts";
import type { ConversationStore } from "../storage/conversations.ts";
import type { ConversationModel } from "../storage/markdown.ts";
import type { UserStore } from "../storage/users.ts";
import { computeStats } from "./stats.ts";
import type { Profile, ProfileStore } from "./store.ts";

/**
 * Profile DTOs and statistics. Statistics read every conversation once, then
 * are cached until the index changes (any write, rename or delete), the day
 * changes or another time zone is asked for.
 */
export class ProfileService {
  private readonly cache = new Map<string, { key: string; stats: ProfileStats }>();
  private readonly o: {
    store: ProfileStore;
    users: UserStore;
    conversations: ConversationStore;
    attachments: AttachmentStore;
    now: () => Date;
  };

  constructor(options: ProfileService["o"]) {
    this.o = options;
  }

  dtoOf(
    profile: Profile,
    user: { username: string; role: "user" | "admin"; createdAt: string },
  ): ProfileDto {
    return {
      username: user.username,
      role: user.role,
      createdAt: user.createdAt,
      photoVersion: profile.photo ? profile.photo.sha256.slice(0, 16) : null,
      shape: profile.shape,
    };
  }

  async dto(userId: string): Promise<ProfileDto> {
    const [profile, user] = await Promise.all([this.o.store.get(userId), this.o.users.get(userId)]);
    return this.dtoOf(profile, {
      username: user?.username ?? "",
      role: user?.role ?? "user",
      createdAt: user?.createdAt ?? new Date(0).toISOString(),
    });
  }

  async stats(userId: string, timeZone: string): Promise<ProfileStats> {
    const now = this.o.now();
    const entries = this.o.conversations.list(userId);
    const files = (await this.o.attachments.list(userId)).length;
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          timeZone,
          now.toISOString().slice(0, 13),
          files,
          entries.map((e) => [e.id, e.fileSize, e.fileMtimeMs, e.malformed]),
        ]),
      )
      .digest("hex");
    const cached = this.cache.get(userId);
    if (cached?.key === key) return cached.stats;
    const models: ConversationModel[] = [];
    for (const entry of entries) {
      if (entry.malformed) continue;
      const read = await this.o.conversations.readUnlocked(userId, entry.id);
      if (read.kind === "ok") models.push(read.conversation.model);
    }
    const stats = computeStats(models, { timeZone, now, files });
    this.cache.set(userId, { key, stats });
    return stats;
  }
}
