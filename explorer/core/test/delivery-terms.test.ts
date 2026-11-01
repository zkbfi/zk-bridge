import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  assertValidFeeTerms,
  CALL_GAS_RESERVE,
  DELIVERY_CALL_OFFSET_BYTES,
  DELIVERY_CALL_TARGET_BYTES,
  decodeDeliveryCall,
  decodeFeeDirector,
  encodeFeeDirector,
  EXCLUDE_PRIORITY,
  expectedFee,
  FeeTermsError,
  FIXED_FEE,
  feeModeOf,
  gasPriceBasisOf,
  isKnownDeliveryRouter,
  KNOWN_SETTING_BITS,
  maximumFee,
  MULTIPLIER_OF_TOTAL,
  ROUTER_CALLBACK_GAS_BASE,
  routerCallbackGas,
  worstCaseFee,
  FEE_DIRECTOR_BYTES,
  NATIVE_GAS_OVERHEAD,
  payoutOf,
  protectedAddressesOf,
  readDeliveryTerms,
  requestedPayoutOf,
  SETTING_FLAG_VALUES,
  settingFlagsOf,
  settingsOf,
  TOKEN_GAS_OVERHEAD,
  UNWRAP,
  type DeliveryCall,
  type FeeDirector,
  type FeeTermsContext,
  type FeeTermsInput,
  type ProtectedChain,
} from "../src/delivery-terms.js";

const router = "0x1111111111111111111111111111111111111111";
const otherRouter = "0x2222222222222222222222222222222222222222";
const wrappedNative = "0x3333333333333333333333333333333333333333";
const otherToken = "0x4444444444444444444444444444444444444444";
const person = "0x00000000000000000000000000000000000000aa" as const;
const wei = 10n ** 18n;

const chains: readonly ProtectedChain[] = [
  { name: "ethereum", bridge: "0x5555555555555555555555555555555555555555", mediator: "0x6666666666666666666666666666666666666666", deliveryRouter: router },
  { name: "pulsechain", bridge: "0x7777777777777777777777777777777777777777", mediator: "0x8888888888888888888888888888888888888888", deliveryRouter: otherRouter },
  { name: "no router chain", bridge: "0x9999999999999999999999999999999999999999", mediator: "0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA", deliveryRouter: null },
];
const context: FeeTermsContext = { router, protectedAddresses: protectedAddressesOf(chains), destinationToken: otherToken, destinationWrappedNative: wrappedNative };
const wrappedContext: FeeTermsContext = { ...context, destinationToken: wrappedNative };
const director = (recipient: string, settings = 8n, callGas = 50_000n): FeeDirector => ({ recipient: recipient as FeeDirector["recipient"], settings, limit: 0n, multiplier: 5n, callGas });
const word = (address: string) => address.slice(2).toLowerCase().padStart(64, "0");
const directorData = (recipient: string, settings = 8n) => `0x${word(recipient)}${settings.toString(16).padStart(64, "0")}${"0".repeat(64)}${"0".repeat(63)}5${"0".repeat(64)}` as const;
/** Director data with a call: a callGas word of the given value, then the target and the call data. */
const callDirectorData = (recipient: string, callGas: bigint, tail: string) =>
  `0x${directorData(recipient).slice(2, 2 + 256)}${callGas.toString(16).padStart(64, "0")}${tail}` as const;
const input = (data: FeeTermsInput["data"], overrides: Partial<FeeTermsInput> = {}): FeeTermsInput => ({ ...context, data, ...overrides });

type Constants = Record<string, string>;
const constants = JSON.parse(readFileSync(new URL("./fixtures/delivery-router-constants.json", import.meta.url), "utf8")) as Constants;

