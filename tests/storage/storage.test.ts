import { mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChatIndex } from "../../server/storage/chat-index.ts";
import { ConversationStore } from "../../server/storage/conversations.ts";
import { atomicWrite, cleanupTempFiles } from "../../server/storage/fs.ts";
import { KeyedLocks } from "../../server/storage/locks.ts";
import { DataPaths, PathError } from "../../server/storage/paths.ts";
import { captureLogger, tempDataDir } from "../server/helpers.ts";

const U = "5f0c6a3e-9d0b-4c1e-8f2a-3b6d7e8f9a01";
const C = "0b7e7c2a-1111-4a1a-8a1a-111111111111";

function setup() {
  const dir = tempDataDir();
  const paths = new DataPaths(dir);
  const logs = captureLogger();
  const index = new ChatIndex(paths, logs.logger);
  const store = new ConversationStore({ paths, locks: new KeyedLocks(), index });
  mkdirSync(paths.userDir(U), { recursive: true });
  return { dir, paths, index, store, logs };
}

describe("INV-12: centralized paths", () => {
  const paths = new DataPaths("/srv/data");
  it.each([
    "../etc",
    "..",
    "",
    "5F0C6A3E-9D0B-4C1E-8F2A-3B6D7E8F9A01",
    "a/b",
    `${U}/..`,
    "_system",
    "x\u0000y",
  ])("rejects user id %j before any filesystem access", (value) => {
    expect(() => paths.userDir(value)).toThrow(PathError);
    expect(() => paths.chatFile(value, C)).toThrow(PathError);
  });

  it.each(["../../x", `${C}.md`, "../index/chats", C.toUpperCase()])(
    "rejects conversation id %j",
    (value) => {
      expect(() => paths.chatFile(U, value)).toThrow(PathError);
    },
  );

  it("rejects operation digests that are not lowercase SHA-256 hex", () => {
    expect(() => paths.operationFile(U, "../x")).toThrow(PathError);
    expect(() => paths.operationFile(U, "A".repeat(64))).toThrow(PathError);
    expect(paths.operationFile(U, "a".repeat(64))).toBe(
      `/srv/data/${U}/operations/${"a".repeat(64)}.json`,
    );
  });

  it("builds every path inside DATA_DIR", () => {
    for (const p of [
      paths.chatFile(U, C),
      paths.indexFile(U),
      paths.indexDirtyFile(U),
      paths.systemDir(),
    ]) {
      expect(p.startsWith("/srv/data/")).toBe(true);
    }
  });
});

