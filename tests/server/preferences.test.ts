import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChatIndex } from "../../server/storage/chat-index.ts";
import { KeyedLocks } from "../../server/storage/locks.ts";
import { DataPaths } from "../../server/storage/paths.ts";
import { DEFAULT_PREFERENCES, PreferencesStore } from "../../server/storage/preferences.ts";
import { captureLogger, tempDataDir } from "./helpers.ts";

const U = "0b7e7c2a-1111-4a1a-8a1a-111111111111";
const C = "9d44e1f0-2222-4b2b-9b2b-222222222222";

function setup() {
  const dir = tempDataDir();
  const paths = new DataPaths(dir);
  mkdirSync(paths.userDir(U), { recursive: true });
  return { paths, store: new PreferencesStore(paths, new KeyedLocks()) };
}

describe("INV-34: canonical per-user preferences", () => {
  it("a missing file means defaults; unset (null) is distinct from an explicit 0", async () => {
    const { store } = setup();
    expect(await store.get(U)).toEqual(DEFAULT_PREFERENCES);
    const updated = await store.update(U, { imageMaxEdge: 0 });
    expect(updated.imageMaxEdge).toBe(0);
    expect((await store.get(U)).imageMaxEdge).toBe(0);
  });

  it("partial updates preserve unrelated fields, including unknown ones written by later versions", async () => {
    const { paths, store } = setup();
    writeFileSync(
      paths.preferencesFile(U),
      JSON.stringify({ version: 1, pins: [C], futureField: { a: 1 } }),
    );
    await store.update(U, { defaultModel: "m" });
    const raw = JSON.parse(readFileSync(paths.preferencesFile(U), "utf8")) as Record<
      string,
      unknown
    >;
    expect(raw).toMatchObject({ pins: [C], defaultModel: "m", futureField: { a: 1 } });
  });

  it("corrupt or invalid content degrades to defaults field by field", async () => {
    const { paths, store } = setup();
    writeFileSync(paths.preferencesFile(U), "{not json");
    expect(await store.get(U)).toEqual(DEFAULT_PREFERENCES);
    writeFileSync(
      paths.preferencesFile(U),
      JSON.stringify({
        pins: ["../x", C],
        historyImages: "sometimes",
        imageMaxEdge: -3,
        defaultModel: 5,
      }),
    );
    expect(await store.get(U)).toEqual({ ...DEFAULT_PREFERENCES, pins: [C] });
  });

  it("concurrent updates under the per-user lock never lose each other's fields", async () => {
    const { store } = setup();
    await Promise.all([
      store.update(U, { defaultModel: "a" }),
      store.update(U, { defaultProvider: "p" }),
      store.update(U, { historyImages: "omit" }),
      store.update(U, { pins: [C] }),
    ]);
    expect(await store.get(U)).toMatchObject({
      defaultModel: "a",
      defaultProvider: "p",
      historyImages: "omit",
      pins: [C],
    });
  });

  it("an index rebuild never touches preferences", async () => {
    const { paths, store } = setup();
    await store.update(U, { pins: [C] });
    const before = readFileSync(paths.preferencesFile(U), "utf8");
    await new ChatIndex(paths, captureLogger().logger).rebuild(U);
    expect(readFileSync(path.join(paths.userDir(U), "preferences.json"), "utf8")).toBe(before);
  });
});
