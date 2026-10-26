import { encodeAbiParameters, keccak256, stringToBytes, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  PROOF_BYTES,
  PROOF_MESSAGE_BYTES,
  PUBLIC_VALUES_BYTES,
  ProofMessageError,
  decodeLightClientOutput,
  decodeProofMessage,
  encodeProofMessage,
  proofCategory,
  proofCategoryName,
  tryDecodeProofMessage,
  type ProofMessage,
} from "../src/index.js";

const word = (seed: number): Hex => `0x${seed.toString(16).padStart(2, "0").repeat(32)}`;

/** Public values with the field order of `BeaconLightClient.LightClientOutput`. */
const publicValuesFor = (startSlot: bigint, startRoot: Hex, newSlot: bigint, newRoot: Hex): Hex =>
  encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [word(1), startRoot, startSlot, word(3), word(4), newRoot, newSlot, word(5), 123n, word(6), word(7)],
  );

const sample = (overrides: Partial<ProofMessage> = {}): ProofMessage => {
  const startRoot = word(0xa1);
  const newRoot = word(0xb2);
  return {
    version: 1,
    pair: "eth-pls",
    direction: "first-to-second",
    programKey: word(0x99),
    startSlot: 10_862_664n,
    startRoot,
    newSlot: 10_862_670n,
    newRoot,
    publicValues: publicValuesFor(10_862_664n, startRoot, 10_862_670n, newRoot),
    proof: `0x${"ab".repeat(PROOF_BYTES)}`,
    ...overrides,
  };
};

describe("proof message codec", () => {
  it("is 823 bytes: the size that msgboard difficulty and the size limit are computed from", () => {
    expect(PUBLIC_VALUES_BYTES).toBe(352);
    expect(PROOF_BYTES).toBe(356);
    expect(PROOF_MESSAGE_BYTES).toBe(823);
    expect((encodeProofMessage(sample()).length - 2) / 2).toBe(823);
  });

  it("round trips every field, in both directions", () => {
    for (const direction of ["first-to-second", "second-to-first"] as const) {
      const message = sample({ direction });
      expect(decodeProofMessage(encodeProofMessage(message))).toEqual(message);
    }
  });

  it("writes the header at the documented offsets", () => {
    const hex = encodeProofMessage(sample({ direction: "second-to-first" })).slice(2);
    const at = (offset: number, size: number): string => hex.slice(offset * 2, (offset + size) * 2);
    expect(at(0, 3)).toBe("010101"); // version 1, pair code 1, direction 1
    expect(at(3, 32)).toBe("99".repeat(32));
    expect(BigInt(`0x${at(35, 8)}`)).toBe(10_862_664n);
    expect(at(43, 32)).toBe("a1".repeat(32));
    expect(BigInt(`0x${at(75, 8)}`)).toBe(10_862_670n);
    expect(at(83, 32)).toBe("b2".repeat(32));
    expect(at(115, 352)).toBe(sample().publicValues.slice(2));
    expect(at(467, 356)).toBe("ab".repeat(356));
  });

  it("rejects truncated input", () => {
    const encoded = encodeProofMessage(sample());
    for (const cut of [0, 1, 3, 100, PROOF_MESSAGE_BYTES - 1]) {
      const truncated: Hex = `0x${encoded.slice(2, 2 + cut * 2)}`;
      const result = tryDecodeProofMessage(cut === 0 ? "0x" : truncated);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("truncated");
    }
  });

  it("rejects trailing bytes", () => {
    const result = tryDecodeProofMessage(`${encodeProofMessage(sample())}00`);
    expect(result).toMatchObject({ ok: false, reason: "trailing-bytes" });
  });

  it("rejects another version, even when the length is right", () => {
    const encoded = encodeProofMessage(sample());
    const changed: Hex = `0x02${encoded.slice(4)}`;
    expect(tryDecodeProofMessage(changed)).toMatchObject({ ok: false, reason: "wrong-version" });
  });

  it("rejects an unknown pair and an unknown direction", () => {
    const encoded = encodeProofMessage(sample());
    expect(tryDecodeProofMessage(`0x0109${encoded.slice(6)}`)).toMatchObject({ ok: false, reason: "unknown-pair" });
    expect(tryDecodeProofMessage(`0x010105${encoded.slice(8)}`)).toMatchObject({ ok: false, reason: "unknown-direction" });
  });

  it("rejects text that is not hex", () => {
    expect(tryDecodeProofMessage("not hex" as Hex)).toMatchObject({ ok: false, reason: "not-hex" });
  });

  it("refuses a header that disagrees with the public values, so a header cannot hide another proof", () => {
    const lying = sample({ newSlot: 10_862_671n });
    expect(() => encodeProofMessage(lying)).toThrow(ProofMessageError);
    const encoded = encodeProofMessage(sample());
    // Change the new slot in the header only: byte offset 75, last byte of the eight.
    const hex = encoded.slice(2);
    const changed: Hex = `0x${hex.slice(0, 82 * 2)}ff${hex.slice(83 * 2)}`;
    expect(tryDecodeProofMessage(changed)).toMatchObject({ ok: false, reason: "inconsistent-public-values" });
  });

  it("refuses fields of the wrong size", () => {
    expect(() => encodeProofMessage(sample({ proof: "0xabcd" }))).toThrow(/proof must be 356 bytes/);
    expect(() => encodeProofMessage(sample({ programKey: "0x01" }))).toThrow(/program key/);
    expect(() => encodeProofMessage(sample({ pair: "unknown" }))).toThrow(/no code/);
  });

  it("reads the public values as the contract struct", () => {
    const output = decodeLightClientOutput(sample().publicValues);
    expect(output.previousHeadSlot).toBe(10_862_664n);
    expect(output.newHeadSlot).toBe(10_862_670n);
    expect(output.executionBlockNumber).toBe(123n);
  });
});

