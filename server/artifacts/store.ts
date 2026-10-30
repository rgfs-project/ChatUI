// Generated source artifacts (Phase 13c, contracts §12, INV-40, INV-41):
// `artifacts/<uuid>/{blob,meta.json}`. Bytes are written first and the
// metadata last; an artifact is listable only once its capture is finalized,
// so a user can never delete one that recovery could recreate.
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, ensureDir, readOrNull } from "../storage/fs.ts";
import type { KeyedLocks } from "../storage/locks.ts";
import { isUuid, type DataPaths } from "../storage/paths.ts";

/** Per file, per generation and per user. */
export const ARTIFACT_MAX_BYTES = 512 * 1024;
export const ARTIFACTS_PER_GENERATION = 8;
export const ARTIFACT_USER_QUOTA_BYTES = 50 * 1024 * 1024;

/** Text formats a reply may produce; every one is served as inert `text/plain`. */
export const ARTIFACT_TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/x-typescript",
  tsx: "text/x-typescript",
  jsx: "text/javascript",
  py: "text/x-python",
  svg: "image/svg+xml",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "text/x-toml",
  ini: "text/plain",
  sh: "text/x-shellscript",
  sql: "text/x-sql",
  java: "text/x-java",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  go: "text/x-go",
  rs: "text/x-rust",
  rb: "text/x-ruby",
  php: "text/x-php",
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;

/** The display name's problem, or undefined. Names never become paths (INV-41). */
export function artifactNameProblem(name: string): string | undefined {
  if (!NAME_RE.test(name) || name.includes("..")) return "invalid file name";
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (!name.includes(".") || !(ext in ARTIFACT_TYPES)) return "unsupported file type";
  return undefined;
}

export function mediaTypeOf(name: string): string {
  return ARTIFACT_TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "text/plain";
}

/** A capture recorded in the `terminal-decided` checkpoint. */
export interface StagedArtifact {
  captureIndex: number;
  filename: string;
  content: string;
  source: "tool" | "fence";
}

export interface ArtifactMeta {
  version: 1;
  id: string;
  ownerId: string;
  /** Stable capture key (INV-40). */
  assistantMessageId: string;
  captureIndex: number;
  /** Backlink; the conversation may be deleted later. */
  conversationId: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  source: "tool" | "fence";
  createdAt: string;
  /** Set once the terminal sequence (or recovery) finalizes the capture. */
  finalized: boolean;
}

/**
 * The capture convention for replies without tools: a fenced block whose info
 * string has `file=<name>` (for example ```` ```ts file=hello.ts ````). Other
 * fenced blocks are never captured. Unclosed fences and invalid names are
 * skipped. At most `ARTIFACTS_PER_GENERATION`.
 */
