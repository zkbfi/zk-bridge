import { describe, expect, it, vi } from "vitest";
import { buildTokenRow, mergeTransfer, nativeTokenBehind, readTokenMetadata, type ContractReader } from "../src/index.js";
import { addressOf, hashOf } from "./support/fixtures.js";

const token = addressOf("aa");
const home = addressOf("bb");
const mediator = addressOf("cc");
const readerOf = (answer: (functionName: string) => unknown): ContractReader & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    readContract: vi.fn(async (call) => {
      calls.push(`${call.address}:${call.functionName}`);
      return answer(call.functionName);
    }),
  };
};

describe("readTokenMetadata", () => {
  it("reads the name, the symbol and the decimals from the token", async () => {
    const reader = readerOf((name) => ({ name: "Tether", symbol: "USDT", decimals: 6 })[name as "name"]);
    expect(await readTokenMetadata(reader, token)).toEqual({ name: "Tether", symbol: "USDT", decimals: 6 });
    expect(reader.calls).toEqual([`${token}:name`, `${token}:symbol`, `${token}:decimals`]);
  });

  it("gives null for each view that reverts, and keeps the views that work", async () => {
    const reader = readerOf((name) => {
      if (name === "symbol") return "TKN";
      throw new Error("execution reverted");
    });
    expect(await readTokenMetadata(reader, token)).toEqual({ name: null, symbol: "TKN", decimals: null });
  });
});

describe("nativeTokenBehind", () => {
  it("asks the mediator and answers null for a token that is native on its chain", async () => {
    const reader = readerOf(() => "0x0000000000000000000000000000000000000000");
    expect(await nativeTokenBehind(reader, mediator, token)).toBeNull();
    expect(reader.calls).toEqual([`${mediator}:nativeTokenAddress`]);
  });

  it("answers the native token in lowercase for a bridged copy", async () => {
    const reader = readerOf(() => "0xBBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbB");
    expect(await nativeTokenBehind(reader, mediator, token)).toBe(home);
  });
});

describe("buildTokenRow", () => {
  const hints = { isBridgedCopy: false, homeChainId: 1, homeToken: token } as const;

  it("builds the row of a token that answered, with no registration facts", () => {
    expect(buildTokenRow({ chainId: 1, address: token, metadata: { name: "Tether", symbol: "USDT", decimals: 6 }, hints })).toEqual({
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
    });
  });

  it("assumes 18 decimals and records that the metadata was not read when the token gave none", () => {
    const row = buildTokenRow({ chainId: 1, address: token, metadata: { name: null, symbol: null, decimals: null }, hints });
    expect(row).toMatchObject({ decimals: 18, metadataRead: false, name: null, symbol: null });
  });

  it("keeps the registration facts of a bridged copy", () => {
    const row = buildTokenRow({
      chainId: 369,
      address: token,
      metadata: { name: "Tether", symbol: "USDT", decimals: 6 },
      hints: { isBridgedCopy: true, homeChainId: 1, homeToken: home, registeredTransactionHash: hashOf("ab"), registeredBlockNumber: 55n, registeredTimestamp: 1_700n },
    });
    expect(row).toMatchObject({ isBridgedCopy: true, homeToken: home, registeredTransactionHash: hashOf("ab"), registeredBlockNumber: 55n, registeredTimestamp: 1_700n });
  });
});

describe("mergeTransfer", () => {
  const identity = { messageId: hashOf("11"), sourceChainId: 1, destinationChainId: 369 };

  it("starts a transfer with no facts and adds the patch", () => {
    expect(mergeTransfer({ ...identity, existing: null, patch: { sourceToken: token, value: 5n } })).toEqual({
      ...identity,
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
    });
  });

  it("keeps the facts that the patch does not name, so the two chains can write in either order", () => {
    const first = mergeTransfer({ ...identity, existing: null, patch: { sourceToken: token, value: 5n } });
    const second = mergeTransfer({ ...identity, existing: first, patch: { paidTo: home, deliveredValue: 4n, value: 6n } });
    expect(second).toMatchObject({ sourceToken: token, paidTo: home, deliveredValue: 4n, value: 6n });
  });

  it("lets a patch clear a fact with null", () => {
    const first = mergeTransfer({ ...identity, existing: null, patch: { sourceToken: token } });
    expect(mergeTransfer({ ...identity, existing: first, patch: { sourceToken: null } }).sourceToken).toBeNull();
  });
});