describe("category names", () => {
  it("names the pair and the direction, as docs/bots.md says", () => {
    expect(proofCategoryName("eth-pls", "first-to-second")).toBe(
      "zk-bridge/eth-pls/ethereum-to-pulsechain/light-client-update/v1",
    );
    expect(proofCategoryName("eth-pls", "second-to-first")).toBe(
      "zk-bridge/eth-pls/pulsechain-to-ethereum/light-client-update/v1",
    );
  });

  it("hashes the name with keccak256, the way categoryHash of the msgboard sdk does", () => {
    expect(proofCategory("eth-pls", "first-to-second")).toBe(
      keccak256(stringToBytes("zk-bridge/eth-pls/ethereum-to-pulsechain/light-client-update/v1")),
    );
    expect(proofCategory("eth-pls", "first-to-second")).not.toBe(proofCategory("eth-pls", "second-to-first"));
  });

  it("refuses an unknown pair", () => {
    expect(() => proofCategoryName("nope", "first-to-second")).toThrow(ProofMessageError);
  });
});

describe("refusals of the encoder and the decoder", () => {
  it("refuses public values that are not 352 bytes", () => {
    expect(() => decodeLightClientOutput("0x00")).toThrow(new ProofMessageError("wrong-field-size", "public values must be 352 bytes"));
  });

  it("refuses a slot that does not fit in 64 bits, and names the field", () => {
    expect(() => encodeProofMessage(sample({ newSlot: 1n << 64n }))).toThrow(
      new ProofMessageError("wrong-field-size", "new slot must fit in 64 bits"),
    );
    expect(() => encodeProofMessage(sample({ startSlot: -1n }))).toThrow(
      new ProofMessageError("wrong-field-size", "start slot must fit in 64 bits"),
    );
  });

  it("accepts the largest slot of 64 bits in the slot check", () => {
    expect(() => encodeProofMessage(sample({ newSlot: (1n << 64n) - 1n }))).toThrow(
      new ProofMessageError("inconsistent-public-values", "the slots and roots of the header differ from the public values"),
    );
  });

  it("refuses an unknown direction", () => {
    expect(() => encodeProofMessage(sample({ direction: "sideways" as never }))).toThrow(
      new ProofMessageError("unknown-direction", 'direction "sideways"'),
    );
  });

  it("refuses a field of the wrong size", () => {
    expect(() => encodeProofMessage(sample({ programKey: "0x00" }))).toThrow(new ProofMessageError("wrong-field-size", "program key must be 32 bytes"));
  });

  it("does not hide an error that is not a ProofMessageError as an ignorable message", async () => {
    vi.resetModules();
    vi.doMock("viem", async (importOriginal) => ({
      ...(await importOriginal<typeof import("viem")>()),
      hexToBytes: () => {
        throw new TypeError("a bug, not a bad message");
      },
    }));
    const { tryDecodeProofMessage: isolated } = await import("../src/proof-message.js");
    expect(() => isolated("0x01")).toThrow(new TypeError("a bug, not a bad message"));
    vi.doUnmock("viem");
    vi.resetModules();
  });
});
