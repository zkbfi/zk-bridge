import { stringToHex, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { checkRequestedGasLimit, messageKindOfRelay, readRelayGasFacts, readRelayMessageKind } from "../src/gas-limit.js";
import type { ContractReader } from "../src/token-facts.js";

const mediator = "0x00000000000000000000000000000000000000a1" as Address;
const token = "0x00000000000000000000000000000000000000b2" as Address;
const other = "0x00000000000000000000000000000000000000c3" as Address;

type Chain = {
  native?: Address;
  acknowledged?: boolean;
  /** Answers by `functionName` and whether the call asked for a string or a word. */
  text?: Record<string, string>;
  words?: Record<string, `0x${string}`>;
};

/** A reader that answers like the mediator and a token, and reverts for what the chain does not have. */
const readerOf = (chain: Chain): ContractReader => ({
  async readContract(call) {
    if (call.functionName === "nativeTokenAddress") return chain.native ?? "0x0000000000000000000000000000000000000000";
    if (call.functionName === "isBridgedTokenDeployAcknowledged") return chain.acknowledged ?? false;
    const outputType = (call.abi as readonly { outputs?: readonly { type: string }[] }[])[0]?.outputs?.[0]?.type;
    const answer = outputType === "bytes32" ? chain.words?.[call.functionName] : chain.text?.[call.functionName];
    if (answer === undefined) throw new Error("reverted");
    return answer;
  },
});

const longText = "a".repeat(250);

describe("the kind of the message of a relay", () => {
  it("a copy token uses the release minimum", async () => {
    const kind = await readRelayMessageKind(readerOf({ native: other }), { mediator, token, withCall: false });
    expect(kind).toEqual({ kind: "token-release", withCall: false });
    expect(checkRequestedGasLimit({ kind, requested: 249_999n })).toMatchObject({ ok: false, minimum: 250_000n });
  });

  it("a native token that the other chain proved uses the release minimum, and a call adds the callback", async () => {
    const facts = await readRelayGasFacts(readerOf({ acknowledged: true }), { mediator, token });
    expect(facts).toEqual({ kind: "acknowledged" });
    expect(messageKindOfRelay(facts, { withCall: true })).toEqual({ kind: "token-release", withCall: true });
  });

  it("a native token with no proof yet needs the deploy minimum, so a request between the two is refused", async () => {
    const reader = readerOf({ text: { name: "Token", symbol: "TKN" } });
    const kind = await readRelayMessageKind(reader, { mediator, token, withCall: false });
    expect(kind).toEqual({ kind: "token-deploy", withCall: false, nameAndSymbolBytes: 8 });
    expect(checkRequestedGasLimit({ kind, requested: 300_000n })).toMatchObject({ ok: false, reason: "below-minimum", minimum: 2_000_000n });
  });

  it("the same token passes after the other chain proved the copy", async () => {
    const before = await readRelayMessageKind(readerOf({ text: { name: "Token", symbol: "TKN" } }), { mediator, token, withCall: false });
    const after = await readRelayMessageKind(readerOf({ acknowledged: true, text: { name: "Token", symbol: "TKN" } }), { mediator, token, withCall: false });
    expect(checkRequestedGasLimit({ kind: before, requested: 300_000n }).ok).toBe(false);
    expect(checkRequestedGasLimit({ kind: after, requested: 300_000n })).toEqual({ ok: true, gasLimit: 300_000n });
  });

  it("a name and a symbol of 500 bytes give the minimum of 2100000", async () => {
    const kind = await readRelayMessageKind(readerOf({ text: { name: longText, symbol: longText } }), { mediator, token, withCall: false });
    expect(kind).toMatchObject({ kind: "token-deploy", nameAndSymbolBytes: 500 });
    expect(checkRequestedGasLimit({ kind, requested: 2_000_000n })).toMatchObject({ ok: false, minimum: 2_100_000n });
    expect(checkRequestedGasLimit({ kind, requested: 2_100_000n }).ok).toBe(true);
  });

  it("counts bytes and not characters", async () => {
    const kind = await readRelayMessageKind(readerOf({ text: { name: "é", symbol: "€" } }), { mediator, token, withCall: false });
    expect(kind).toMatchObject({ nameAndSymbolBytes: 5 });
  });

  it("reads a name that is a bytes32 up to its first zero byte, and the upper case views", async () => {
    const word = (text: string): `0x${string}` => stringToHex(text, { size: 32 });
    const asWord = await readRelayGasFacts(readerOf({ words: { name: word("Maker"), symbol: word("MKR") } }), { mediator, token });
    expect(asWord).toEqual({ kind: "unacknowledged", nameAndSymbolBytes: 8 });
    const upper = await readRelayGasFacts(readerOf({ text: { NAME: "Old", SYMBOL: "OLD" } }), { mediator, token });
    expect(upper).toEqual({ kind: "unacknowledged", nameAndSymbolBytes: 6 });
    const fullWord = await readRelayGasFacts(readerOf({ words: { name: stringToHex("n".repeat(32)), symbol: word("S") } }), { mediator, token });
    expect(fullWord).toEqual({ kind: "unacknowledged", nameAndSymbolBytes: 33 });
  });

  it("a token with no readable name or symbol counts zero bytes", async () => {
    expect(await readRelayGasFacts(readerOf({}), { mediator, token })).toEqual({ kind: "unacknowledged", nameAndSymbolBytes: 0 });
  });

  it("ignores an answer that is not text", async () => {
    const reader: ContractReader = {
      async readContract(call) {
        if (call.functionName === "nativeTokenAddress") return "0x0000000000000000000000000000000000000000";
        if (call.functionName === "isBridgedTokenDeployAcknowledged") return "no";
        return 7n;
      },
    };
    expect(await readRelayGasFacts(reader, { mediator, token })).toEqual({ kind: "unacknowledged", nameAndSymbolBytes: 0 });
  });
});
