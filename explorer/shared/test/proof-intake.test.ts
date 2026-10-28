import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { assessProofPayload, payloadKey } from "../src/prover/proof-intake.js";
import { encodeProofMessage } from "../src/proof-message.js";
import { PROGRAM_KEY, fakeLightClient, fakeProver, proofMessage, proofPayload, word } from "./support/prover-builders.js";

const assess = (options: { payload?: ReturnType<typeof proofPayload>; pairName?: string; lightClient?: ReturnType<typeof fakeLightClient>; prover?: ReturnType<typeof fakeProver> } = {}) =>
  assessProofPayload({
    payload: options.payload ?? proofPayload(),
    pairName: options.pairName ?? "eth-pls",
    direction: "first-to-second",
    lightClient: options.lightClient ?? fakeLightClient(),
    prover: options.prover ?? fakeProver(),
  });

describe("the assessment of a proof payload", () => {
  it("accepts a proof that starts at the stored head, and verifies it with the key and the values of the message", async () => {
    const verified: unknown[] = [];
    const prover = fakeProver();
    prover.verify = async (request) => {
      verified.push(request);
    };
    const result = await assess({ prover });
    expect(result).toEqual({ accept: true, message: proofMessage() });
    expect(verified).toEqual([{ programKey: PROGRAM_KEY, publicValues: proofMessage().publicValues, proof: proofMessage().proof }]);
  });

  it("refuses a proof for another pair, without reading the light client", async () => {
    const lightClient = fakeLightClient();
    expect(await assess({ pairName: "eth-base", lightClient })).toEqual({ accept: false, reason: "wrong-pair" });
    expect(lightClient.reads).toBe(0);
  });

  it("refuses a proof whose start root differs from the stored head root, and does not verify it", async () => {
    const prover = fakeProver();
    expect(await assess({ lightClient: fakeLightClient({ headRoot: word(0x7f) }), prover })).toEqual({ accept: false, reason: "start-root-differs-from-head" });
    expect(prover.verifications).toBe(0);
  });

  it("refuses when the light client cannot be read, and gives the message of the error", async () => {
    const lightClient = fakeLightClient();
    lightClient.read = async () => {
      throw new Error("the node is down");
    };
    expect(await assess({ lightClient })).toEqual({ accept: false, reason: "light-client-unreadable", detail: "the node is down" });
  });

  it("refuses when the light client read fails with a value that is no error object, and gives its text", async () => {
    const lightClient = fakeLightClient();
    lightClient.read = async () => {
      throw "socket closed";
    };
    expect(await assess({ lightClient })).toEqual({ accept: false, reason: "light-client-unreadable", detail: "socket closed" });
  });

  it("refuses a proof that fails verification with a value that is no error object, and gives its text", async () => {
    const prover = fakeProver();
    prover.verify = async () => {
      throw "the verifier crashed";
    };
    expect(await assess({ prover })).toEqual({ accept: false, reason: "proof-does-not-verify", detail: "the verifier crashed" });
  });

  it("refuses a payload that does not decode", async () => {
    const result = await assess({ payload: "0x1234" });
    expect(result).toMatchObject({ accept: false, reason: "undecodable" });
  });

  it("refuses a proof for the other direction", async () => {
    expect(await assess({ payload: proofPayload({ direction: "second-to-first" }) })).toEqual({ accept: false, reason: "wrong-direction" });
  });

  it("refuses a proof for another program key, whatever the letter case", async () => {
    expect(await assess({ lightClient: fakeLightClient({ programKey: word(0x43) }) })).toEqual({ accept: false, reason: "program-key-mismatch" });
    expect((await assess({ lightClient: fakeLightClient({ programKey: PROGRAM_KEY.toUpperCase().replace("0X", "0x") as typeof PROGRAM_KEY }) })).accept).toBe(true);
  });

  it("refuses a proof that ends at or before the stored head", async () => {
    expect(await assess({ lightClient: fakeLightClient({ headSlot: 164n }) })).toEqual({ accept: false, reason: "already-stored" });
  });

  it("refuses a proof that starts at another slot than the stored head", async () => {
    expect(await assess({ lightClient: fakeLightClient({ headSlot: 120n }) })).toEqual({ accept: false, reason: "start-slot-differs-from-head" });
  });

  it("refuses a proof that fails verification, and gives the message of the error", async () => {
    const prover = fakeProver({ verify: () => { throw new Error("bad proof"); } });
    expect(await assess({ prover })).toEqual({ accept: false, reason: "proof-does-not-verify", detail: "bad proof" });
  });

  describe("the oracle form", () => {
    const oraclePayload = () => encodeProofMessage({ ...proofMessage(), version: 2, proof: `0x${"cd".repeat(65)}` }, { acceptOracleProof: true });
    const withOption = (acceptOracleProof?: boolean) => (prover: ReturnType<typeof fakeProver>) =>
      assessProofPayload({ payload: oraclePayload(), pairName: "eth-pls", direction: "first-to-second", lightClient: fakeLightClient(), prover, ...(acceptOracleProof === undefined ? {} : { acceptOracleProof }) });

    it.each([["unset", undefined], ["false", false]])("refuses it when the option is %s, and never calls the prover", async (_name, option) => {
      const prover = fakeProver();
      expect(await withOption(option)(prover)).toEqual({ accept: false, reason: "oracle-proof-not-accepted" });
      expect(prover.verifications).toBe(0);
    });

    it("accepts it only with the option true, and skips the local Groth16 check, which cannot judge it", async () => {
      const prover = fakeProver({ verify: () => { throw new Error("must not run"); } });
      const result = await withOption(true)(prover);
      expect(result).toMatchObject({ accept: true });
      expect(prover.verifications).toBe(0);
    });

    it("still applies the checks of the chain state to an oracle proof", async () => {
      const result = await assessProofPayload({ payload: oraclePayload(), pairName: "eth-pls", direction: "first-to-second", lightClient: fakeLightClient({ headSlot: 120n }), prover: fakeProver(), acceptOracleProof: true });
      expect(result).toEqual({ accept: false, reason: "start-slot-differs-from-head" });
    });

    it("does not change a Groth16 proof: the option on or off, it is verified", async () => {
      const prover = fakeProver();
      expect((await assess({ prover })).accept).toBe(true);
      expect(prover.verifications).toBe(1);
    });
  });

  it("names the key of a payload by its hash, so that a republished payload has one key", () => {
    const payload = proofPayload();
    expect(payloadKey(payload)).toBe(keccak256(payload));
    expect(payloadKey(proofPayload({ newSlot: 165n }))).not.toBe(payloadKey(payload));
  });
});