describe("the constants of the compiled DeliveryRouter", () => {
  it("has every flag under the same name and with the same value as the contract", () => {
    expect(constants).toMatchObject({ FIXED_FEE: "1", UNWRAP: "2", EXCLUDE_PRIORITY: "4", MULTIPLIER_OF_TOTAL: "8" });
    for (const [name, value] of Object.entries(SETTING_FLAG_VALUES)) expect(value, name).toBe(BigInt(constants[name]!));
    expect(Object.keys(SETTING_FLAG_VALUES).sort()).toEqual(["EXCLUDE_PRIORITY", "FIXED_FEE", "MULTIPLIER_OF_TOTAL", "UNWRAP"]);
  });

  it("has the same gas overheads as the contract", () => {
    expect(TOKEN_GAS_OVERHEAD).toBe(BigInt(constants.TOKEN_GAS_OVERHEAD!));
    expect(NATIVE_GAS_OVERHEAD).toBe(BigInt(constants.NATIVE_GAS_OVERHEAD!));
  });

  it("has the same call gas reserve as the contract", () => {
    expect(constants.CALL_GAS_RESERVE).toBe("10000");
    expect(CALL_GAS_RESERVE).toBe(BigInt(constants.CALL_GAS_RESERVE!));
  });

  it("puts the call data after the director and the 20 byte target", () => {
    expect(DELIVERY_CALL_TARGET_BYTES).toBe(20);
    expect(FEE_DIRECTOR_BYTES).toBe(160);
    expect(DELIVERY_CALL_OFFSET_BYTES).toBe(180);
  });

  it("reads exactly the bits that the contract defines", () => {
    expect(KNOWN_SETTING_BITS).toBe(15n);
  });
});

describe("the settings", () => {
  it("builds the bits of each mode, payout and gas price", () => {
    expect(settingsOf({ mode: "fixed" })).toBe(FIXED_FEE);
    expect(settingsOf({ mode: "share", payout: "native" })).toBe(MULTIPLIER_OF_TOTAL | UNWRAP);
    expect(settingsOf({ mode: "gas" })).toBe(0n);
    expect(settingsOf({ mode: "gas", payout: "native", gasPrice: "base-fee-only" })).toBe(UNWRAP | EXCLUDE_PRIORITY);
  });

  it("sets the base fee bit only for a gas based tip, which is the only one that reads it", () => {
    expect(settingsOf({ mode: "fixed", gasPrice: "base-fee-only" })).toBe(FIXED_FEE);
    expect(settingsOf({ mode: "share", gasPrice: "base-fee-only" })).toBe(MULTIPLIER_OF_TOTAL);
  });

  it("reads the mode, the payout request and the gas price basis back", () => {
    for (const mode of ["fixed", "share", "gas"] as const) {
      for (const payout of ["token", "native"] as const) {
        const settings = settingsOf({ mode, payout, gasPrice: "base-fee-only" });
        expect(feeModeOf(settings)).toBe(mode);
        expect(requestedPayoutOf(settings)).toBe(payout);
      }
    }
    expect(gasPriceBasisOf(EXCLUDE_PRIORITY)).toBe("base-fee-only");
    expect(gasPriceBasisOf(0n)).toBe("transaction");
  });

  it("lists the flags that are set, in bit order", () => {
    expect(settingFlagsOf(0n)).toEqual([]);
    expect(settingFlagsOf(15n)).toEqual(["FIXED_FEE", "UNWRAP", "EXCLUDE_PRIORITY", "MULTIPLIER_OF_TOTAL"]);
    expect(settingFlagsOf(UNWRAP | MULTIPLIER_OF_TOTAL)).toEqual(["UNWRAP", "MULTIPLIER_OF_TOTAL"]);
  });

  it("pays native only for the wrapped native token", () => {
    expect(payoutOf(UNWRAP, true)).toBe("native");
    expect(payoutOf(UNWRAP, false)).toBe("token");
    expect(payoutOf(0n, true)).toBe("token");
  });
});

