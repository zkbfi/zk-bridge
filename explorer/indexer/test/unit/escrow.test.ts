import { describe, expect, it } from "vitest";
import { sideOf } from "@zk-bridge/shared";
import { escrow } from "../../ponder.schema";
import { refreshEscrow } from "../../src/lib/escrow";
import { pair } from "../../src/lib/pair";
import { createFakeClient } from "./support/fake-client";
import { createFakeDatabase } from "./support/fake-database";

const token = "0x00000000000000000000000000000000000001aa" as const;
const zero = "0x0000000000000000000000000000000000000000";

const input = (database: ReturnType<typeof createFakeDatabase>, client: ReturnType<typeof createFakeClient>, blockNumber: bigint) => ({
  database: database.handle as never,
  client: client as never,
  chainId: 1,
  token,
  blockNumber,
  timestamp: blockNumber * 12n,
});

describe("refreshEscrow", () => {
  it("stores the balance that the mediator reports, with the block of the event", async () => {
    const database = createFakeDatabase();
    const client = createFakeClient(({ functionName }) => {
      if (functionName === "nativeTokenAddress") return zero;
      return 500n;
    });
    await refreshEscrow(input(database, client, 100n));
    expect(database.rows(escrow)).toEqual([
      { chainId: 1, token, balance: 500n, updatedBlockNumber: 100n, updatedTimestamp: 1_200n },
    ]);
    const mediator = sideOf(pair, 1).contracts.mediator;
    const reads = client.readContract.mock.calls.map(([call]) => [call.functionName, call.address, call.args]);
    expect(reads).toContainEqual(["mediatorBalance", mediator, [token]]);
    expect(reads).not.toContainEqual(["accruedFees", mediator, [token]]);
  });

  it("replaces the stored row on a later event", async () => {
    const database = createFakeDatabase();
    const first = createFakeClient(({ functionName }) => (functionName === "nativeTokenAddress" ? zero : 500n));
    await refreshEscrow(input(database, first, 100n));
    const second = createFakeClient(({ functionName }) => (functionName === "nativeTokenAddress" ? zero : 900n));
    await refreshEscrow(input(database, second, 200n));
    expect(database.rows(escrow)).toEqual([
      { chainId: 1, token, balance: 900n, updatedBlockNumber: 200n, updatedTimestamp: 2_400n },
    ]);
  });

  it("does nothing for a bridged copy, because only a native token has an escrow", async () => {
    const database = createFakeDatabase();
    const client = createFakeClient(() => "0x00000000000000000000000000000000000002bb");
    await refreshEscrow(input(database, client, 100n));
    expect(database.rows(escrow)).toEqual([]);
    expect(client.readContract).toHaveBeenCalledTimes(1);
  });
});
