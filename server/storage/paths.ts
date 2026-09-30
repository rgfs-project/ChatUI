// Central path construction (contracts §1, INV-12). Loadable natively by Node.
// Accepts only validated values: canonical lowercase UUIDs, known file names
// and server-computed lowercase SHA-256 hex digests. Every resolved path is
// asserted to stay inside DATA_DIR before it is returned.
import path from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export class PathError extends Error {
  override name = "PathError";
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isSha256Hex(value: string): boolean {
  return SHA256_RE.test(value);
}

export const SYSTEM_DIR = "_system";

export class DataPaths {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = path.resolve(dataDir);
  }

  private inside(...segments: string[]): string {
    const resolved = path.resolve(this.root, ...segments);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new PathError("path escapes DATA_DIR");
    }
    return resolved;
  }

  private uuid(value: string, what: string): string {
    if (!isUuid(value)) throw new PathError(`${what} must be a canonical lowercase UUID`);
    return value;
  }

  userDir(userId: string): string {
    return this.inside(this.uuid(userId, "user id"));
  }

  chatsDir(userId: string): string {
    return this.inside(this.uuid(userId, "user id"), "chats");
  }

  chatFile(userId: string, conversationId: string): string {
    return this.inside(
      this.uuid(userId, "user id"),
      "chats",
      `${this.uuid(conversationId, "conversation id")}.md`,
    );
  }

  indexDir(userId: string): string {
    return this.inside(this.uuid(userId, "user id"), "index");
  }

  indexFile(userId: string): string {
    return this.inside(this.uuid(userId, "user id"), "index", "chats.json");
  }

  /** Present while a canonical mutation may not yet be reflected in the index. */
  indexDirtyFile(userId: string): string {
    return this.inside(this.uuid(userId, "user id"), "index", "chats.dirty");
  }

  operationsDir(userId: string): string {
    return this.inside(this.uuid(userId, "user id"), "operations");
  }

  operationFile(userId: string, digest: string): string {
    if (!isSha256Hex(digest)) throw new PathError("operation digest must be lowercase SHA-256 hex");
    return this.inside(this.uuid(userId, "user id"), "operations", `${digest}.json`);
  }

  attachmentsDir(userId: string): string {
    return this.inside(this.uuid(userId, "user id"), "attachments");
  }

  /** One attachment's directory, named by its server-minted id (never the filename, INV-28). */
  attachmentDir(userId: string, attachmentId: string): string {
    return this.inside(
      this.uuid(userId, "user id"),
      "attachments",
      this.uuid(attachmentId, "attachment id"),
    );
  }

  attachmentBlob(userId: string, attachmentId: string): string {
    return path.join(this.attachmentDir(userId, attachmentId), "blob");
  }

  attachmentMeta(userId: string, attachmentId: string): string {
    return path.join(this.attachmentDir(userId, attachmentId), "meta.json");
  }

  memoriesDir(userId: string): string {
    return this.inside(this.uuid(userId, "user id"), "memories");
  }

  /** One approved memory, named by its server-minted id (never its name, INV-12). */
  memoryFile(userId: string, memoryId: string): string {
    return this.inside(
      this.uuid(userId, "user id"),
      "memories",
      `${this.uuid(memoryId, "memory id")}.md`,
    );
  }

  proposalsDir(userId: string): string {
    return this.inside(this.uuid(userId, "user id"), "proposals");
  }

  /** A conversation's proposal sidecar (contracts §4.3). */
  proposalsFile(userId: string, conversationId: string): string {
    return this.inside(
      this.uuid(userId, "user id"),
      "proposals",
      `${this.uuid(conversationId, "conversation id")}.json`,
    );
  }

  artifactsDir(userId: string): string {
    return this.inside(this.uuid(userId, "user id"), "artifacts");
  }

  /** One artifact, named by its server-minted id (never its display name, INV-41). */
  artifactDir(userId: string, artifactId: string): string {
    return this.inside(
      this.uuid(userId, "user id"),
      "artifacts",
      this.uuid(artifactId, "artifact id"),
    );
  }

  artifactBlob(userId: string, artifactId: string): string {
    return path.join(this.artifactDir(userId, artifactId), "blob");
  }

  artifactMeta(userId: string, artifactId: string): string {
    return path.join(this.artifactDir(userId, artifactId), "meta.json");
  }

  /** Transient import/export operation state (Phase 13d); never canonical, never exported. */
  importStagingDir(userId: string): string {
    return this.inside(this.uuid(userId, "user id"), "import-staging");
  }

  /** One import: its uploaded archive and durable journal. */
  importDir(userId: string, importId: string): string {
    return this.inside(
      this.uuid(userId, "user id"),
      "import-staging",
      this.uuid(importId, "import id"),
    );
  }

  /** Completed import keys (duplicate-import idempotency), bounded. */
  importLedger(userId: string): string {
    return this.inside(this.uuid(userId, "user id"), "import-staging", "completed.json");
  }

  exportsDir(userId: string): string {
    return this.inside(this.uuid(userId, "user id"), "import-staging", "exports");
  }

  /** One export's snapshot and archive, removed after its retention. */
  exportDir(userId: string, exportId: string): string {
    return this.inside(
      this.uuid(userId, "user id"),
      "import-staging",
      "exports",
      this.uuid(exportId, "export id"),
    );
  }

  /** Account directories being removed by closure (contracts §6). */
  deletingDir(): string {
    return this.inside(SYSTEM_DIR, "deleting");
  }

  systemDir(): string {
    return this.inside(SYSTEM_DIR);
  }

  userFile(userId: string): string {
    return this.inside(this.uuid(userId, "user id"), "user.json");
  }

  preferencesFile(userId: string): string {
    return this.inside(this.uuid(userId, "user id"), "preferences.json");
  }

  skillsFile(userId: string): string {
    return this.inside(this.uuid(userId, "user id"), "skills.json");
  }

  /** Derived username → user id map (rebuildable from user.json files). */
  usersIndexFile(): string {
    return this.inside(SYSTEM_DIR, "users.index.json");
  }

  generationsDir(): string {
    return this.inside(SYSTEM_DIR, "generations");
  }

  generationFile(generationId: string): string {
    return this.inside(
      SYSTEM_DIR,
      "generations",
      `${this.uuid(generationId, "generation id")}.json`,
    );
  }

  sessionsDir(): string {
    return this.inside(SYSTEM_DIR, "sessions");
  }

  /** Sessions are named by the SHA-256 of their token; the token is never stored. */
  sessionFile(tokenHash: string): string {
    if (!isSha256Hex(tokenHash)) throw new PathError("session name must be lowercase SHA-256 hex");
    return this.inside(SYSTEM_DIR, "sessions", `${tokenHash}.json`);
  }
}