describe("atomic durable writes (contracts §2)", () => {
  it("a crash before rename leaves the old file intact and no partial file", async () => {
    const { dir } = setup();
    const target = path.join(dir, "file.txt");
    await atomicWrite(target, "old");
    await expect(
      atomicWrite(target, "new", {
        beforeRename: () => {
          throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    expect(readFileSync(target, "utf8")).toBe("old");
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("writes files 0600 and replaces atomically", async () => {
    const { dir } = setup();
    const target = path.join(dir, "file.txt");
    await atomicWrite(target, "one");
    await atomicWrite(target, "two");
    expect(readFileSync(target, "utf8")).toBe("two");
    if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("startup cleanup removes only old temp files matching the pattern", async () => {
    const { dir } = setup();
    const sub = path.join(dir, U, "chats");
    mkdirSync(sub, { recursive: true });
    const oldTemp = path.join(sub, `.${C}.md.0123456789abcdef.tmp`);
    const freshTemp = path.join(sub, `.${C}.md.fedcba9876543210.tmp`);
    const lookalike = path.join(sub, "notes.tmp");
    for (const file of [oldTemp, freshTemp, lookalike]) writeFileSync(file, "x");
    const past = new Date(Date.now() - 60_000);
    utimesSync(oldTemp, past, past);
    const removed = await cleanupTempFiles(dir, new Date(Date.now() - 30_000));
    expect(removed).toBe(1);
    expect(readdirSync(sub).sort()).toEqual([path.basename(freshTemp), "notes.tmp"].sort());
  });
});

describe("locking", () => {
  it("concurrent appends under the conversation lock never lose messages", async () => {
    const { store } = setup();
    const created = await store.create(U);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.withLock(U, created.id, async () => {
          const current = await store.get(U, created.id);
          const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
          await store.writeUnlocked(
            U,
            created.id,
            store.appendBlocks(current.model, [{ type: "user", id, body: `m${String(i)}` }]),
          );
        }),
      ),
    );
    expect((await store.get(U, created.id)).model.blocks).toHaveLength(25);
  });

  it("serializes holders of the same key and counts held locks", async () => {
    const locks = new KeyedLocks();
    const order: string[] = [];
    let release!: () => void;
    const first = locks.run("k", () =>
      new Promise<void>((r) => (release = r)).then(() => order.push("first")),
    );
    const second = locks.run("k", () => Promise.resolve(order.push("second")));
    await new Promise((resolve) => setImmediate(resolve));
    expect(locks.held).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    expect(locks.held).toBe(0);
  });
});

describe("INV-12/INV-28: every id-derived path is checked", () => {
  it("INV-28/INV-39: attachment, artifact and memory ids must be canonical UUIDs", () => {
    const paths = new DataPaths(tempDataDir());
    for (const bad of ["../x", "a/b", "..", "", "00000000-0000-4000-8000-00000000000A"]) {
      expect(() => paths.attachmentDir(U, bad), bad).toThrow(PathError);
      expect(() => paths.attachmentBlob(U, bad), bad).toThrow(PathError);
      expect(() => paths.attachmentDir(bad, "00000000-0000-4000-8000-000000000001"), bad).toThrow(
        PathError,
      );
      expect(() => paths.memoryFile(U, bad), bad).toThrow(PathError);
      expect(() => paths.artifactDir(U, bad), bad).toThrow(PathError);
    }
  });
});

describe("INV-11: derived index", () => {
  it("INV-11: a dirty marker forces a rebuild even when size and mtime are unchanged", async () => {
    const { paths, index, store } = setup();
    const a = await store.create(U, "Alpha");
    expect(index.list(U).map((e) => e.title)).toEqual(["Alpha"]);
    // An edit reconcile cannot see (same size, same mtime), as after a crash
    // between the canonical write and the index update.
    const file = paths.chatFile(U, a.id);
    // A whole-second mtime, so it can be restored exactly after the edit.
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    await new ChatIndex(paths, captureLogger().logger).rebuild(U);
    const before = statSync(file);
    writeFileSync(file, readFileSync(file, "utf8").replace("Alpha", "Omega"));
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    expect(statSync(file).size).toBe(before.size);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    const unaware = new ChatIndex(paths, captureLogger().logger);
    await unaware.load(U);
    // Without the marker the change is invisible: that is what the marker is for.
    expect(unaware.list(U).map((e) => e.title)).toEqual(["Alpha"]);
    writeFileSync(paths.indexDirtyFile(U), "");
    const fresh = new ChatIndex(paths, captureLogger().logger);
    await fresh.load(U);
    expect(fresh.list(U).map((e) => e.title)).toEqual(["Omega"]);
  });

  it("rebuilds from canonical files when the index is missing, unparseable or dirty", async () => {
    const { paths, index, store } = setup();
    const a = await store.create(U, "Alpha");
    const b = await store.create(U, "Beta");
    const listed = () =>
      index
        .list(U)
        .map((e) => e.title)
        .sort();
    expect(listed()).toEqual(["Alpha", "Beta"]);

    for (const damage of [
      () => {
        writeFileSync(paths.indexFile(U), "{not json");
      },
      () => {
        writeFileSync(paths.indexFile(U), JSON.stringify({ version: 1, entries: [] }));
      },
    ]) {
      damage();
      const fresh = new ChatIndex(paths, captureLogger().logger);
      await fresh.load(U);
      // An empty-but-valid index is trusted unless dirty; mark dirty for the second case.
      if (fresh.list(U).length === 0) {
        writeFileSync(paths.indexDirtyFile(U), "");
        await fresh.load(U);
      }
      expect(
        fresh
          .list(U)
          .map((e) => e.id)
          .sort(),
      ).toEqual([a.id, b.id].sort());
    }
  });

  it("deleting the index and restarting loses nothing", async () => {
    const { paths, store } = setup();
    await store.create(U, "Keep me");
    const { rmSync } = await import("node:fs");
    rmSync(paths.indexDir(U), { recursive: true, force: true });
    const fresh = new ChatIndex(paths, captureLogger().logger);
    await fresh.load(U);
    expect(fresh.list(U).map((e) => e.title)).toEqual(["Keep me"]);
  });

  it("reflects hand edits after a rebuild and lists malformed files as malformed", async () => {
    const { paths, index, store } = setup();
    const a = await store.create(U, "Before");
    const b = await store.create(U, "Healthy");
    const file = paths.chatFile(U, a.id);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace('title: "Before"', 'title: "After hand edit"'),
    );
    writeFileSync(paths.chatFile(U, b.id), "garbage");
    await index.rebuild(U);
    const entries = Object.fromEntries(index.list(U).map((e) => [e.id, e]));
    expect(entries[a.id]).toMatchObject({ title: "After hand edit", malformed: false });
    expect(entries[b.id]).toMatchObject({ malformed: true, messageCount: 0 });
  });

  it("a mutation leaves no dirty marker behind; an interrupted one forces a rebuild", async () => {
    const { paths, index, store } = setup();
    const created = await store.create(U, "x");
    expect(() => statSync(paths.indexDirtyFile(U))).toThrow();
    // Simulate a crash after the canonical write but before the index update.
    writeFileSync(paths.indexDirtyFile(U), "");
    const file = paths.chatFile(U, created.id);
    writeFileSync(file, readFileSync(file, "utf8").replace('title: "x"', 'title: "y"'));
    const fresh = new ChatIndex(paths, captureLogger().logger);
    await fresh.load(U);
    expect(fresh.list(U)[0]?.title).toBe("y");
    expect(index.list(U)[0]?.title).toBe("x");
  });

  it("a restart reconciles hand edits, new files and removals", async () => {
    const { paths, store } = setup();
    const a = await store.create(U, "Edit me");
    const b = await store.create(U, "Remove me");
    const file = paths.chatFile(U, a.id);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace('title: "Edit me"', 'title: "Edited by hand"'),
    );
    const { rmSync, copyFileSync } = await import("node:fs");
    rmSync(paths.chatFile(U, b.id));
    const added = "0b7e7c2a-9999-4a1a-8a1a-999999999999";
    copyFileSync(file, paths.chatFile(U, added));
    const logs = captureLogger();
    const fresh = new ChatIndex(paths, logs.logger);
    await fresh.load(U);
    expect(
      fresh
        .list(U)
        .map((e) => `${e.id}:${e.title}`)
        .sort(),
    ).toEqual([`${a.id}:Edited by hand`, `${added}:Edited by hand`].sort());
    expect(JSON.stringify(logs.lines())).toContain("reconciled");
  });

  it("ignores and logs unexpected files in chats/ without deleting them", async () => {
    const { paths, index, logs } = setup();
    mkdirSync(paths.chatsDir(U), { recursive: true });
    writeFileSync(path.join(paths.chatsDir(U), "notes.txt"), "keep");
    await index.rebuild(U);
    expect(readFileSync(path.join(paths.chatsDir(U), "notes.txt"), "utf8")).toBe("keep");
    expect(JSON.stringify(logs.lines())).toContain("ignoring unexpected file");
  });
});

describe("INV-10: malformed conversations are never modified", () => {
  it("get and rename refuse; delete works; bytes are untouched", async () => {
    const { paths, store } = setup();
    const created = await store.create(U, "t");
    const file = paths.chatFile(U, created.id);
    writeFileSync(file, "---\nbroken\n");
    await expect(store.get(U, created.id)).rejects.toMatchObject({ kind: "malformed" });
    await expect(store.rename(U, created.id, "new")).rejects.toMatchObject({ kind: "malformed" });
    expect(readFileSync(file, "utf8")).toBe("---\nbroken\n");
    await store.delete(U, created.id);
    expect(() => statSync(file)).toThrow();
  });
});
