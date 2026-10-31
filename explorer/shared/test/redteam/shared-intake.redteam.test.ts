/**
 * Red team, 2026-10-29: redaction, the light client reader, the proof message codec, the proof intake and the board
 * reader of explorer/shared.
 */
import { concat, keccak256, toHex, zeroHash, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { readBoardMessages } from "../../src/msgboard/board-http.js";
import { ORACLE_PROOF_MESSAGE_VERSION, decodeProofMessage, encodeProofMessage, tryDecodeProofMessage } from "../../src/proof-message.js";
import { createLightClientReader } from "../../src/prover/light-client.js";
import { assessProofPayload, payloadKey } from "../../src/prover/proof-intake.js";
import { REDACTED, redactError, redactSecrets } from "../../src/redaction.js";
import { LIGHT_CLIENT, fakeLightClient, fakeProver, proofMessage, proofPayload } from "../support/prover-builders.js";

describe("redaction", () => {
  it.each([
    ["Alchemy", "https://eth-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUv", "AbCdEfGhIjKlMnOpQrStUv"],
    ["Infura", "https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"],
    ["query key", "https://rpc.example/eth?api_key=s3cr3tvalue", "s3cr3tvalue"],
    ["user:password", "https://user:hunter2hunter2@rpc.example/", "hunter2hunter2"],
    ["RunPod key", "auth failed for rpa_ABCDEF0123456789", "rpa_ABCDEF0123456789"],
    ["bearer", "Authorization: Bearer abcdefgh12345678", "abcdefgh12345678"],
    ["percent-encoded password", "https://user:p%40ss%2Fword99@rpc.example/", "p%40ss%2Fword99"],
  ])("ATTACK %s secret in an error line is removed (BLOCKED)", (_, text, secret) => {
    expect(redactSecrets(`request to ${text} failed`)).not.toContain(secret);
  });

  it.each([
    ["QuickNode path token", "https://black-wild-sun.quiknode.pro/4f1c9a0b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f70/", "4f1c9a0b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f70"],
    ["Ankr path key", "https://rpc.ankr.com/eth/9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b", "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b"],
    ["dRPC dkey query", "https://lb.drpc.org/ogrpc?network=ethereum&dkey=AkLmNoPqRsTuVwXyZ012345", "AkLmNoPqRsTuVwXyZ012345"],
    ["access_token query", "https://beacon.example/eth/v1?access_token=tok_live_99887766", "tok_live_99887766"],
    ["x-api-key header", "x-api-key: 77aa88bb99cc00dd", "77aa88bb99cc00dd"],
  ])("ATTACK %s is removed by redactSecrets when the caller does not pass it as a known secret (BLOCKED, was S-6)", (_, text, secret) => {
    expect(redactSecrets(`request to ${text} failed`)).not.toContain(secret);
  });

  it("ATTACK a known secret is removed whatever its shape (BLOCKED)", () => {
    const secret = "4f1c9a0b2d3e4f5a6b7c8d9e0f1a2b3c";
    expect(redactError(new Error(`GET https://x.quiknode.pro/${secret}/ 500`), [secret])).toBe(`GET https://x.quiknode.pro/${REDACTED}/ 500`);
  });

  it("ATTACK a known secret of five characters is removed (BLOCKED, was S-6)", () => {
    expect(redactSecrets("token abcde in the url", ["abcde"])).not.toContain("abcde");
  });

  it("ATTACK a known secret is removed in its percent-encoded form (BLOCKED, was S-6)", () => {
    const secret = "pa ss/word!";
    expect(redactSecrets(`https://rpc.example/?q=${encodeURIComponent(secret)}`, [secret])).not.toContain(encodeURIComponent(secret));
  });
});

describe("the light client reader (e776f05: one block)", () => {
  const client = (answers: { head: bigint; programKey: Hex; root: Hex }) => {
    const blocks: (bigint | undefined)[] = [];
    return {
      blocks,
      getBlockNumber: async () => 1234n,
      readContract: async (request: { functionName: string; blockNumber?: bigint }) => {
        blocks.push(request.blockNumber);
        if (request.functionName === "head") return answers.head;
        if (request.functionName === "programVKey") return answers.programKey;
        return answers.root;
      },
    };
  };

  it("ATTACK reads at different heights behind a load balancer: every read names the same block (BLOCKED)", async () => {
    const fake = client({ head: 10n, programKey: `0x${"42".repeat(32)}`, root: `0x${"11".repeat(32)}` });
    await createLightClientReader(fake as never, LIGHT_CLIENT).read();
    expect(fake.blocks).toEqual([1234n, 1234n, 1234n]);
  });

  it("ATTACK a lagging node answers an empty root for the head: the read fails instead of reporting a moved head (BLOCKED)", async () => {
    const fake = client({ head: 10n, programKey: `0x${"42".repeat(32)}`, root: zeroHash });
    await expect(createLightClientReader(fake as never, LIGHT_CLIENT).read()).rejects.toThrow(/no header root/);
  });
});

describe("the proof message codec and the intake", () => {
  it.each([
    ["pair code 0", (bytes: Uint8Array) => (bytes[1] = 0)],
    ["direction code 2", (bytes: Uint8Array) => (bytes[2] = 2)],
    ["header new slot differs from the public values", (bytes: Uint8Array) => (bytes[82] = bytes[82]! ^ 1)],
  ])("ATTACK %s is refused (BLOCKED)", (_, tamper) => {
    const bytes = Uint8Array.from(Buffer.from(proofPayload().slice(2), "hex"));
    tamper(bytes);
    expect(tryDecodeProofMessage(toHex(bytes)).ok).toBe(false);
  });

  it("ATTACK oracle form written with upper-case hex is refused on a strict reader (BLOCKED)", async () => {
    const oracle = encodeProofMessage({ ...proofMessage(), version: ORACLE_PROOF_MESSAGE_VERSION, proof: `0x${"ab".repeat(65)}` }, { acceptOracleProof: true });
    const upper = `0x${oracle.slice(2).toUpperCase()}` as Hex;
    expect(() => decodeProofMessage(upper)).toThrow(/oracle form/);
    const verdict = await assessProofPayload({ payload: upper, pairName: "eth-pls", direction: "first-to-second", lightClient: fakeLightClient(), prover: fakeProver() });
    expect(verdict).toEqual({ accept: false, reason: "oracle-proof-not-accepted" });
  });

  it("ATTACK the same payload in upper and lower case gets one payload key (BLOCKED, no double look)", () => {
    const payload = proofPayload();
    expect(payloadKey(`0x${payload.slice(2).toUpperCase()}` as Hex)).toBe(payloadKey(payload));
    expect(payloadKey(payload)).toBe(keccak256(payload));
  });

  it("ATTACK a version 1 message with a 65-byte proof plus padding to 823 bytes is not a short proof (BLOCKED, size is fixed)", () => {
    const payload = proofPayload();
    expect(tryDecodeProofMessage(concat([payload, "0x00"]))).toMatchObject({ ok: false, reason: "trailing-bytes" });
  });
});

describe("the board reader", () => {
  const category = keccak256("0x01");
  const answer = (result: unknown) => async () => ({ status: 200, body: { jsonrpc: "2.0", id: 1, result } });

  it("ATTACK a message of another category in the answer is dropped (BLOCKED)", async () => {
    const other = { category: keccak256("0x02"), data: "0x01", hash: keccak256("0x03") };
    const messages = await readBoardMessages({ boardUrl: "https://board.example", category, fetchJson: answer({ a: [other] }) });
    expect(messages).toEqual([]);
  });

  it("ATTACK a message with a non-hex field is refused (BLOCKED)", async () => {
    const bad = { category, data: "<script>", hash: keccak256("0x03") };
    await expect(readBoardMessages({ boardUrl: "https://board.example", category, fetchJson: answer({ a: [bad] }) })).rejects.toThrow(/unknown shape/);
  });

  it("ATTACK SUCCEEDS a hostile board answer of 20,000 messages with a forged hash is passed on whole (no count limit, hash not checked)", async () => {
    const many = Array.from({ length: 20_000 }, (_, index) => ({ category, data: toHex(index, { size: 4 }), hash: zeroHash }));
    const messages = await readBoardMessages({ boardUrl: "https://board.example", category, fetchJson: answer({ a: many }) });
    expect(messages).toHaveLength(20_000);
    expect(messages[0]!.hash).toBe(zeroHash);
  });
});
