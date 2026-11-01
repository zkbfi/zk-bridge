import { describe, expect, it } from "vitest";
import { CANDIDATE_CLASS, MAXIMUM_QUERY_LENGTH, classifyQuery } from "../src/index.js";

const hash = `0x${"ab".repeat(32)}`;
const address = `0x${"cd".repeat(20)}`;
const kinds = (text: string): string[] => classifyQuery(text).candidates.map((candidate) => candidate.kind);

describe("classifyQuery", () => {
  it("reads nothing from an empty or a too long text", () => {
    expect(classifyQuery("   ")).toEqual({ query: "", candidates: [], unsupported: null });
    expect(classifyQuery("a".repeat(MAXIMUM_QUERY_LENGTH + 1)).candidates).toEqual([]);
  });

  it("reads 32 bytes as a message identifier and a transaction hash, in lowercase, with or without 0x", () => {
    const expected = [{ kind: "message-id", hash }, { kind: "transaction", hash }];
    expect(classifyQuery(`  ${hash.toUpperCase().replace("0X", "0x")}  `).candidates).toEqual(expected);
    expect(classifyQuery(hash.slice(2)).candidates).toEqual(expected);
  });

  it("reads 20 bytes as an address", () => {
    expect(classifyQuery(address.toUpperCase().replace("0X", "0x")).candidates).toEqual([{ kind: "address", address }]);
    expect(classifyQuery(address.slice(2)).candidates).toEqual([{ kind: "address", address }]);
  });

  it("reads the start of a hex value as a prefix, from six digits", () => {
    expect(classifyQuery("0xABCDEF12").candidates).toEqual([{ kind: "hex-prefix", prefix: "0xabcdef12" }]);
    expect(classifyQuery("0xabcde").candidates).toEqual([]);
    expect(classifyQuery(`0x${"a".repeat(65)}`).candidates).toEqual([]);
    expect(kinds("0xBTC")).toEqual(["symbol"]);
  });

  it("reads digits as a proof, a slot and a block, and keeps the number exact", () => {
    expect(classifyQuery("0012").candidates).toEqual([{ kind: "proof", value: "12" }, { kind: "slot", value: "12" }, { kind: "block", value: "12" }]);
    expect(kinds("123456789012345678")).toEqual(["proof", "slot", "block"]);
    expect(kinds("1234567890123456789")).toEqual([]);
  });

  it("reads a content identifier", () => {
    const cid = `bafy${"a".repeat(30)}`;
    expect(classifyQuery(cid).candidates).toEqual([{ kind: "cid", cid }]);
    expect(kinds(`Qm${"1".repeat(44)}`)).toEqual(["cid"]);
  });

  it("does not resolve ENS-like names and says so", () => {
    expect(classifyQuery("vitalik.eth")).toEqual({ query: "vitalik.eth", candidates: [], unsupported: "name" });
    expect(classifyQuery("a.b-c.pls").unsupported).toBe("name");
  });

  it("reads words as a token symbol or name", () => {
    expect(classifyQuery("WETH.e").candidates).toEqual([{ kind: "symbol", text: "WETH.e" }]);
    expect(classifyQuery("wrapped ether").candidates).toEqual([{ kind: "symbol", text: "wrapped ether" }]);
    expect(kinds("abc")).toEqual(["symbol"]);
    expect(kinds("deadbeef")).toEqual(["symbol"]);
  });

  it("reads nothing from other text", () => {
    expect(classifyQuery("what? no!")).toEqual({ query: "what? no!", candidates: [], unsupported: null });
  });

  it("ranks identifiers above addresses, prefixes, symbols and numbers", () => {
    expect(CANDIDATE_CLASS["message-id"]).toBeLessThan(CANDIDATE_CLASS.address);
    expect(CANDIDATE_CLASS.address).toBeLessThan(CANDIDATE_CLASS["hex-prefix"]);
    expect(CANDIDATE_CLASS["hex-prefix"]).toBeLessThan(CANDIDATE_CLASS.symbol);
    expect(CANDIDATE_CLASS.symbol).toBeLessThan(CANDIDATE_CLASS.slot);
  });
});
