import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createForkScheduleStore } from "@zkb/data";
import { fileForkScheduleText, forkScheduleDirectory } from "../src/config/index.js";

const copy = { forks: [{ version: "0x90000070", epoch: 50, name: "Altair" }], clock: { genesisTime: 1_000_000, secondsPerSlot: 12, slotsPerEpoch: 32 }, fetchedAt: 1_700_000_000 };

describe("fork schedule files", () => {
  it("live in the configuration directory", () => {
    expect(forkScheduleDirectory({ EXPLORER_CONFIG_DIR: "/c" })).toBe("/c/fork-schedules");
  });

  it("read null before the first write, then the copy, one file per chain", async () => {
    const directory = join(await mkdtemp(join(tmpdir(), "zkb-fork-")), "fork-schedules");
    const store = createForkScheduleStore(fileForkScheduleText(directory));
    expect(await store.load(1)).toBeNull();
    await store.save(1, copy);
    expect(await store.load(1)).toEqual(copy);
    expect(JSON.parse(await readFile(join(directory, "zkb.fork-schedule.1.json"), "utf8"))).toEqual(copy);
  });

  it("throw on an error other than a missing file, which the store turns into no copy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zkb-fork-"));
    const text = fileForkScheduleText(directory);
    await writeFile(join(directory, "zkb.fork-schedule.2.json"), "{}");
    await chmod(join(directory, "zkb.fork-schedule.2.json"), 0o000);
    await expect(text.read("zkb.fork-schedule.2")).rejects.toThrow();
    expect(await createForkScheduleStore(text).load(2)).toBeNull();
  });
});
