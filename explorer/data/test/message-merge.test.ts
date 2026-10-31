import { describe, expect, it } from "vitest";
import { mergeMessage, type MessageRow } from "../src/message-merge.js";

const id = `0x${"ab".repeat(32)}` as const;
const base = { messageId: id, sourceChainId: 1, destinationChainId: 369, finalitySeconds: 768 };
const send: Partial<MessageRow> = {
  kind: "token",
  sender: "0x1111111111111111111111111111111111111111",
  sentTransactionHash: `0x${"cd".repeat(32)}`,
  sentBlockNumber: 100n,
  sentTimestamp: 1_000n,
};
const delivery: Partial<MessageRow> = {
  deliveredTransactionHash: `0x${"ef".repeat(32)}`,
  deliveredBlockNumber: 55n,
  deliveredTimestamp: 2_000n,
  deliveredSuccess: true,
};

const merge = (existing: MessageRow | null, patch: Partial<MessageRow>, latest: bigint | null = null) =>
  mergeMessage({ ...base, existing, patch, latestSourceTimestamp: latest });

describe("mergeMessage", () => {
  it("starts a row from a send and derives sent", () => {
    const row = merge(null, send, 1_000n);
    expect(row.status).toBe("sent");
    expect(row.direction).toBe("1>369");
    expect(row.kind).toBe("token");
    expect(row.deliveredSuccess).toBeNull();
  });

  it("derives waiting_for_finality once the source clock passes the window", () => {
    const row = merge(null, send, 1_000n + 768n);
    expect(row.status).toBe("waiting_for_finality");
  });

  it("derives covered when a stored head covers it", () => {
    const row = merge(merge(null, send, 1_000n), { coveredByHeadSlot: 77n, coveredAtTimestamp: 1_500n });
    expect(row.status).toBe("covered");
  });

  it("gives the same row whether the delivery or the send arrives first", () => {
    const sendFirst = merge(merge(null, send, 1_000n), delivery);
    const deliveryFirst = merge(merge(null, delivery), send, 1_000n);
    expect(deliveryFirst).toEqual(sendFirst);
    expect(sendFirst.status).toBe("delivered");
    expect(sendFirst.sentBlockNumber).toBe(100n);
    expect(sendFirst.deliveredBlockNumber).toBe(55n);
  });

  it("a delivery with no send yet is still delivered", () => {
    const row = merge(null, delivery);
    expect(row.status).toBe("delivered");
    expect(row.sentTimestamp).toBeNull();
  });

  it("reports a reverted call as failed_call even when a failed release is recorded", () => {
    const row = merge(merge(null, send, 1_000n), { ...delivery, deliveredSuccess: false, releaseFailed: true });
    expect(row.status).toBe("failed_call");
  });

  it("turns a delivered release into release_failed, and nothing brings it back", () => {
    const delivered = merge(merge(null, send, 1_000n), delivery);
    const failed = merge(delivered, { releaseFailed: true });
    expect(failed.status).toBe("release_failed");
    expect(merge(failed, { callbackFailed: true }).status).toBe("release_failed");
  });

  it("lets a patch clear a value with null", () => {
    const covered = merge(merge(null, send, 1_000n), { coveredByHeadSlot: 5n });
    expect(merge(covered, { coveredByHeadSlot: null }).coveredByHeadSlot).toBeNull();
  });
});
