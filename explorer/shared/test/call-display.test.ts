import { encodeAbiParameters, keccak256, type AbiParameter, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { describeBytes, displayArguments } from "../src/index.js";

const word = (digit: string): Hex => `0x${digit.repeat(64)}`;
const show = (parameter: AbiParameter, value: unknown) => displayArguments([parameter], [value])[0];

describe("displayArguments", () => {
  it("shows a bytes32 scalar whole and a number as decimal text", () => {
    expect(show({ name: "root", type: "bytes32" }, word("a"))).toEqual({ name: "root", type: "bytes32", value: word("a") });
    expect(show({ name: "slot", type: "uint64" }, 7n)).toEqual({ name: "slot", type: "uint64", value: "7" });
  });

  it("shows a short bytes32 array whole, in the dynamic and the fixed form", () => {
    const joined = `${word("1")}, ${word("2")}`;
    expect(show({ name: "branch", type: "bytes32[]" }, [word("1"), word("2")])).toEqual({
      name: "branch",
      type: "bytes32[]",
      meaning: "2 items",
      value: joined,
    });
    expect(show({ name: "pair", type: "bytes32[2]" }, [word("1"), word("2")])?.value).toBe(joined);
  });

  it("summarizes a bytes32 array of more than four items by the digest of its encoding", () => {
    const items = [1, 2, 3, 4, 5].map((digit) => word(String(digit)));
    const digest = keccak256(encodeAbiParameters([{ type: "bytes32[]" }], [items]));
    expect(show({ name: "branch", type: "bytes32[]" }, items)).toMatchObject({
      meaning: "5 items",
      value: `keccak256 of the encoding ${digest}`,
    });
  });

  it("summarizes an array of any other element type, and shows an empty array as []", () => {
    const digest = keccak256(encodeAbiParameters([{ type: "uint256[]" }], [[1n]]));
    expect(show({ name: "values", type: "uint256[]" }, [1n])?.value).toBe(`keccak256 of the encoding ${digest}`);
    expect(show({ name: "nested", type: "bytes32[][]" }, [[word("1")]])?.value).toMatch(/^keccak256 of the encoding/);
    expect(show({ name: "branch", type: "bytes32[]" }, [])).toMatchObject({ meaning: "0 items", value: "[]" });
  });

  it("checksums an address and flattens a tuple to dotted names, with the index for an unnamed part", () => {
    const lower = "0x52908400098527886e0f7030069857d2e4169ee7";
    const tuple: AbiParameter = {
      name: "row",
      type: "tuple",
      components: [{ name: "owner", type: "address" }, { type: "uint256" }],
    };
    expect(displayArguments([tuple], [{ owner: lower, 1: 5n }])).toEqual([
      { name: "row.owner", type: "address", value: "0x52908400098527886E0F7030069857D2E4169EE7" },
      { name: "row.1", type: "uint256", value: "5" },
    ]);
  });

  it("names an unnamed parameter by its place", () => {
    expect(displayArguments([{ type: "uint8" }], [3])).toEqual([{ name: "arg0", type: "uint8", value: "3" }]);
  });

  it("keeps an address-typed value that is not an address as plain text", () => {
    expect(show({ name: "who", type: "address" }, "nobody")?.value).toBe("nobody");
  });
});

describe("describeBytes", () => {
  it("shows 33 bytes whole and cuts anything longer, with its length and digest", () => {
    const whole: Hex = `0x${"ab".repeat(32)}`;
    expect(describeBytes(whole)).toEqual({ value: whole, meaning: "32 bytes" });
    const long: Hex = `0x${"cd".repeat(100)}`;
    expect(describeBytes(long)).toEqual({ value: `${long.slice(0, 34)}… keccak256 ${keccak256(long)}`, meaning: "100 bytes" });
  });
});