describe("reading the data as the router does", () => {
  it("reads 20 bytes as the legacy receiver, in lowercase", () => {
    expect(readDeliveryTerms(person.toUpperCase().replace("0X", "0x") as `0x${string}`)).toEqual({ kind: "legacy", receiver: person });
  });
  it("reads 160 bytes as a director", () => {
    expect(readDeliveryTerms(directorData(person))).toEqual({ kind: "director", director: { recipient: getAddress(person), settings: 8n, limit: 0n, multiplier: 5n, callGas: 0n }, call: null });
  });
  it("finds no known shape in a length below 160 that is not 20, or in a dirty recipient word", () => {
    expect(readDeliveryTerms("0x1234")).toEqual({ kind: "unknown", bytes: 2 });
    expect(readDeliveryTerms(`0x${"00".repeat(127)}`)).toEqual({ kind: "unknown", bytes: 127 });
    expect(readDeliveryTerms(`0x${"00".repeat(128)}`)).toEqual({ kind: "unknown", bytes: 128 });
    expect(readDeliveryTerms(`0x${"00".repeat(159)}`)).toEqual({ kind: "unknown", bytes: 159 });
    expect(readDeliveryTerms(`0x${"ff".repeat(12)}${person.slice(2)}${"0".repeat(256)}`)).toEqual({ kind: "unknown", bytes: 160 });
    expect(readDeliveryTerms(`0x${"ff".repeat(12)}${person.slice(2)}${"0".repeat(256)}${"11".repeat(40)}`)).toEqual({ kind: "unknown", bytes: 200 });
  });
  // Changed: the director has five words now, so 160 bytes is a director, 161 to 179 bytes make no call, and 180 bytes or more do.
  it("reads 160, 161 and 179 bytes as a director with no call, and 180 and 250 bytes as a call", () => {
    const director160 = directorData(person);
    const expected = { recipient: getAddress(person), settings: 8n, limit: 0n, multiplier: 5n, callGas: 0n };
    const target = "ab".repeat(20);
    expect(readDeliveryTerms(director160)).toEqual({ kind: "director", director: expected, call: null });
    expect(readDeliveryTerms(`${director160}ff`)).toEqual({ kind: "director", director: expected, call: null });
    expect(readDeliveryTerms(`${director160}${"ff".repeat(19)}`)).toEqual({ kind: "director", director: expected, call: null });
    expect(readDeliveryTerms(`${director160}${target}`)).toEqual({ kind: "director", director: expected, call: { target: `0x${target}`, data: "0x" } });
    expect(readDeliveryTerms(`${director160}${target}${"cd".repeat(52)}`)).toEqual({
      kind: "director",
      director: expected,
      call: { target: `0x${target}`, data: `0x${"cd".repeat(52)}` },
    });
  });
  it("reads the call gas word of a director", () => {
    const target = "ab".repeat(20);
    expect(readDeliveryTerms(callDirectorData(person, 77_000n, target))).toEqual({
      kind: "director",
      director: { recipient: getAddress(person), settings: 8n, limit: 0n, multiplier: 5n, callGas: 77_000n },
      call: { target: `0x${target}`, data: "0x" },
    });
  });
  it("refuses to decode a dirty recipient word", () => {
    expect(() => decodeFeeDirector(`0x${"ff".repeat(12)}${person.slice(2)}${"0".repeat(192)}`)).toThrow(RangeError);
  });
});

type Vector = {
  recipient: `0x${string}`;
  settings: string;
  limit: string;
  multiplier: string;
  callGas: string;
  encoded: `0x${string}`;
  wrappedNative: boolean;
  value: string;
  gasUsed: string;
  baseFee: string;
  priorityFee: string;
  reverts: boolean;
  fee: string;
  toRecipient: string;
};

