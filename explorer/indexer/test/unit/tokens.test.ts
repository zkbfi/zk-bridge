import { describe, expect, it } from "vitest";
import { sideOf } from "@zk-bridge/shared";
import { tokens } from "../../ponder.schema";
import { pair } from "../../src/lib/pair";
import { ensureToken, nativeTokenBehind, readTokenMetadata } from "../../src/lib/tokens";
import { createFakeClient } from "./support/fake-client";
import { createFakeDatabase } from "./support/fake-database";

const token = "0x00000000000000000000000000000000000001aa" as const;
const home = "0x00000000000000000000000000000000000002bb" as const;
const zero = "0x0000000000000000000000000000000000000000";
const asClient = (client: ReturnType<typeof createFakeClient>) => client as never;

describe("readTokenMetadata", () => {
  it("reads the name, the symbol and the decimals from the token", async () => {
    const client = createFakeClient(({ functionName }) => ({ name: "Tether", symbol: "USDT", decimals: 6 })[functionName as "name"]);
    expect(await readTokenMetadata(asClient(client), token)).toEqual({ name: "Tether", symbol: "USDT", decimals: 6 });
    expect(client.readContract.mock.calls.map(([call]) => [call.address, call.functionName])).toEqual([
      [token, "name"],
      [token, "symbol"],
      [token, "decimals"],
    ]);
  });

  it("gives null for each view that reverts, and keeps the views that work", async () => {
    const client = createFakeClient(({ functionName }) => {
      if (functionName === "symbol") return "TKN";
      throw new Error("execution reverted");
    });
    expect(await readTokenMetadata(asClient(client), token)).toEqual({ name: null, symbol: "TKN", decimals: null });
  });
});

describe("ensureToken", () => {
  const hints = { isBridgedCopy: false, homeChainId: 1, homeToken: token } as const;
  const stored = {
    chainId: 1,
    address: token,
    name: "Tether",
    symbol: "USDT",
    decimals: 6,
    metadataRead: true,
    isBridgedCopy: false,
    homeChainId: 1,
    homeToken: token,
    registeredTransactionHash: null,
    registeredBlockNumber: null,
    registeredTimestamp: null,
  };

  it("stores a new token with the metadata of the chain and the hints of the caller", async () => {
    const database = createFakeDatabase();
    const client = createFakeClient(({ functionName }) => ({ name: "Tether", symbol: "USDT", decimals: 6 })[functionName as "name"]);
    await ensureToken({ database: database.handle as never, client: asClient(client), chainId: 1, address: token, hints });
    expect(database.rows(tokens)).toEqual([stored]);
  });

  it("stores the registration facts of a bridged copy", async () => {
    const database = createFakeDatabase();
    const client = createFakeClient(({ functionName }) => ({ name: "Tether", symbol: "USDT", decimals: 6 })[functionName as "name"]);
    await ensureToken({
      database: database.handle as never,
      client: asClient(client),
      chainId: 369,
      address: token,
      hints: {
        isBridgedCopy: true,
        homeChainId: 1,
        homeToken: home,
        registeredTransactionHash: `0x${"ab".repeat(32)}`,
        registeredBlockNumber: 55n,
        registeredTimestamp: 1_700n,
      },
    });
    expect(database.rows(tokens)).toEqual([
      {
        ...stored,
        chainId: 369,
        isBridgedCopy: true,
        homeToken: home,
        registeredTransactionHash: `0x${"ab".repeat(32)}`,
        registeredBlockNumber: 55n,
        registeredTimestamp: 1_700n,
      },
    ]);
  });

  it("assumes 18 decimals and records that the metadata was not read when the token does not answer", async () => {
    const database = createFakeDatabase();
    const client = createFakeClient(() => {
      throw new Error("execution reverted");
    });
    await ensureToken({ database: database.handle as never, client: asClient(client), chainId: 1, address: token, hints });
    expect(database.rows(tokens)).toEqual([{ ...stored, name: null, symbol: null, decimals: 18, metadataRead: false }]);
  });

  it("leaves a stored token alone and reads nothing from the chain", async () => {
    const database = createFakeDatabase();
    database.seed(tokens, { ...stored, name: "Old name" });
    const client = createFakeClient(() => "new");
    await ensureToken({ database: database.handle as never, client: asClient(client), chainId: 1, address: token, hints });
    expect(client.readContract).not.toHaveBeenCalled();
    expect(database.rows(tokens)).toEqual([{ ...stored, name: "Old name" }]);
    expect(database.writes).toEqual([]);
  });
});

describe("nativeTokenBehind", () => {
  it("asks the mediator of the chain and answers null for a token that is native there", async () => {
    const client = createFakeClient(() => zero);
    expect(await nativeTokenBehind(asClient(client), 369, token)).toBeNull();
    expect(client.readContract).toHaveBeenCalledWith({
      abi: expect.anything(),
      address: sideOf(pair, 369).contracts.mediator,
      functionName: "nativeTokenAddress",
      args: [token],
    });
  });

  it("answers the native token in lowercase for a bridged copy", async () => {
    const client = createFakeClient(() => "0x00000000000000000000000000000000000002BB");
    expect(await nativeTokenBehind(asClient(client), 1, token)).toBe(home);
  });
});
