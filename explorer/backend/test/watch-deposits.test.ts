import { describe, expect, it } from "vitest";
import { DEPOSITS_READ_TTL_MILLISECONDS, createDepositsReader } from "../src/watch/deposits.ts";

function setup(answers: { open: boolean[]; head: number[] }) {
  let now = 0;
  const reads = { open: 0, head: 0 };
  const read = createDepositsReader({
    readOpen: async () => answers.open[Math.min(reads.open++, answers.open.length - 1)] as boolean,
    readRemoteHeadSlot: async () => answers.head[Math.min(reads.head++, answers.head.length - 1)] as number,
    now: () => now,
  });
  return { read, reads, advance: (milliseconds: number) => void (now += milliseconds) };
}

describe("the deposits reader", () => {
  it("reads the bridge and the remote light client once a minute while the bridge is locked", async () => {
    const run = setup({ open: [false], head: [0, 0, 5] });
    expect(DEPOSITS_READ_TTL_MILLISECONDS).toBe(60_000);
    expect(await run.read()).toEqual({ open: false, remoteHasHead: false });
    run.advance(59_999);
    expect(await run.read()).toEqual({ open: false, remoteHasHead: false });
    expect(run.reads).toEqual({ open: 1, head: 1 });
    run.advance(1);
    expect(await run.read()).toEqual({ open: false, remoteHasHead: false });
    run.advance(60_000);
    expect(await run.read()).toEqual({ open: false, remoteHasHead: true });
    expect(run.reads).toEqual({ open: 3, head: 3 });
    // A light client never loses its head: it is not read again.
    run.advance(60_000);
    await run.read();
    expect(run.reads).toEqual({ open: 4, head: 3 });
  });

  it("stops reading once the bridge is open, and keeps what it knew of the remote head", async () => {
    const run = setup({ open: [false, true], head: [7] });
    expect(await run.read()).toEqual({ open: false, remoteHasHead: true });
    run.advance(60_000);
    expect(await run.read()).toEqual({ open: true, remoteHasHead: true });
    run.advance(10 * 60_000);
    expect(await run.read()).toEqual({ open: true, remoteHasHead: true });
    expect(run.reads).toEqual({ open: 2, head: 1 });
  });

  it("an open bridge at the first read never reads the remote light client", async () => {
    const run = setup({ open: [true], head: [7] });
    expect(await run.read()).toEqual({ open: true, remoteHasHead: null });
    expect(run.reads).toEqual({ open: 1, head: 0 });
  });

  it("a failed read throws and is read again at the next call", async () => {
    let fail = true;
    const read = createDepositsReader({
      readOpen: async () => {
        if (fail) throw new Error("rpc down");
        return false;
      },
      readRemoteHeadSlot: async () => 1,
      now: () => 0,
      ttlMilliseconds: 1000,
    });
    await expect(read()).rejects.toThrow("rpc down");
    fail = false;
    expect(await read()).toEqual({ open: false, remoteHasHead: true });
  });
});
