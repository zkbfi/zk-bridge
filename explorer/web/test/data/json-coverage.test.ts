import { describe, expect, it } from "vitest";
import { IndexerResponseError, readAddress, readAmount, readArray, readHex, readInteger, readNullableInteger, readRecord, readText } from "../../src/data/json";

const ADDRESS_LOWER = "0x52908400098527886e0f7030069857d2e4169ee7";
const ADDRESS_CHECKSUM = "0x52908400098527886E0F7030069857D2E4169EE7";

describe("the strict readers of indexer json", () => {
  it("returns an object unchanged and refuses null, a list and a primitive with the name of the field", () => {
    const record = { a: 1 };
    expect(readRecord(record, "item")).toBe(record);
    for (const bad of [null, [], "x", 3, undefined]) expect(() => readRecord(bad, "item")).toThrow(new IndexerResponseError("The item is not an object."));
  });

  it("returns a list unchanged and refuses anything else", () => {
    const list = [1];
    expect(readArray(list, "items")).toBe(list);
    expect(() => readArray({}, "items")).toThrow("The items is not a list.");
  });

  it("returns text and refuses a number", () => {
    expect(readText("", "status")).toBe("");
    expect(() => readText(1, "status")).toThrow("The status is not text.");
  });

  it("returns a safe integer and refuses a fraction, an unsafe integer and a string", () => {
    expect(readInteger(0, "block")).toBe(0);
    expect(() => readInteger(1.5, "block")).toThrow("The block is not an integer.");
    expect(() => readInteger(2 ** 53, "block")).toThrow("The block is not an integer.");
    expect(() => readInteger("1", "block")).toThrow("The block is not an integer.");
  });

  it("gives null instead of an error for a value that is not a safe integer", () => {
    expect(readNullableInteger(7)).toBe(7);
    expect(readNullableInteger(7.5)).toBeNull();
    expect(readNullableInteger("7")).toBeNull();
    expect(readNullableInteger(null)).toBeNull();
  });

  it("reads an amount only from a decimal string, as a bigint without loss of digits", () => {
    expect(readAmount("123456789012345678901234567890", "value")).toBe(123456789012345678901234567890n);
    for (const bad of [5, "-5", "1.5", "0x10", "", "1e3", null]) expect(() => readAmount(bad, "value")).toThrow("The amount value is not a decimal string.");
  });

  it("reads hex in lower case and refuses text without the prefix or with other characters", () => {
    expect(readHex("0xABcd", "data")).toBe("0xabcd");
    expect(readHex("0x", "data")).toBe("0x");
    for (const bad of ["abcd", "0xzz", 12, null]) expect(() => readHex(bad, "data")).toThrow("The data is not hex.");
  });

  it("returns an address in checksum form and refuses a wrong length or a non-string", () => {
    expect(readAddress(ADDRESS_LOWER, "sender")).toBe(ADDRESS_CHECKSUM);
    for (const bad of ["0x1234", `${ADDRESS_LOWER}00`, ADDRESS_LOWER.slice(2), 5, undefined]) expect(() => readAddress(bad, "sender")).toThrow("The sender is not an address.");
  });

  it("names the error class so a caller can tell it from other failures", () => {
    expect(new IndexerResponseError("x").name).toBe("IndexerResponseError");
  });
});
