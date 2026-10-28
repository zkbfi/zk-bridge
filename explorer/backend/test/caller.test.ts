import { describe, expect, it } from "vitest";
import { UNKNOWN_CALLER, callerKey } from "../src/requests/caller.ts";

describe("callerKey", () => {
  it("keeps an IPv4 address and drops its port", () => {
    expect(callerKey("203.0.113.9")).toBe("203.0.113.9");
    expect(callerKey("1.2.3.4:5678")).toBe("1.2.3.4");
    expect(callerKey(" 1.2.3.4 ")).toBe("1.2.3.4");
  });

  it("treats an IPv4 address inside IPv6 as IPv4, in the dotted and in the hex form", () => {
    expect(callerKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(callerKey("::ffff:102:304")).toBe("1.2.3.4");
    expect(callerKey("::FFFF:0102:0304")).toBe("1.2.3.4");
    expect(callerKey("[::ffff:1.2.3.4]:80")).toBe("1.2.3.4");
  });

  it("keys IPv6 by the first 64 bits in every written form", () => {
    const expected = "2001:db8:1:2::/64";
    expect(callerKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(expected);
    expect(callerKey("2001:0DB8:0001:0002::1")).toBe(expected);
    expect(callerKey("2001:db8:1:2::")).toBe(expected);
    expect(callerKey("2001:db8:1:3::1")).not.toBe(expected);
    expect(callerKey("::1")).toBe("0:0:0:0::/64");
    expect(callerKey("::")).toBe("0:0:0:0::/64");
    expect(callerKey("fe80::1%en0")).toBe(callerKey("fe80::2"));
  });

  it("groups an IPv6 address with a dotted tail by its /64 prefix", () => {
    expect(callerKey("2001:db8:0:1::1.2.3.4")).toBe("2001:db8:0:1::/64");
    expect(callerKey("2001:db8:0:1:0:0:1.2.3.4")).toBe("2001:db8:0:1::/64");
    expect(callerKey("2001:db8:0:1::1.2.3.400")).toBe(UNKNOWN_CALLER);
  });

  it("strips brackets and a port from an IPv6 entry", () => {
    expect(callerKey("[2001:db8::1]:443")).toBe("2001:db8:0:0::/64");
    expect(callerKey("[2001:db8:1:2::9]")).toBe("2001:db8:1:2::/64");
  });

  it("gives the shared no-address key to text that is no address, never the raw text", () => {
    for (const text of ["unknown", "", "1::2::3", "zz::1", "zz:1", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7:8::", "999.1.1.1", "1.2.3", "evil-forged-key-17", "1:2:3:4:5:6:7"]) {
      expect(callerKey(text)).toBe(UNKNOWN_CALLER);
    }
  });
});