export function fencedCaptures(content: string, firstIndex = 0): StagedArtifact[] {
  const out: StagedArtifact[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,}|~{3,})[^`]*?\bfile=("[^"]+"|\S+)/.exec(lines[i] ?? "");
    if (!open) continue;
    const fence = open[1] ?? "```";
    const name = (open[2] ?? "").replace(/^"|"$/g, "");
    const body: string[] = [];
    let closed = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j] ?? "";
      const close = /^(`{3,}|~{3,})\s*$/.exec(line);
      const marker = close?.[1] ?? "";
      if (marker.length >= fence.length && marker.startsWith(fence.charAt(0))) {
        closed = true;
        break;
      }
      body.push(line);
    }
    i = j;
    if (!closed || artifactNameProblem(name)) continue;
    const text = body.join("\n");
    if (Buffer.byteLength(text, "utf8") > ARTIFACT_MAX_BYTES) continue;
    out.push({
      captureIndex: firstIndex + out.length,
      filename: name,
      content: text,
      source: "fence",
    });
    if (firstIndex + out.length >= ARTIFACTS_PER_GENERATION) break;
  }
  return out;
}

/** Server-minted id, stable for one capture key: recovery finds what it created. */
export function artifactId(
  userId: string,
  assistantMessageId: string,
  captureIndex: number,
): string {
  const hex = createHash("sha256")
    .update(`artifact:${userId}:${assistantMessageId}:${String(captureIndex)}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class ArtifactStore {
  private readonly paths: DataPaths;
  private readonly locks: KeyedLocks;
  private readonly now: () => Date;
  /** Finalized artifacts per user, by assistant message (rebuilt on demand). */
  private readonly cache = new Map<string, ArtifactMeta[]>();

  constructor(paths: DataPaths, locks: KeyedLocks, now: () => Date = () => new Date()) {
    this.paths = paths;
    this.locks = locks;
    this.now = now;
  }

  private dir(userId: string, id?: string): string {
    const root = path.join(this.paths.userDir(userId), "artifacts");
    if (id === undefined) return root;
    if (!isUuid(id)) throw new Error("artifact id must be a canonical UUID");
    return path.join(root, id);
  }

  blobPath(userId: string, id: string): string {
    return path.join(this.dir(userId, id), "blob");
  }

  private async readMeta(userId: string, id: string): Promise<ArtifactMeta | null> {
    if (!isUuid(id)) return null;
    const bytes = await readOrNull(path.join(this.dir(userId, id), "meta.json"));
    if (!bytes) return null;
    try {
      const meta = JSON.parse(bytes.toString("utf8")) as Partial<ArtifactMeta>;
      return meta.version === 1 && meta.id === id && meta.ownerId === userId
        ? (meta as ArtifactMeta)
        : null;
    } catch {
      return null;
    }
  }

  /** A finalized artifact of this user, or null (another user's looks the same, INV-15). */
  async get(userId: string, id: string): Promise<ArtifactMeta | null> {
    const meta = await this.readMeta(userId, id);
    return meta?.finalized ? meta : null;
  }

  /** Finalized artifacts, newest first. */
  async list(userId: string): Promise<ArtifactMeta[]> {
    const cached = this.cache.get(userId);
    if (cached) return cached;
    let names: string[];
    try {
      names = await readdir(this.dir(userId));
    } catch {
      names = [];
    }
    const metas: ArtifactMeta[] = [];
    for (const name of names) {
      const meta = await this.readMeta(userId, name);
      if (meta?.finalized) metas.push(meta);
    }
    metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    this.cache.set(userId, metas);
    return metas;
  }

  async forMessage(userId: string, assistantMessageId: string): Promise<ArtifactMeta[]> {
    return (await this.list(userId))
      .filter((m) => m.assistantMessageId === assistantMessageId)
      .sort((a, b) => a.captureIndex - b.captureIndex);
  }

  async usage(userId: string): Promise<number> {
    return (await this.list(userId)).reduce((sum, m) => sum + m.size, 0);
  }

  /**
   * Creates (bytes, then metadata, unfinalized) the artifacts of one complete
   * reply, idempotently by `(assistantMessageId, captureIndex)`: an existing
   * capture is kept. Caller holds the conversation lock (contracts §4.3).
   * Over-quota captures are skipped. Returns the ids to finalize.
   */
  async captureUnlocked(
    userId: string,
    input: {
      conversationId: string;
      assistantMessageId: string;
      staged: readonly StagedArtifact[];
    },
  ): Promise<string[]> {
    const ids: string[] = [];
    let used = await this.usage(userId);
    for (const capture of input.staged.slice(0, ARTIFACTS_PER_GENERATION)) {
      const id = artifactId(userId, input.assistantMessageId, capture.captureIndex);
      if (await this.readMeta(userId, id)) {
        ids.push(id);
        continue;
      }
      const bytes = Buffer.from(capture.content, "utf8");
      if (
        artifactNameProblem(capture.filename) ||
        bytes.length > ARTIFACT_MAX_BYTES ||
        used + bytes.length > ARTIFACT_USER_QUOTA_BYTES
      )
        continue;
      await this.locks.run(`artifact:${userId}/${id}`, async () => {
        const dir = this.dir(userId, id);
        await ensureDir(this.dir(userId));
        await ensureDir(dir);
        await atomicWrite(path.join(dir, "blob"), bytes);
        const meta: ArtifactMeta = {
          version: 1,
          id,
          ownerId: userId,
          assistantMessageId: input.assistantMessageId,
          captureIndex: capture.captureIndex,
          conversationId: input.conversationId,
          filename: capture.filename,
          mediaType: mediaTypeOf(capture.filename),
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          source: capture.source,
          createdAt: this.now().toISOString(),
          finalized: false,
        };
        await atomicWrite(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
      });
      used += bytes.length;
      ids.push(id);
    }
    return ids;
  }

  /** Marks captures finalized: from now on they are listable and deletable. */
  async finalizeUnlocked(userId: string, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await this.locks.run(`artifact:${userId}/${id}`, async () => {
        const meta = await this.readMeta(userId, id);
        if (!meta || meta.finalized) return;
        await atomicWrite(
          path.join(this.dir(userId, id), "meta.json"),
          `${JSON.stringify({ ...meta, finalized: true }, null, 2)}\n`,
        );
      });
    }
    this.cache.delete(userId);
  }

  /** Deletes a finalized artifact (metadata first, so a half-deleted one is never listed). */
  async delete(userId: string, id: string): Promise<boolean> {
    const removed = await this.locks.run(`artifact:${userId}/${id}`, async () => {
      if (!(await this.get(userId, id))) return false;
      await rm(path.join(this.dir(userId, id), "meta.json"), { force: true });
      await rm(this.dir(userId, id), { recursive: true, force: true });
      return true;
    });
    this.cache.delete(userId);
    return removed;
  }

  /** Startup: directories without metadata are interrupted writes and go. */
  async reconcile(userId: string): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir(userId));
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (!isUuid(name)) continue;
      if (await readOrNull(path.join(this.dir(userId, name), "meta.json"))) continue;
      await rm(this.dir(userId, name), { recursive: true, force: true });
      removed++;
    }
    this.cache.delete(userId);
    return removed;
  }

  forgetUser(userId: string): void {
    this.cache.delete(userId);
  }
}
