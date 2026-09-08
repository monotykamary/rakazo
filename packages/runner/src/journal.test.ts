import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForwardJournal } from "./journal.js";

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("forward journal", () => {
  it("survives a restart and replays completed results", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "rakazo-journal-"));
    const first = await ForwardJournal.load(path.join(dir, "journal.jsonl"));
    await first.begin("c1", "POST", "/computers");
    await first.complete("c1", 200, "eyJvayI6dHJ1ZX0=", "application/json");
    expect(first.lookup("c1")).toMatchObject({ state: "completed", status: 200 });

    const second = await ForwardJournal.load(path.join(dir, "journal.jsonl"));
    expect(second.lookup("c1")).toMatchObject({
      state: "completed",
      status: 200,
      bodyBase64: "eyJvayI6dHJ1ZX0=",
      contentType: "application/json",
    });
  });

  it("tolerates a torn tail write from a crash", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "rakazo-journal-"));
    const first = await ForwardJournal.load(path.join(dir, "journal.jsonl"));
    await first.begin("c1", "POST", "/computers");
    const file = path.join(dir, "journal.jsonl");
    const existing = await readFile(file, "utf8");
    await rm(file);
    await ForwardJournal.load(file);
    const torn = await ForwardJournal.load(
      await (async () => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(file, `${existing}{"deliveryId":"c2","method":"PO`);
        return file;
      })(),
    );
    expect(torn.lookup("c1")).toMatchObject({ state: "started" });
    expect(torn.lookup("c2")).toBeUndefined();
  });

  it("stays bounded by dropping old completed records on compaction", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "rakazo-journal-"));
    const journal = await ForwardJournal.load(path.join(dir, "journal.jsonl"));
    for (let index = 0; index < 2100; index += 1) {
      await journal.begin(`c${index}`, "POST", "/computers");
      await journal.complete(`c${index}`, 200);
    }
    // Started entries are never dropped; old completed ones are.
    expect(journal.lookup("c2099")).toMatchObject({ state: "completed", status: 200 });
    expect(journal.lookup("c0")).toBeUndefined();
    const lines = (await readFile(path.join(dir, "journal.jsonl"), "utf8")).trim().split("\n");
    expect(lines.length).toBeLessThan(512);
  });
});
