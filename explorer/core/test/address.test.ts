import { describe, expect, it } from "vitest";
import { normalizeAddress, sameAddress, ZERO_ADDRESS } from "../src/address.js";

const checksummed = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

describe("normalizeAddress", () => {
  it("lowercases a checksummed address, because Ponder stores lowercase", () => {
    expect(normalizeAddress(checksummed)).toBe("0x90f79bf6eb2c4f870365e785982e1f101e93b906");
  });

  it("accepts an address with a wrong checksum, because only the length and the digits matter", () => {
    expect(normalizeAddress("0x90F79BF6EB2C4F870365E785982E1F101E93B906")).toBe("0x90f79bf6eb2c4f870365e785982e1f101e93b906");
  });

  it.each(["", "0x1234", "90f79bf6eb2c4f870365e785982e1f101e93b906", "0xzzf79bf6eb2c4f870365e785982e1f101e93b906"])(
    "refuses %j with the text of the value in the message",
    (value) => {
      expect(() => normalizeAddress(value)).toThrow(`not an address: ${value}`);
    },
  );
});

describe("sameAddress", () => {
  it("ignores letter case", () => {
    expect(sameAddress(checksummed, checksummed.toLowerCase())).toBe(true);
  });

  it("tells two different addresses apart", () => {
    expect(sameAddress(checksummed, ZERO_ADDRESS)).toBe(false);
  });
});

describe("ZERO_ADDRESS", () => {
  it("is 20 zero bytes", () => {
    expect(ZERO_ADDRESS).toBe(`0x${"00".repeat(20)}`);
  });
});
