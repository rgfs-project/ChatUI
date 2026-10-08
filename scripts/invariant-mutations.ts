/**
 * One targeted mutation per invariant (Phase 17): `find` must occur exactly
 * once in `file`; `replace` breaks the enforcement. `tests` are the files the
 * invariant register names (vitest paths, e2e specs, or "verify").
 */
export interface Edit {
  file?: string;
  find: string;
  replace: string;
}

export interface Mutation {
  id: string;
  file: string;
  what: string;
  find: string;
  replace: string;
  /** Further edits applied together (enforcement that exists in more than one place). */
  also?: Edit[];
  tests: string[];
}

export const MUTATIONS: Mutation[] = [
  {
    id: "INV-01",
    file: "server/errors.ts",
    what: "unhandled errors expose their message",
    find: `sendError(res, new AppError(ErrorCode.INTERNAL, "Internal server error"));`,
    replace: `sendError(res, new AppError(ErrorCode.INTERNAL, String((err as Error).stack)));`,
    tests: ["tests/server/errors.test.ts"],
  },
  {
    id: "INV-02",
    file: "server/validation.ts",
    what: "validation issues are ignored",
    find: "if (issues.length > 0) {",
    replace: "if (issues.length > 0 && false) {",
    tests: ["tests/server/errors.test.ts"],
  },
  {
    id: "INV-03",
    file: "server/registry.ts",
    what: "handler output skips its DTO schema",
    find: "const dto: unknown = route.response.parse(output);",
    replace: "const dto: unknown = output;",
    tests: ["tests/server/errors.test.ts", "tests/server/registry.test.ts"],
  },
  {
    id: "INV-04",
    file: "server/providers/llamacpp.ts",
    what: "an upstream error message is passed to the client",
    find: "type = isObject(body) && isObject(body.error) ? body.error.type : undefined;",
    replace: "type = isObject(body) && isObject(body.error) ? body.error.message : undefined;",
    also: [
      {
        find: `      "The model server returned an error",`,
        replace: "      `The model server returned an error: ${String(type)}`,",
      },
    ],
    tests: ["tests/server/generations.test.ts", "tests/server/providers.test.ts"],
  },
  {
    id: "INV-05",
    file: "server/generations/manager.ts",
    what: "a generation can be decided twice",
    find: "    if (generation.decided) return;\n    generation.decided = true;",
    replace: "    generation.decided = true;",
    also: [
      {
        find: "  private abort(generation: Generation, reason: AbortReason): void {\n    if (generation.decided) return;",
        replace: "  private abort(generation: Generation, reason: AbortReason): void {",
      },
      {
        find: "      if (signal.aborted || generation.decided) return;",
        replace: "",
      },
      {
        find: '      if (!aborted(generation)) this.finish(generation, "completed");',
        replace: '      this.finish(generation, "completed");',
      },
    ],
    tests: ["tests/server/manager.test.ts", "tests/server/generations.test.ts"],
  },
  {
    id: "INV-06",
    file: "server/routes/generations.ts",
    what: "an SSE disconnect cancels the generation",
    find: `      () => {
        unsubscribe();
        untrack();
      },`,
    replace: `      () => {
        unsubscribe();
        untrack();
        void services.generations.cancel(params.id, auth.userId).catch(() => undefined);
      },`,
    tests: ["tests/server/generations.test.ts", "tests/server/streaming.test.ts"],
  },
  {
    id: "INV-07",
    file: "server/storage/recovery.ts",
    what: "recovery appends a reply that is already written",
    find: '    if (model.blocks.some((b) => b.type === "assistant" && b.id === input.assistantMessageId)) {',
    replace: "    if (false) {",
    also: [
      {
        find: `    if (input.userMessageId !== null && (last?.type !== "user" || last.id !== input.userMessageId))
      return "superseded";`,
        replace: "    void last;",
      },
    ],
    tests: [
      "tests/server/conversations.test.ts",
      "tests/server/manager.test.ts",
      "tests/server/streaming.test.ts",
      "tests/server/backup.test.ts",
    ],
  },

  {
    id: "INV-08",
    file: "server/chat/send-service.ts",
    what: "the operation record is never marked committed",
    find: `        status: "committed",
        committedAt: this.now().toISOString(),`,
    replace: `        committedAt: this.now().toISOString(),`,
    tests: ["tests/server/conversations.test.ts"],
  },
  {
    id: "INV-09",
    file: "server/storage/markdown.ts",
    what: "bodies are not escaped",
    find: "    .map((line) => (NEEDS_ESCAPE.test(line) ? `\\\\${line}` : line))",
    replace: "    .map((line) => line)",
    tests: ["tests/storage/markdown.test.ts"],
  },
  {
    id: "INV-10",
    file: "server/storage/conversations.ts",
    what: "a malformed file is treated as missing",
    find: `    if (read.kind === "malformed")
      throw new StorageError("malformed", "This conversation file is malformed");
    return read.conversation;`,
    replace: `    if (read.kind === "malformed") throw new StorageError("not_found", "Conversation not found");
    return read.conversation;`,
    tests: ["tests/storage/storage.test.ts", "tests/server/conversations.test.ts"],
  },
  {
    id: "INV-11",
    file: "server/storage/chat-index.ts",
    what: "a dirty index is trusted instead of rebuilt",
    find: "    if (dirty || !isIndexFile(parsed)) {",
    replace: "    if (!isIndexFile(parsed)) {",
    tests: ["tests/storage/storage.test.ts", "tests/server/conversations.test.ts"],
  },
  {
    id: "INV-12",
    file: "server/storage/paths.ts",
    what: "any string becomes a path component",
    find: "    if (!isUuid(value)) throw new PathError(`${what} must be a canonical lowercase UUID`);",
    replace: "    void what;",
    tests: ["tests/storage/storage.test.ts", "tests/server/conversations.test.ts"],
  },
  {
    id: "INV-13",
    file: "server/generations/manager.ts",
    what: "a second generation may start in a busy conversation",
    find: "    if (this.active.has(conversationKey)) {",
    replace: "    if (this.active.has(conversationKey) && false) {",
    tests: ["tests/server/manager.test.ts", "tests/server/conversations.test.ts"],
  },
  {
    id: "INV-16",
    file: "server/auth/service.ts",
    what: "a missing CSRF token is accepted",
    find: "    if (!auth || !token || !tokensEqual(token, auth.csrfToken)) {",
    replace: "    if (!auth) {",
    tests: ["tests/server/registry.test.ts"],
  },
  {
    id: "INV-59",
    file: "server/auth/service.ts",
    what: "a stale X-Expected-User is accepted",
    find: `    if (req.get("x-expected-user") !== auth.userId) {`,
    replace: `    if (req.get("x-expected-user") === "never") {`,
    tests: ["tests/server/auth.test.ts"],
  },
  {
    id: "INV-17",
    file: "server/admin/accounts.ts",
    what: "reducing privileges keeps sessions",
    find: `      await this.o.sessions.revokeUser(id);
      await this.o.generations.cancelAndForgetUser(id);`,
    replace: `      await this.o.generations.cancelAndForgetUser(id);`,
    tests: ["tests/server/admin.test.ts"],
  },
  {
    id: "INV-18",
    file: "server/generations/catalog.ts",
    what: "an unknown model is accepted",
    find: `      throw new AppError(ErrorCode.MODEL_NOT_FOUND, "The selected model is not available");
    }
    return this.toModelDto(registered.entry, found);`,
    replace: `      return this.toModelDto(registered.entry, { id: modelId } as never);
    }
    return this.toModelDto(registered.entry, found);`,
    tests: ["tests/server/providers.test.ts"],
  },
  {
    id: "INV-19",
    file: "server/admin/providers.ts",
    what: "admin endpoints skip DNS resolution checks",
    find: "      await resolveChecked(url, this.o.policy, this.o.resolver);\n      return raw",
    replace: "      void url;\n      return raw",
    tests: ["tests/server/admin.test.ts", "tests/server/providers.test.ts"],
  },
  {
    id: "INV-20",
    file: "server/generations/manager.ts",
    what: "a too-old cursor replays from the buffer instead of resyncing",
    find: "    } else if (cursor > generation.seq || cursor < oldest - 1) {",
    replace: "    } else if (cursor > generation.seq) {",
    tests: ["tests/server/streaming.test.ts"],
  },
  {
    id: "INV-21",
    file: "server/storage/recovery.ts",
    what: "a recovered running generation is labelled complete",
    find: `  interrupted: "interrupted",
};`,
    replace: `  interrupted: "complete",
};`,
    tests: ["tests/server/streaming.test.ts"],
  },
  {
    id: "INV-25",
    file: "server/admin/providers.ts",
    what: "the provider DTO reports a key as absent (hides state) — inverse leak check",
    find: `      hasApiKey: typeof (raw as { apiKey?: unknown }).apiKey === "string",`,
    replace: `      hasApiKey: typeof (raw as { apiKey?: unknown }).apiKey === "string",
      apiKey: (raw as { apiKey?: unknown }).apiKey,`,
    tests: ["tests/server/admin.test.ts"],
  },
  {
    id: "INV-27",
    file: "server/attachments/sniff.ts",
    what: "SVG is no longer recognized as active markup",
    find: "|<svg[\\s>]",
    replace: "",
    tests: ["tests/server/sniff.test.ts", "tests/server/attachments.test.ts"],
  },
  {
    id: "INV-14",
    file: "server/routes/skills.ts",
    what: "a route reads the acting user from a request header",
    find: `import { z } from "zod";`,
    replace: `import { z } from "zod";
export const forgedUser = (req: { headers: Record<string, unknown> }) => req.headers["x-user-id"];`,
    tests: ["tests/server/registry.test.ts"],
  },
  {
    id: "INV-15",
    file: "server/generations/manager.ts",
    what: "another user's generation is found by id",
    find: "    if (!generation || (userId !== undefined && generation.userId !== userId)) {",
    replace: "    if (!generation) {",
    tests: ["tests/server/auth.test.ts", "tests/server/security.test.ts"],
  },
  {
    id: "INV-24",
    file: "server/registry.ts",
    what: "admin routes accept non-admins",
    find: `      if (route.auth === "admin" && auth?.role !== "admin")`,
    replace: `      if (route.auth === "admin" && auth === null)`,
    tests: ["tests/server/admin.test.ts", "tests/server/registry.test.ts"],
  },
  {
    id: "INV-26",
    file: "server/admin/accounts.ts",
    what: "the last active admin can be demoted or disabled",
    find: `        current.status === "active" &&
        activeAdmins(all).length <= 1
      )
        throw new AppError(ErrorCode.LAST_ADMIN, "This is the last active admin account");
      outcome.reduced`,
    replace: `        current.status === "active" &&
        activeAdmins(all).length <= 0
      )
        throw new AppError(ErrorCode.LAST_ADMIN, "This is the last active admin account");
      outcome.reduced`,
    tests: ["tests/server/admin.test.ts"],
  },
  {
    id: "INV-28",
    file: "server/storage/paths.ts",
    what: "attachment ids become path components unchecked",
    find: `      "attachments",
      this.uuid(attachmentId, "attachment id"),`,
    replace: `      "attachments",
      attachmentId,`,
    tests: [
      "tests/server/attachments.test.ts",
      "tests/server/sniff.test.ts",
      "tests/storage/storage.test.ts",
    ],
  },
  {
    id: "INV-36",
    file: "server/chat/search.ts",
    what: "search results are unbounded",
    find: "      if (results.length >= limit) {",
    replace: "      if (false) {",
    tests: ["tests/server/mutations.test.ts"],
  },
  {
    id: "INV-38",
    file: "server/chat/proposals.ts",
    what: "a stale suggestion overwrites a changed memory",
    find: "    if (current.revision !== record.baselineRevision)",
    replace: "    if (false)",
    tests: ["tests/server/memories.test.ts"],
  },
  {
    id: "INV-40",
    file: "server/generations/manager.ts",
    what: "files are captured from incomplete replies",
    find: `    if (state === "completed" && generation.capture) {`,
    replace: `    if (generation.capture) {`,
    also: [
      {
        file: "server/chat/send-service.ts",
        find: '    if (reply?.type !== "assistant" || reply.status !== "complete") return;',
        replace: '    if (reply?.type !== "assistant") return;',
      },

      {
        file: "server/chat/send-service.ts",
        find: '        if (outcome.state !== "completed") return;',
        replace: "",
      },
    ],
    tests: ["tests/server/artifacts.test.ts"],
  },
  {
    id: "INV-41",
    file: "server/routes/artifacts.ts",
    what: "artifact source is served as HTML",
    find: `      "Content-Type": "text/plain; charset=utf-8",`,
    replace: `      "Content-Type": "text/html; charset=utf-8",`,
    tests: ["tests/server/artifacts.test.ts"],
  },
  {
    id: "INV-42",
    file: "server/portability/read-archive.ts",
    what: "the archive entry-count limit is not enforced",
    find: "        if (++records > limits.maxEntries)",
    replace: "        if (false)",
    tests: [
      "tests/server/portability.test.ts",
      "tests/server/import-adapters.test.ts",
      "tests/server/audit-fixes.test.ts",
    ],
  },
  {
    id: "INV-44",
    file: "server/chat/send-service.ts",
    what: "media go to a model without that modality",
    find: "      if (metas.some((m) => m.kind === kind) && !accepts.includes(kind))",
    replace: "      if (false)",
    tests: ["tests/server/attachments.test.ts"],
  },
  {
    id: "INV-50",
    file: "server/backup.ts",
    what: "restore merges into existing data",
    find: '  if (!(await emptyOrMissing(dataDir)))\n    throw new BackupError("DATA_DIR is not empty: restore only into an empty directory");',
    replace: "",
    tests: ["tests/server/backup.test.ts"],
  },
  {
    id: "INV-58",
    file: "server/chat/send-service.ts",
    what: "a reused operation key with a different payload is accepted",
    find: "      if (record.payloadHash !== payloadHash) {",
    replace: "      if (false) {",
    tests: ["tests/server/conversations.test.ts"],
  },
  {
    id: "INV-61",
    file: "server/storage/account.ts",
    what: "a closed or closing account still accepts writes",
    find: "export async function assertAccountWritable(paths: DataPaths, userId: string): Promise<void> {",
    replace:
      "export async function assertAccountWritable(paths: DataPaths, userId: string): Promise<void> {\n  if (userId) return;",
    tests: ["tests/server/admin.test.ts"],
  },
  {
    id: "INV-62",
    file: "server/generations/manager.ts",
    what: "the per-user generation cap is not enforced",
    find: "      (userId !== undefined && this.count((e) => e.userId === userId) >= perUser) ||",
    replace: "      (userId !== undefined && perUser < 0) ||",
    tests: [
      "tests/server/auth.test.ts",
      "tests/server/manager.test.ts",
      "tests/server/generations.test.ts",
    ],
  },
  {
    id: "INV-34",
    file: "server/storage/preferences.ts",
    what: "preference updates run without the per-user lock",
    find: "      this.locks.run(`preferences:${userId}`, async () => {",
    replace:
      "      ((fn: () => Promise<Preferences>) => new Promise((r) => setTimeout(r, 5)).then(fn))(async () => {",
    tests: [
      "tests/server/preferences.test.ts",
      "tests/server/auth.test.ts",
      "tests/server/mutations.test.ts",
    ],
  },
  {
    id: "INV-35",
    file: "server/chat/turns.ts",
    what: "an irregular exchange is treated as a regular one",
    find: '      if (k > j) out.push({ kind: "irregular", start: i, end: k });',
    replace: '      if (false) out.push({ kind: "irregular", start: i, end: k });',
    tests: ["tests/server/mutations.test.ts"],
  },
  {
    id: "INV-37",
    file: "server/routes/memories.ts",
    what: "suggestions can be accepted without the user's CSRF-bound session",
    find: `  path: "/api/conversations/:id/proposals/:proposalId/accept",
  auth: "user",
  csrf: "token",`,
    replace: `  path: "/api/conversations/:id/proposals/:proposalId/accept",
  auth: "user",
  csrf: "none",`,
    tests: ["tests/server/registry.test.ts", "tests/server/memories.test.ts"],
  },
  {
    id: "INV-39",
    file: "server/storage/paths.ts",
    what: "memory ids become path components unchecked",
    find: '      `${this.uuid(memoryId, "memory id")}.md`,',
    replace: "      `${memoryId}.md`,",
    tests: ["tests/storage/storage.test.ts", "tests/server/memories.test.ts"],
  },
  {
    id: "INV-43",
    file: "server/routes/portability.ts",
    what: "single-chat export re-encodes the canonical bytes",
    find: "    const bytes = await ctx.services.exports.conversationBytes(userId, params.id);",
    replace:
      '    const bytes = Buffer.from((await ctx.services.exports.conversationBytes(userId, params.id)).toString("utf8").replace(/\\n/g, "\\r\\n"));',
    tests: ["tests/server/portability.test.ts"],
  },
  {
    id: "INV-54",
    file: "app/routes/chat-conversation.tsx",
    what: "server HTML omits the authorized transcript",
    find: "    client.setQueryData(keys.conversation(auth.userId, id), dto);",
    replace: "    void client;",
    tests: ["verify"],
  },
  {
    id: "INV-55",
    file: "app/entry.server.tsx",
    what: "private documents become cacheable",
    find: `  responseHeaders.set("Cache-Control", "private, no-store");`,
    replace: `  responseHeaders.set("Cache-Control", "public, max-age=60");`,
    tests: ["verify"],
  },
  {
    id: "INV-56",
    file: "app/root.tsx",
    what: "a server-only nonce on links breaks hydration",
    find: `        <Links nonce="" />`,
    replace: `        <Links nonce={typeof document === "undefined" ? "server-only" : ""} />`,
    tests: ["verify"],
  },
  {
    id: "INV-57",
    file: "server/create-app.ts",
    what: "unknown API paths fall through to the document handler",
    find: "  api.use(apiNotFound);",
    replace: "  void apiNotFound;",
    tests: ["tests/server/boundary.test.ts", "tests/server/errors.test.ts"],
  },
  {
    id: "INV-60",
    file: "server/storage/recovery.ts",
    what: "recovery recreates a deleted conversation",
    find: `    if (read.kind === "missing") return "missing";
    if (read.kind === "malformed") return "malformed";
    const model = read.conversation.model;`,
    replace: `    if (read.kind === "missing") {
      await store.create(input.userId, "Recovered");
      return "missing";
    }
    if (read.kind === "malformed") return "malformed";
    const model = read.conversation.model;`,
    tests: ["tests/server/streaming.test.ts", "tests/server/conversations.test.ts"],
  },
];
