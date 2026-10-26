import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, LockHeldError } from "../../src/runtime/lock-file.ts";
import { createStateFile, type StateStore } from "../../src/runtime/state-file.ts";
import { createPrerequisiteLedger, type BudgetStore } from "../../src/runner/prerequisite-ledger.ts";
import { INITIAL_RUNNER_STATE, runnerStateSchema, type RunnerState } from "../../src/runner/state.ts";
import { memoryLogger } from "../support/builders.ts";

async function scratchDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "zk-bridge-state-safety-"));
}

function runnerStateFile(path: string): StateStore<RunnerState> {
  return createStateFile({ path, schema: runnerStateSchema, initial: INITIAL_RUNNER_STATE });
}

/** The budget store of the runner, over a state store. It mirrors the adapter in the runner. */
function budgetStoreOf(state: StateStore<RunnerState>): BudgetStore {
  return {
    async load() {
      const { prerequisiteSpend, prerequisiteLosses } = await state.load();
      return { prerequisiteSpend, prerequisiteLosses };
    },
    async update(mutate) {
      await state.update((current) => {
        const budget = { prerequisiteSpend: current.prerequisiteSpend, prerequisiteLosses: current.prerequisiteLosses };
        const next = mutate(budget);
        return next === budget ? current : { ...current, ...next };
      });
    },
  };
}

const NOW = 1_000_000;

function ledgerOver(state: StateStore<RunnerState>, dailySpendWei: bigint) {
  return createPrerequisiteLedger({
    capWei: 1_000_000n,
    limits: { dailySpendWei, unrecoveredLossWei: 1_000_000n },
    store: budgetStoreOf(state),
    now: () => NOW,
    logger: memoryLogger().logger,
  });
}

const sumOf = (state: RunnerState) => state.prerequisiteSpend.reduce((sum, entry) => sum + BigInt(entry.wei), 0n);

describe("concurrent changes to one state file", () => {
  it("lands every reservation and refuses exactly when the sum reaches the daily budget", async () => {
    const path = join(await scratchDirectory(), "runner.json");
    const state = runnerStateFile(path);
    const ledgers = [ledgerOver(state, 250n), ledgerOver(state, 250n), ledgerOver(state, 250n), ledgerOver(state, 250n)];
    const results = await Promise.all(Array.from({ length: 40 }, (_, index) => (ledgers[index % ledgers.length] as (typeof ledgers)[number]).reserve(10n)));
    const accepted = results.filter((result) => result.ok).length;
    const stored = await state.load();
    // 25 reservations of 10 wei reach 250 wei. The 26th sees a paused budget.
    expect(accepted).toBe(25);
    expect(stored.prerequisiteSpend).toHaveLength(25);
    expect(sumOf(stored)).toBe(250n);
    expect(new Set(stored.prerequisiteSpend.map((entry) => entry.id)).size).toBe(25);
  });

  it("keeps the entries of both directions that share one file, also through separate handles", async () => {
    const path = join(await scratchDirectory(), "runner.json");
    const firstDirection = runnerStateFile(path);
    const secondDirection = runnerStateFile(path);
    const firstLedger = ledgerOver(firstDirection, 1_000_000n);
    const secondLedger = ledgerOver(secondDirection, 1_000_000n);
    await Promise.all([
      ...Array.from({ length: 15 }, (_, index) => firstDirection.update((state) => ({ ...state, finished: { ...state.finished, [`first-${index}`]: "0x01" } }))),
      ...Array.from({ length: 15 }, (_, index) => secondDirection.update((state) => ({ ...state, finished: { ...state.finished, [`second-${index}`]: "elsewhere" } }))),
      ...Array.from({ length: 10 }, () => firstLedger.reserve(3n)),
      ...Array.from({ length: 10 }, () => secondLedger.reserve(5n)),
      firstLedger.recordLoss(7n),
      secondLedger.recordLoss(11n),
    ]);
    const stored = await runnerStateFile(path).load();
    expect(Object.keys(stored.finished)).toHaveLength(30);
    expect(stored.prerequisiteSpend).toHaveLength(20);
    expect(sumOf(stored)).toBe(10n * 3n + 10n * 5n);
    expect(stored.prerequisiteLosses.map((entry) => entry.wei).sort()).toEqual(["11", "7"]);
  });

  it("writes nothing when the change returns the state it was given", async () => {
    const path = join(await scratchDirectory(), "runner.json");
    const state = runnerStateFile(path);
    await state.update((current) => current);
    expect(await readdir(join(path, ".."))).toEqual([]);
  });
});

describe("an interrupted write", () => {
  it("leaves the previous file intact and no temporary file behind", async () => {
    const directory = await scratchDirectory();
    const path = join(directory, "runner.json");
    await runnerStateFile(path).update((state) => ({ ...state, finished: { "0x01": "0xaa" } }));
    const before = await readFile(path, "utf8");
    const failing = createStateFile({
      path,
      schema: runnerStateSchema,
      initial: INITIAL_RUNNER_STATE,
      renameFile: async () => {
        throw new Error("the process stopped before the rename");
      },
    });
    await expect(failing.update((state) => ({ ...state, finished: { ...state.finished, "0x02": "0xbb" } }))).rejects.toThrow(/before the rename/);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await readdir(directory)).toEqual(["runner.json"]);
  });

  it("ignores a half-written temporary file that a crash left behind", async () => {
    const directory = await scratchDirectory();
    const path = join(directory, "runner.json");
    await runnerStateFile(path).update((state) => ({ ...state, finished: { "0x01": "0xaa" } }));
    await writeFile(`${path}.deadbeef.tmp`, '{ "schemaVersion": 1, "fini');
    expect(Object.keys((await runnerStateFile(path).load()).finished)).toEqual(["0x01"]);
  });
});

describe("the lock file", () => {
  /** The identifier of a process that has already exited. */
  const deadProcessIdentifier = () => spawnSync(process.execPath, ["-e", ""]).pid as number;

  it("refuses a second start while a live process holds the lock, and allows it after release", async () => {
    const path = join(await scratchDirectory(), "runner.json.lock");
    const held = await acquireLock({ path });
    expect(await readFile(path, "utf8")).toBe(`${process.pid}\n`);
    await expect(acquireLock({ path })).rejects.toBeInstanceOf(LockHeldError);
    await held.release();
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    const again = await acquireLock({ path });
    await again.release();
  });

  it("takes over a stale lock whose process is gone", async () => {
    const path = join(await scratchDirectory(), "runner.json.lock");
    const gone = deadProcessIdentifier();
    await writeFile(path, `${gone}\n`);
    const held = await acquireLock({ path });
    expect(await readFile(path, "utf8")).toBe(`${process.pid}\n`);
    await held.release();
  });

  it("refuses a lock whose file holds no process identifier, because a writer may be mid-write", async () => {
    const path = join(await scratchDirectory(), "runner.json.lock");
    await writeFile(path, "");
    await expect(acquireLock({ path })).rejects.toBeInstanceOf(LockHeldError);
  });

  it("does not remove a lock that another process took after this one lost it", async () => {
    const path = join(await scratchDirectory(), "runner.json.lock");
    const held = await acquireLock({ path, processIdentifier: 111_111, isProcessAlive: () => true });
    await writeFile(path, "222222\n");
    await held.release();
    expect(await readFile(path, "utf8")).toBe("222222\n");
  });
});