const vectors = readFileSync(new URL("./fixtures/delivery-fee-vectors.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as Vector);

const directorOf = (vector: Vector): FeeDirector => ({
  recipient: vector.recipient,
  settings: BigInt(vector.settings),
  limit: BigInt(vector.limit),
  multiplier: BigInt(vector.multiplier),
  callGas: BigInt(vector.callGas),
});

const recipient = person;

describe("against vectors printed by the compiled DeliveryRouter", () => {
  it("has vectors, including overflows that revert", () => {
    expect(vectors.length).toBeGreaterThan(2000);
    expect(vectors.some((vector) => vector.reverts)).toBe(true);
    expect(vectors.some((vector) => !vector.reverts && BigInt(vector.fee) > 0n)).toBe(true);
  });

  it("encodes every director as abi.encode does, and decodes it back", () => {
    for (const vector of vectors) {
      const director = directorOf(vector);
      const vectorContext = vector.wrappedNative ? wrappedContext : context;
      if ((director.settings & UNWRAP) !== 0n && !vector.wrappedNative) {
        expect(() => encodeFeeDirector(director, vectorContext), JSON.stringify(vector)).toThrow(FeeTermsError);
      } else {
        expect(encodeFeeDirector(director, vectorContext), JSON.stringify(vector)).toBe(vector.encoded);
      }
      const decoded = decodeFeeDirector(vector.encoded);
      expect(decoded.settings).toBe(director.settings);
      expect(decoded.limit).toBe(director.limit);
      expect(decoded.multiplier).toBe(director.multiplier);
      expect(decoded.callGas).toBe(director.callGas);
      expect(decoded.recipient.toLowerCase()).toBe(director.recipient.toLowerCase());
    }
  }, 30_000);

  it("computes the fee and the rest as feeInfo does, and throws where the router reverts", () => {
    for (const vector of vectors) {
      const run = () =>
        expectedFee(directorOf(vector), {
          value: BigInt(vector.value),
          gasUsed: BigInt(vector.gasUsed),
          baseFeeWei: BigInt(vector.baseFee),
          priorityFeeWei: BigInt(vector.priorityFee),
          payout: vector.wrappedNative && (BigInt(vector.settings) & UNWRAP) !== 0n ? "native" : "token",
        });
      if (vector.reverts) {
        expect(run, JSON.stringify(vector)).toThrow(RangeError);
        continue;
      }
      expect(run(), JSON.stringify(vector)).toEqual({ fee: BigInt(vector.fee), toRecipient: BigInt(vector.toRecipient) });
    }
  });
});

describe("routerCallbackGas", () => {
  it("is the base for a delivery with no call", () => {
    expect(ROUTER_CALLBACK_GAS_BASE).toBe(300_000n);
    expect(routerCallbackGas({})).toBe(300_000n);
    expect(routerCallbackGas({ callGas: 0n })).toBe(300_000n);
  });
  it("adds the call gas, a 63rd of it rounded up, and the reserve for a call", () => {
    expect(routerCallbackGas({ callGas: 63_000n })).toBe(300_000n + 63_000n + 1_000n + CALL_GAS_RESERVE);
    expect(routerCallbackGas({ callGas: 1n })).toBe(300_000n + 1n + 1n + CALL_GAS_RESERVE);
    expect(routerCallbackGas({ callGas: 64n })).toBe(300_000n + 64n + 2n + CALL_GAS_RESERVE);
  });
});

describe("worstCaseFee", () => {
  const base = { recipient, limit: 10n ** 30n, multiplier: wei, callGas: 40_000n };
  const gasInput = { value: 10n ** 30n, deliveryGas: 200_000n, gasPrice: 10n, payout: "token", withCall: false } as const;
  it("takes the limit in fixed mode, never above the value", () => {
    expect(worstCaseFee({ ...base, settings: FIXED_FEE, limit: 500n }, { ...gasInput, value: 1_000n })).toBe(500n);
    expect(worstCaseFee({ ...base, settings: FIXED_FEE, limit: 500n }, { ...gasInput, value: 100n })).toBe(100n);
  });
  it("takes the share of the value in share mode, never above the value", () => {
    expect(worstCaseFee({ ...base, settings: MULTIPLIER_OF_TOTAL, multiplier: wei / 100n }, { ...gasInput, value: 1_000n })).toBe(10n);
    expect(worstCaseFee({ ...base, settings: MULTIPLIER_OF_TOTAL, multiplier: 2n * wei }, { ...gasInput, value: 1_000n })).toBe(1_000n);
  });
  it("counts the delivery gas, the overhead and, with a call, the call gas in gas mode", () => {
    expect(worstCaseFee({ ...base, settings: 0n }, gasInput)).toBe((200_000n + TOKEN_GAS_OVERHEAD) * 10n);
    expect(worstCaseFee({ ...base, settings: 0n }, { ...gasInput, withCall: true })).toBe((200_000n + 40_000n + TOKEN_GAS_OVERHEAD) * 10n);
    expect(worstCaseFee({ ...base, settings: UNWRAP }, { ...gasInput, payout: "native" })).toBe((200_000n + NATIVE_GAS_OVERHEAD) * 10n);
  });
  it("is capped by the limit and by the value in gas mode", () => {
    expect(worstCaseFee({ ...base, settings: 0n, limit: 1_000n }, gasInput)).toBe(1_000n);
    expect(worstCaseFee({ ...base, settings: 0n }, { ...gasInput, value: 500n })).toBe(500n);
  });
  it("throws where the router would overflow", () => {
    expect(() => worstCaseFee({ ...base, settings: 0n, multiplier: 2n ** 255n }, { ...gasInput, gasPrice: 4n })).toThrow(RangeError);
    expect(() => worstCaseFee({ ...base, settings: 0n }, { ...gasInput, deliveryGas: 2n ** 256n - 1n })).toThrow(RangeError);
  });
});

describe("decodeDeliveryCall", () => {
  const target = "0x1234567890abcdef1234567890abcdef12345678";
  it("returns null below 180 bytes", () => {
    expect(decodeDeliveryCall(directorData(person))).toBeNull();
    expect(decodeDeliveryCall(`${directorData(person)}${target.slice(2, 40)}`)).toBeNull();
    expect(decodeDeliveryCall("0x")).toBeNull();
  });
  it("reads the target and the call data exactly", () => {
    expect(decodeDeliveryCall(`${directorData(person)}${target.slice(2)}`)).toEqual({ target, data: "0x" });
    expect(decodeDeliveryCall(`${directorData(person)}${target.slice(2)}a9059cbb`)).toEqual({ target, data: "0xa9059cbb" });
  });
});

type CallVector = { recipient: `0x${string}`; settings: string; limit: string; multiplier: string; callGas: string; target: `0x${string}`; callData: `0x${string}`; encoded: `0x${string}` };

const callVectors = readFileSync(new URL("./fixtures/delivery-call-vectors.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as CallVector);

describe("against call vectors printed by the compiled generator", () => {
  it("has a vector for each call data length of 0, 1, 4, 36 and 200 bytes", () => {
    expect(callVectors.map((vector) => (vector.callData.length - 2) / 2)).toEqual([0, 1, 4, 36, 200]);
  });

  it("encodes a director with a call as abi.encodePacked does, and decodes it back", () => {
    for (const vector of callVectors) {
      const vectorDirector: FeeDirector = { recipient: vector.recipient, settings: BigInt(vector.settings), limit: BigInt(vector.limit), multiplier: BigInt(vector.multiplier), callGas: BigInt(vector.callGas) };
      const call: DeliveryCall = { target: vector.target, data: vector.callData };
      const encoded = vector.encoded;
      expect(encodeFeeDirector(vectorDirector, context, call), JSON.stringify(vector)).toBe(encoded.toLowerCase());
      expect(decodeDeliveryCall(encoded)).toEqual({ target: vector.target.toLowerCase(), data: vector.callData });
      expect(readDeliveryTerms(encoded)).toEqual({
        kind: "director",
        director: vectorDirector,
        call: { target: vector.target.toLowerCase(), data: vector.callData },
      });
    }
  });
});

describe("the encoding", () => {
  it("is five words with no offset", () => {
    const encoded = encodeFeeDirector({ recipient, settings: 8n, limit: 0n, multiplier: 5n, callGas: 0n }, context);
    expect((encoded.length - 2) / 2).toBe(160);
  });

  it("refuses data below 160 bytes, and reads the first 160 bytes of longer data", () => {
    expect(() => decodeFeeDirector("0x1234")).toThrow(RangeError);
    expect(() => decodeFeeDirector(`0x${"00".repeat(128)}`)).toThrow(RangeError);
    expect(decodeFeeDirector(`${directorData(person)}${"ab".repeat(30)}`)).toEqual({ recipient: getAddress(person), settings: 8n, limit: 0n, multiplier: 5n, callGas: 0n });
  });
});

describe("the fee modes", () => {
  it("lets fixed win over share, as the router does", () => {
    expect(feeModeOf(FIXED_FEE | MULTIPLIER_OF_TOTAL)).toBe("fixed");
    expect(feeModeOf(MULTIPLIER_OF_TOTAL)).toBe("share");
    expect(feeModeOf(0n)).toBe("gas");
    expect(feeModeOf(UNWRAP | EXCLUDE_PRIORITY)).toBe("gas");
  });

  it("takes the limit in fixed mode, never above the value", () => {
    const director = { recipient, settings: FIXED_FEE, limit: 500n, multiplier: 0n, callGas: 0n };
    expect(expectedFee(director, { value: 1_000n, gasUsed: 0n, baseFeeWei: 0n }).fee).toBe(500n);
    expect(expectedFee(director, { value: 100n, gasUsed: 0n, baseFeeWei: 0n })).toEqual({ fee: 100n, toRecipient: 0n });
  });

  it("prices gas at the base fee only when the flag is set", () => {
    const base = { recipient, limit: 10n ** 30n, multiplier: wei, callGas: 0n };
    const input = { value: 10n ** 30n, gasUsed: 0n, baseFeeWei: 7n, priorityFeeWei: 3n };
    expect(expectedFee({ ...base, settings: 0n }, input).fee).toBe(100_000n * 10n);
    expect(expectedFee({ ...base, settings: EXCLUDE_PRIORITY }, input).fee).toBe(100_000n * 7n);
    expect(expectedFee({ ...base, settings: 0n }, { ...input, payout: "native" }).fee).toBe(NATIVE_GAS_OVERHEAD * 10n);
  });

  it("reports the maximum: the limit for gas, the amount for the others", () => {
    expect(maximumFee({ recipient, settings: 0n, limit: 500n, multiplier: wei, callGas: 0n }, 1_000n)).toBe(500n);
    expect(maximumFee({ recipient, settings: 0n, limit: 5_000n, multiplier: wei, callGas: 0n }, 1_000n)).toBe(1_000n);
    expect(maximumFee({ recipient, settings: MULTIPLIER_OF_TOTAL, limit: 0n, multiplier: wei / 100n, callGas: 0n }, 1_000n)).toBe(10n);
  });
});

describe("assertValidFeeTerms accepts", () => {
  it("a director that names a person", () => {
    expect(() => assertValidFeeTerms(input(directorData(person)))).not.toThrow();
  });

  it("a call to a plain target, with and without call data", () => {
    const target = "ab".repeat(20);
    expect(() => assertValidFeeTerms(input(callDirectorData(person, 50_000n, target)))).not.toThrow();
    expect(() => assertValidFeeTerms(input(callDirectorData(person, 50_000n, `${target}a9059cbb`)))).not.toThrow();
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
  it("a delivery router of either chain", () => {
    refuses(directorData(otherRouter), /delivery router of pulsechain/);
    refuses(directorData(router), /delivery router of ethereum/, { router: otherRouter });
  });
  it("the mediator and the bridge of either chain", () => {
    for (const chain of chains) {
      refuses(directorData(chain.mediator), new RegExp(`mediator of ${chain.name}`));
      refuses(directorData(chain.bridge), new RegExp(`bridge of ${chain.name}`));
    }
  });
  it("data that is empty, short, or between 20 and 160 bytes (the four word director of before too)", () => {
    refuses(`0x${"00".repeat(128)}`, /not 128 bytes/);
    refuses("0x", /not 0 bytes/);
    refuses("0x1234", /not 2 bytes/);
    refuses(`0x${"00".repeat(64)}`, /not 64 bytes/);
  });
  it("161 to 179 bytes, and says that the target needs 20 bytes", () => {
    refuses(`${directorData(person)}00`, /161 bytes.*20 byte target/);
    refuses(`${directorData(person)}${"00".repeat(19)}`, /179 bytes.*20 byte target/);
  });
  it("a call with no call gas", () => {
    refuses(callDirectorData(person, 0n, "ab".repeat(20)), /call has no gas/);
  });
  it("a call to the zero address, the router, a mediator, a bridge or a delivery router", () => {
    const calling = (target: string) => callDirectorData(person, 50_000n, `${target.slice(2).toLowerCase()}a9059cbb`);
    refuses(calling("0x0000000000000000000000000000000000000000"), /target of the call is the zero address/);
    refuses(calling(router.toUpperCase().replace("0X", "0x")), /target of the call is the router itself/);
    refuses(calling(chains[0]!.mediator), /target of the call is the mediator of ethereum/);
    refuses(calling(chains[1]!.bridge), /target of the call is the bridge of pulsechain/);
    refuses(calling(otherRouter), /target of the call is the delivery router of pulsechain/);
  });
  it("a call on the legacy form, which has no room for a target", () => {
    refuses(`0x${person.slice(2)}${"ab".repeat(20)}a9059cbb`, /not 44 bytes/, { destinationToken: wrappedNative });
  });
  it("data that is not hex", () => refuses("0xzz", /hex/));
  it("a recipient word with bits above 160", () => refuses(`0x${"f".repeat(24)}${person.slice(2)}${"0".repeat(256)}`, /bits above 160/));
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
  it("refuses a call that the guard refuses", () => {
    const zero = "0x0000000000000000000000000000000000000000";
    expect(() => encodeFeeDirector(director(person), context, { target: zero, data: "0x" })).toThrow(/target of the call is the zero address/);
    expect(() => encodeFeeDirector(director(person), context, { target: router, data: "0x" })).toThrow(/router itself/);
    expect(() => encodeFeeDirector(director(person), context, { target: chains[0]!.mediator as `0x${string}`, data: "0x" })).toThrow(/mediator of ethereum/);
    expect(() => encodeFeeDirector(director(person), context, { target: "0xabababababababababababababababababababab", data: "0xabc" })).toThrow(/hex/);
    expect(() => encodeFeeDirector(director(person, 8n, 0n), context, { target: "0xabababababababababababababababababababab", data: "0x" })).toThrow(/call has no gas/);
  });

  it("refuses a director that the guard refuses", () => {
    expect(() => encodeFeeDirector(director("0x0000000000000000000000000000000000000000"), context)).toThrow(/zero address/);
    expect(() => encodeFeeDirector(director(router), context)).toThrow(/router itself/);
    expect(() => encodeFeeDirector(director(otherRouter), context)).toThrow(/delivery router of pulsechain/);
    expect(() => encodeFeeDirector(director(chains[1]!.bridge), context)).toThrow(/bridge of pulsechain/);
  });
});

describe("deployment lists", () => {
  it("protects the router, mediator and bridge of each chain, and skips a missing router", () => {
    const labels = protectedAddressesOf(chains).map((entry) => entry.label);
    expect(labels).toHaveLength(8);
    expect(labels).not.toContain("the delivery router of no router chain");
  });

  it("knows a delivery router of either chain in any letter case, and nothing else", () => {
    expect(isKnownDeliveryRouter(otherRouter.toUpperCase().replace("0X", "0x") as `0x${string}`, chains)).toBe(true);
    expect(isKnownDeliveryRouter(router, chains)).toBe(true);
    expect(isKnownDeliveryRouter(person, chains)).toBe(false);
  });
});

describe("the unwrap flag and the settings bits", () => {
  const refuses = (data: FeeTermsInput["data"], message: RegExp, overrides: Partial<FeeTermsInput> = {}) =>
    expect(() => assertValidFeeTerms(input(data, overrides))).toThrow(message);

  it("accepts the unwrap flag for the wrapped native token only", () => {
    expect(() => assertValidFeeTerms(input(directorData(person, UNWRAP | 8n), { destinationToken: wrappedNative }))).not.toThrow();
    refuses(directorData(person, UNWRAP | 8n), /unwrap/);
    refuses(directorData(person, UNWRAP), /unwrap/, { destinationToken: null });
    refuses(directorData(person, UNWRAP), /unwrap/, { destinationToken: wrappedNative, destinationWrappedNative: null });
  });

  it("refuses the unwrap flag of an encoded director for any other token, and encodes it for the wrapped native token", () => {
    expect(() => encodeFeeDirector(director(person, UNWRAP), context)).toThrow(FeeTermsError);
    expect(() => encodeFeeDirector(director(person, UNWRAP), wrappedContext)).not.toThrow();
  });

  it("refuses the base fee only flag for a chain that reports no base fee", () => {
    refuses(directorData(person, EXCLUDE_PRIORITY), /reports no base fee/, { destinationBaseFee: "none" });
    expect(() => assertValidFeeTerms(input(directorData(person, EXCLUDE_PRIORITY), { destinationBaseFee: "reported" }))).not.toThrow();
    expect(() => assertValidFeeTerms(input(directorData(person, EXCLUDE_PRIORITY)))).not.toThrow();
    expect(() => assertValidFeeTerms(input(directorData(person, FIXED_FEE), { destinationBaseFee: "none" }))).not.toThrow();
  });

  it("refuses bits that the router does not read, and accepts every combination of the four that it reads", () => {
    refuses(directorData(person, 16n), /bits that the router does not read/);
    for (let settings = 0n; settings < 16n; settings += 1n) {
      expect(() => assertValidFeeTerms(input(directorData(person, settings), { destinationToken: wrappedNative })), String(settings)).not.toThrow();
    }
  });
});

