import { describe, expect, it } from "vitest";
import { transfers } from "../../ponder.schema";
import { writeTransfer } from "../../src/lib/transfer-store";
import { createFakeDatabase } from "./support/fake-database";

const messageId = `0x${"ab".repeat(32)}` as const;
const token = "0x00000000000000000000000000000000000001aa" as const;

const write = (database: ReturnType<typeof createFakeDatabase>, patch: Parameters<typeof writeTransfer>[0]["patch"]) =>
  writeTransfer({ database: database.handle as never, messageId, sourceChainId: 1, destinationChainId: 369, patch });

describe("writeTransfer", () => {
  it("creates the row with the chains, empty facts and false flags, and applies the patch", async () => {
    const database = createFakeDatabase();
    await write(database, { sourceToken: token, value: 5n });
    expect(database.rows(transfers)).toEqual([
      {
        messageId,
        sourceChainId: 1,
        destinationChainId: 369,
        sourceToken: token,
        destinationToken: null,
        sender: null,
        recipient: null,
        value: 5n,
        deliveredValue: null,
        paidTo: null,
        handler: null,
        deploysCopy: false,
        hasCallback: false,
        sourceIsNative: null,
        sentTimestamp: null,
        deliveryRouter: null,
        routerAmount: null,
        fee: null,
        received: null,
        deliverer: null,
        finalRecipient: null,
        feeSource: null,
      },
    ]);
  });

  it("keeps the facts that the patch does not name and replaces the ones it names, in any order of arrival", async () => {
    const database = createFakeDatabase();
    await write(database, { sourceToken: token, value: 5n });
    await write(database, { paidTo: token, deliveredValue: 4n, value: 6n });
    expect(database.rows(transfers)).toEqual([
      expect.objectContaining({ sourceToken: token, paidTo: token, deliveredValue: 4n, value: 6n }),
    ]);
    expect(database.rows(transfers)).toHaveLength(1);
  });

  it("lets a patch clear a fact with null", async () => {
    const database = createFakeDatabase();
    await write(database, { sourceToken: token });
    await write(database, { sourceToken: null });
    expect(database.rows(transfers)[0]?.sourceToken).toBeNull();
  });
});
