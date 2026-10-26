import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeFeeDirector, type FeeDirector } from "../src/delivery-fee.js";
import {
  assertValidFeeTerms,
  FeeTermsError,
  isKnownFeeRouter,
  protectedAddressesOf,
  type FeeTermsInput,
  type ProtectedChain,
} from "../src/fee-terms.js";

const router = "0x1111111111111111111111111111111111111111";
const otherRouter = "0x2222222222222222222222222222222222222222";
const wrappedNative = "0x3333333333333333333333333333333333333333";
const otherToken = "0x4444444444444444444444444444444444444444";
const person = "0x00000000000000000000000000000000000000aa";

const chains: readonly ProtectedChain[] = [
  { name: "ethereum", bridge: "0x5555555555555555555555555555555555555555", mediator: "0x6666666666666666666666666666666666666666", feeRouter: router },
  { name: "pulsechain", bridge: "0x7777777777777777777777777777777777777777", mediator: "0x8888888888888888888888888888888888888888", feeRouter: otherRouter },
  { name: "no router chain", bridge: "0x9999999999999999999999999999999999999999", mediator: "0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA", feeRouter: null },
];
const context = { router, protectedAddresses: protectedAddressesOf(chains) } as const;
const director = (recipient: string): FeeDirector => ({ recipient: recipient as FeeDirector["recipient"], settings: 8n, limit: 0n, multiplier: 5n });
const word = (address: string) => address.slice(2).toLowerCase().padStart(64, "0");
const directorData = (recipient: string) => `0x${word(recipient)}${"0".repeat(63)}8${"0".repeat(64)}${"0".repeat(63)}5` as const;
const input = (data: FeeTermsInput["data"], overrides: Partial<FeeTermsInput> = {}): FeeTermsInput => ({
  ...context,
  data,
  destinationToken: otherToken,
  destinationWrappedNative: wrappedNative,
  ...overrides,
});

describe("assertValidFeeTerms accepts", () => {
  it("a director that names a person", () => {
    expect(() => assertValidFeeTerms(input(directorData(person)))).not.toThrow();
  });

  it("the legacy receiver for the wrapped native token, in any letter case", () => {
    expect(() => assertValidFeeTerms(input(person, { destinationToken: wrappedNative.toUpperCase().replace("0X", "0x") as `0x${string}` }))).not.toThrow();
  });
});

describe("assertValidFeeTerms refuses what the router would send to its reward address", () => {
  const refuses = (data: FeeTermsInput["data"], message: RegExp, overrides: Partial<FeeTermsInput> = {}) => {
    expect(() => assertValidFeeTerms(input(data, overrides))).toThrow(FeeTermsError);
    expect(() => assertValidFeeTerms(input(data, overrides))).toThrow(message);
  };

  it("the zero address as recipient", () => refuses(directorData("0x0000000000000000000000000000000000000000"), /zero address/));
  it("the router as recipient, in another letter case", () => refuses(directorData(router.toUpperCase().replace("0X", "0x")), /router itself/));
  it("a fee router of either chain", () => {
    refuses(directorData(otherRouter), /fee router of pulsechain/);
    refuses(directorData(router), /fee router of ethereum/, { router: otherRouter });
  });
  it("the mediator and the bridge of either chain", () => {
    for (const chain of chains) {
      refuses(directorData(chain.mediator), new RegExp(`mediator of ${chain.name}`));
      refuses(directorData(chain.bridge), new RegExp(`bridge of ${chain.name}`));
    }
  });
  it("data that is empty, short, between 20 and 128 bytes, or longer than 128 bytes", () => {
    refuses("0x", /not 0 bytes/);
    refuses("0x1234", /not 2 bytes/);
    refuses(`0x${"00".repeat(64)}`, /not 64 bytes/);
    refuses(`${directorData(person)}00`, /not 129 bytes/);
  });
  it("data that is not hex", () => refuses("0xzz", /hex/));
  it("a recipient word with bits above 160", () => refuses(`0x${"f".repeat(24)}${person.slice(2)}${"0".repeat(192)}`, /bits above 160/));
  it("a router that is not an address", () => refuses(directorData(person), /not an address/, { router: "0x12" }));
  it("the legacy receiver for a token that is not the wrapped native token", () => {
    refuses(person, /wrapped native token/);
    refuses(person, /wrapped native token/, { destinationToken: null });
    refuses(person, /wrapped native token/, { destinationWrappedNative: null });
  });
  it("a legacy receiver that is the zero address or a protected address", () => {
    const legacy = { destinationToken: wrappedNative } as const;
    refuses("0x0000000000000000000000000000000000000000", /zero address/, legacy);
    refuses(router, /router itself/, legacy);
    refuses(chains[0]!.mediator, /mediator of ethereum/, legacy);
  });
});

describe("the encoder cannot be bypassed", () => {
  it("refuses a director that the guard refuses", () => {
    expect(() => encodeFeeDirector(director("0x0000000000000000000000000000000000000000"), context)).toThrow(/zero address/);
    expect(() => encodeFeeDirector(director(router), context)).toThrow(/router itself/);
    expect(() => encodeFeeDirector(director(otherRouter), context)).toThrow(/fee router of pulsechain/);
    expect(() => encodeFeeDirector(director(chains[1]!.bridge), context)).toThrow(/bridge of pulsechain/);
  });

  it("encodes a valid director to the same bytes as the Solidity vectors", () => {
    const lines = readFileSync(new URL("./fixtures/delivery-fee-vectors.jsonl", import.meta.url), "utf8").split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(2000);
    for (const line of lines) {
      const vector = JSON.parse(line) as { recipient: `0x${string}`; settings: string; limit: string; multiplier: string; encoded: `0x${string}` };
      const encoded = encodeFeeDirector({ recipient: vector.recipient, settings: BigInt(vector.settings), limit: BigInt(vector.limit), multiplier: BigInt(vector.multiplier) }, context);
      expect(encoded).toBe(vector.encoded);
    }
  }, 30_000);
});

describe("deployment lists", () => {
  it("protects the router, mediator and bridge of each chain, and skips a missing router", () => {
    const labels = protectedAddressesOf(chains).map((entry) => entry.label);
    expect(labels).toHaveLength(8);
    expect(labels).not.toContain("the fee router of no router chain");
  });

  it("knows a fee router of either chain in any letter case, and nothing else", () => {
    expect(isKnownFeeRouter(otherRouter.toUpperCase().replace("0X", "0x") as `0x${string}`, chains)).toBe(true);
    expect(isKnownFeeRouter(router, chains)).toBe(true);
    expect(isKnownFeeRouter(person, chains)).toBe(false);
  });
});
