import { describe, expect, it } from "vitest";
import { chainTips, lightClientHeads, messages, transfers } from "../../ponder.schema";
import { ageMessages, coverMessages, findTransfer, writeMessage } from "../../src/lib/message-store";
import { createFakeDatabase } from "./support/fake-database";

/** The finality window of chain 1 in the test deployment: 2 epochs of 32 slots of 12 seconds. */
const FINALITY = 768n;
const messageId = `0x${"ab".repeat(32)}` as const;
const otherId = `0x${"cd".repeat(32)}` as const;
const sender = "0x00000000000000000000000000000000000001aa" as const;

const send = { kind: "token", sender, sentBlockNumber: 100n, sentTimestamp: 1_000n } as const;

const write = (
  database: ReturnType<typeof createFakeDatabase>,
  patch: Parameters<typeof writeMessage>[0]["patch"],
  sourceTimestampHint?: bigint,
) =>
  writeMessage({
    database: database.handle as never,
    messageId,
    sourceChainId: 1,
    destinationChainId: 369,
    patch,
    ...(sourceTimestampHint === undefined ? {} : { sourceTimestampHint }),
  });

const tip = (timestamp: bigint) => ({ chainId: 1, blockNumber: 1n, timestamp, baseFeePerGas: null });
const head = (executionBlockNumber: bigint) => ({
  chainId: 369,
  slot: 77n,
  headerRoot: `0x${"11".repeat(32)}`,
  executionBlockNumber,
  updatedTimestamp: 1_500n,
  updateCount: 1,
});

describe("writeMessage", () => {
  it("stores a new message as sent and returns the row that it wrote", async () => {
    const database = createFakeDatabase();
    const row = await write(database, send);
    expect(row).toMatchObject({ messageId, direction: "1>369", status: "sent", kind: "token", sentTimestamp: 1_000n });
    expect(database.row(messages, { messageId })).toEqual(row);
  });

  it("uses the chain tip as the clock of the source chain", async () => {
    const database = createFakeDatabase();
    database.seed(chainTips, tip(1_000n + FINALITY));
    expect((await write(database, send)).status).toBe("waiting_for_finality");
  });

  it("uses the timestamp hint when the chain has no tip yet", async () => {
    const database = createFakeDatabase();
    expect((await write(database, send, 1_000n + FINALITY)).status).toBe("waiting_for_finality");
  });

  it("takes the newer of the tip and the hint", async () => {
    const hintNewer = createFakeDatabase();
    hintNewer.seed(chainTips, tip(1_000n));
    expect((await write(hintNewer, send, 1_000n + FINALITY)).status).toBe("waiting_for_finality");
    const tipNewer = createFakeDatabase();
    tipNewer.seed(chainTips, tip(1_000n + FINALITY));
    expect((await write(tipNewer, send, 1_000n)).status).toBe("waiting_for_finality");
  });

  it("keeps the status sent while the window has not passed", async () => {
    const database = createFakeDatabase();
    database.seed(chainTips, tip(1_000n + FINALITY - 1n));
    expect((await write(database, send)).status).toBe("sent");
  });

  it("covers the message at once when a stored head already reaches its block", async () => {
    const database = createFakeDatabase();
    database.seed(lightClientHeads, head(100n));
    const row = await write(database, send);
    expect(row).toMatchObject({ status: "covered", coveredByHeadSlot: 77n, coveredAtTimestamp: 1_500n });
  });

  it("does not cover the message when the stored head stops before its block", async () => {
    const database = createFakeDatabase();
    database.seed(lightClientHeads, head(99n));
    expect(await write(database, send)).toMatchObject({ status: "sent", coveredByHeadSlot: null });
  });

  it("does not cover a message with no send block, as when the delivery arrives first", async () => {
    const database = createFakeDatabase();
    database.seed(lightClientHeads, head(100n));
    expect(await write(database, { deliveredSuccess: true, deliveredTimestamp: 2_000n })).toMatchObject({
      status: "delivered",
      coveredByHeadSlot: null,
    });
  });

  it("does not move the slot of a message that a head covered earlier", async () => {
    const database = createFakeDatabase();
    database.seed(lightClientHeads, head(100n));
    await write(database, send);
    database.seed(lightClientHeads, { ...head(500n), slot: 99n, updatedTimestamp: 1_900n });
    expect(await write(database, { sender })).toMatchObject({ coveredByHeadSlot: 77n, coveredAtTimestamp: 1_500n });
  });

  it("updates the row of a known message and keeps its earlier facts", async () => {
    const database = createFakeDatabase();
    await write(database, send);
    const row = await write(database, { deliveredSuccess: true, deliveredTimestamp: 2_000n });
    expect(row).toMatchObject({ status: "delivered", sentBlockNumber: 100n, deliveredTimestamp: 2_000n });
    expect(database.rows(messages)).toHaveLength(1);
  });
});

describe("coverMessages", () => {
  it("writes the head into each message that the query returns and answers their number", async () => {
    const database = createFakeDatabase();
    database.seed(messages, { ...(await write(createFakeDatabase(), send)), messageId });
    database.seed(messages, { ...(await write(createFakeDatabase(), send)), messageId: otherId });
    database.queueSqlRows([
      { messageId, sourceChainId: 1 },
      { messageId: otherId, sourceChainId: 1 },
    ]);
    const count = await coverMessages(database.handle as never, 369, { slot: 88n, executionBlockNumber: 100n, timestamp: 1_600n });
    expect(count).toBe(2);
    for (const id of [messageId, otherId]) {
      expect(database.row(messages, { messageId: id })).toMatchObject({ status: "covered", coveredByHeadSlot: 88n, coveredAtTimestamp: 1_600n });
    }
  });

  it("answers zero and writes nothing when no message waits for the head", async () => {
    const database = createFakeDatabase();
    database.queueSqlRows([]);
    expect(await coverMessages(database.handle as never, 369, { slot: 88n, executionBlockNumber: 1n, timestamp: 1n })).toBe(0);
    expect(database.writes).toEqual([]);
  });
});

describe("ageMessages", () => {
  it("rewrites each message that the query returns with the new clock, so that it leaves sent", async () => {
    const database = createFakeDatabase();
    database.seed(messages, { ...(await write(createFakeDatabase(), send)), messageId });
    database.queueSqlRows([{ messageId, destinationChainId: 369 }]);
    await ageMessages(database.handle as never, 1, 1_000n + FINALITY);
    expect(database.row(messages, { messageId })).toMatchObject({ status: "waiting_for_finality" });
  });

  it("writes nothing when no message is old enough", async () => {
    const database = createFakeDatabase();
    database.queueSqlRows([]);
    await ageMessages(database.handle as never, 1, 5n);
    expect(database.writes).toEqual([]);
  });
});

describe("findTransfer", () => {
  it("answers the transfer row of a message, or null", async () => {
    const database = createFakeDatabase();
    expect(await findTransfer(database.handle as never, messageId)).toBeNull();
    database.seed(transfers, { messageId, value: 1n });
    expect(await findTransfer(database.handle as never, messageId)).toEqual({ messageId, value: 1n });
  });
});
