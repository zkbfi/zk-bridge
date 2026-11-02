import { readFileSync } from "node:fs";
import { keccak256, toRlp, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { EMPTY_CODE_HASH, EMPTY_TRIE_ROOT, TrieProofError, verifyAccountProof, verifyTrieProof } from "../src/prover/storage-proof-verify.js";

/** A real answer of a public Sepolia node: the light client of the bridge, one present and one absent storage key. */
const fixture = JSON.parse(readFileSync(new URL("./fixtures/sepolia-get-proof.json", import.meta.url), "utf8")) as {
  stateRoot: Hex;
  address: Hex;
  storageKeys: Hex[];
  proof: { balance: Hex; nonce: Hex; codeHash: Hex; storageHash: Hex; accountProof: Hex[]; storageProof: { key: Hex; value: Hex; proof: Hex[] }[] };
  plainAccount: { address: Hex; proof: unknown };
};

const check = (answer: unknown, overrides: { stateRoot?: Hex; storageKeys?: Hex[]; address?: Hex } = {}) =>
  verifyAccountProof({ stateRoot: fixture.stateRoot, address: fixture.address, storageKeys: fixture.storageKeys, answer, ...overrides });

type Item = Hex | Item[];
const rlp = (item: Item): Hex => toRlp(item as never);

describe("verifyAccountProof on a real answer", () => {
  it("accepts the account, a present storage key and an absent one", () => {
    expect(fixture.proof.storageProof.map((item) => item.value)).toContain("0x0");
    expect(check(fixture.proof)).toEqual({ ok: true });
  });

  it("accepts an account without storage, whose storage proof is empty", () => {
    expect(check(fixture.plainAccount.proof, { address: fixture.plainAccount.address, storageKeys: [fixture.storageKeys[0] as Hex] })).toEqual({ ok: true });
  });

  it("refuses the answer against another state root", () => {
    expect(check(fixture.proof, { stateRoot: `0x${"11".repeat(32)}` })).toEqual({ ok: false, reason: "node 0 does not match its hash" });
  });

  it("refuses an account field that the proof does not hold", () => {
    expect(check({ ...fixture.proof, nonce: "0x2" })).toEqual({ ok: false, reason: "the nonce differs from the proof" });
    expect(check({ ...fixture.proof, balance: "0x1" })).toEqual({ ok: false, reason: "the balance differs from the proof" });
    expect(check({ ...fixture.proof, storageHash: EMPTY_TRIE_ROOT })).toEqual({ ok: false, reason: "the storage hash differs from the proof" });
    expect(check({ ...fixture.proof, codeHash: EMPTY_CODE_HASH })).toEqual({ ok: false, reason: "the code hash differs from the proof" });
  });

  it("refuses a storage value that the proof does not hold, and a requested key without a proof", () => {
    const [present, absent] = fixture.proof.storageProof as [{ key: Hex; value: Hex; proof: Hex[] }, { key: Hex; value: Hex; proof: Hex[] }];
    const forged = { ...fixture.proof, storageProof: [{ ...present, value: "0x1" }, absent] };
    expect(check(forged)).toEqual({ ok: false, reason: `the value of key ${fixture.storageKeys[0]} differs from the proof` });
    const claimedAbsent = { ...fixture.proof, storageProof: [present, { ...absent, value: "0x5" }] };
    expect(check(claimedAbsent).ok).toBe(false);
    expect(check({ ...fixture.proof, storageProof: [present] })).toEqual({ ok: false, reason: `the answer has no proof for key ${fixture.storageKeys[1]}` });
  });

  it("refuses a tampered node, and something that is no answer", () => {
    const nodes = [...fixture.proof.accountProof];
    const last = nodes[nodes.length - 1] as Hex;
    nodes[nodes.length - 1] = `${last.slice(0, -2)}${last.endsWith("00") ? "01" : "00"}` as Hex;
    expect(check({ ...fixture.proof, accountProof: nodes })).toEqual({ ok: false, reason: `node ${nodes.length - 1} does not match its hash` });
    expect(check({ accountProof: "nope" })).toEqual({ ok: false, reason: "the answer is not an eth_getProof answer" });
  });

  it("reports an error of the RLP decoder or of the key as a refusal", () => {
    expect(check(fixture.proof, { storageKeys: [`0x${"01".repeat(33)}`] }).ok).toBe(false);
  });
});

describe("verifyAccountProof of an absent account", () => {
  const empty = { balance: "0x0", nonce: "0x0", codeHash: EMPTY_CODE_HASH, storageHash: EMPTY_TRIE_ROOT, accountProof: [], storageProof: [{ key: "0x01", value: "0x0", proof: [] }] };

  it("accepts an absent account with empty fields, also with the zero hashes some nodes send", () => {
    expect(check(empty, { stateRoot: EMPTY_TRIE_ROOT, storageKeys: ["0x01"] })).toEqual({ ok: true });
    const zero = `0x${"0".repeat(64)}`;
    expect(check({ ...empty, codeHash: zero, storageHash: zero }, { stateRoot: EMPTY_TRIE_ROOT, storageKeys: ["0x01"] })).toEqual({ ok: true });
  });

  it("refuses an absent account with fields, or with a stored value", () => {
    for (const changed of [{ balance: "0x1" }, { nonce: "0x1" }, { codeHash: `0x${"22".repeat(32)}` }, { storageHash: `0x${"22".repeat(32)}` }]) {
      expect(check({ ...empty, ...changed }, { stateRoot: EMPTY_TRIE_ROOT, storageKeys: [] })).toEqual({ ok: false, reason: "the account is absent but the answer gives it fields" });
    }
    expect(check({ ...empty, storageProof: [{ key: "0x01", value: "0x7", proof: [] }] }, { stateRoot: EMPTY_TRIE_ROOT, storageKeys: ["0x01"] }).ok).toBe(false);
  });

  it("refuses an account value that is not four fields", () => {
    const address: Hex = `0x${"ab".repeat(20)}`;
    const leaf = rlp([`0x20${keccak256(address).slice(2)}`, rlp(["0x01", "0x02", "0x03"])]);
    expect(check({ ...empty, accountProof: [leaf] }, { stateRoot: keccak256(leaf), address, storageKeys: [] })).toEqual({ ok: false, reason: "the account is not four fields" });
  });
});

describe("verifyTrieProof", () => {
  /** A proof of single nodes, each referenced by hash. */
  const rooted = (nodes: Item[]) => {
    const encoded = nodes.map(rlp);
    return { root: keccak256(encoded[0] as Hex), proof: encoded };
  };
  const emptyBranch = (): Item[] => Array.from({ length: 17 }, () => "0x" as Hex);

  it("reads the value of a branch at the end of the key", () => {
    const branch = emptyBranch();
    branch[16] = "0x01";
    const { root, proof } = rooted([branch]);
    expect(verifyTrieProof(root, "0x", proof)).toBe("0x01");
  });

  it("follows a node embedded in its parent", () => {
    const branch = emptyBranch();
    branch[0] = ["0x3a", "0x05"];
    const { root, proof } = rooted([branch]);
    expect(verifyTrieProof(root, "0x0a", proof)).toBe("0x05");
    expect(verifyTrieProof(root, "0x0b", proof)).toBeNull();
    expect(verifyTrieProof(root, "0x1a", proof)).toBeNull();
  });

  it("follows an extension, and shows a key off its path absent", () => {
    const leaf = rlp(["0x2012", "0x09"]);
    const extension = rlp(["0x00ab", keccak256(leaf)]);
    expect(verifyTrieProof(keccak256(extension), "0xab12", [extension, leaf])).toBe("0x09");
    expect(verifyTrieProof(keccak256(extension), "0xcd12", [extension])).toBeNull();
    expect(verifyTrieProof(keccak256(extension), "0xab13", [extension, leaf])).toBeNull();
  });

  it("shows any key absent from an empty trie with an empty proof", () => {
    expect(verifyTrieProof(EMPTY_TRIE_ROOT, "0x01", [])).toBeNull();
  });

  it("refuses a proof that ends early, has nodes left over, or holds a malformed node", () => {
    const leaf = rlp(["0x2012", "0x09"]);
    const extension = rlp(["0x00ab", keccak256(leaf)]);
    expect(() => verifyTrieProof(keccak256(extension), "0xab12", [extension])).toThrow("the proof ends before the key");
    expect(() => verifyTrieProof(keccak256(extension), "0xab12", [extension, leaf, leaf])).toThrow("the proof has 1 node(s) after the key");
    const three = rlp(["0x01", "0x02", "0x03"]);
    expect(() => verifyTrieProof(keccak256(three), "0x01", [three])).toThrow("a node of 3 items");
    const single = rlp("0x1234");
    expect(() => verifyTrieProof(keccak256(single), "0x01", [single])).toThrow("node 0 is not a list");
    const badPrefix = rlp(["0x4012", "0x09"]);
    expect(() => verifyTrieProof(keccak256(badPrefix), "0x12", [badPrefix])).toThrow("a path with a bad prefix");
    const shortReference = emptyBranch();
    shortReference[1] = "0x1234";
    const { root, proof } = rooted([shortReference]);
    expect(() => verifyTrieProof(root, "0x10", proof)).toThrow("a reference of 2 bytes");
    const listValue = rlp(["0x20", ["0x01"]]);
    expect(() => verifyTrieProof(keccak256(listValue), "0x", [listValue])).toThrow(TrieProofError);
  });
});
