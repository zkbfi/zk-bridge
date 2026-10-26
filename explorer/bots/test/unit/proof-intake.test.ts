import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { assessProofPayload, payloadKey } from "../../src/runner/proof-intake.ts";
import { PROGRAM_KEY, fakeLightClient, fakeProver, proofMessage, proofPayload, word } from "../support/builders.ts";

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

  it("names the key of a payload by its hash, so that a republished payload has one key", () => {
    const payload = proofPayload();
    expect(payloadKey(payload)).toBe(keccak256(payload));
    expect(payloadKey(proofPayload({ newSlot: 165n }))).not.toBe(payloadKey(payload));
  });
});
