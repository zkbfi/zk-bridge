import { describe, expect, it } from "vitest";
import { callerKey } from "../src/requests/caller.ts";

describe("callerKey", () => {
  it("keeps an IPv4 address, drops a zone, and maps an IPv4 address inside IPv6 to IPv4", () => {
    expect(callerKey("203.0.113.9")).toBe("203.0.113.9");
    expect(callerKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(callerKey("fe80::1%en0")).toBe(callerKey("fe80::2"));
  });

  it("keys IPv6 by the first 64 bits in every written form", () => {
    const expected = "2001:db8:1:2::/64";
    expect(callerKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(expected);
    expect(callerKey("2001:0DB8:0001:0002::1")).toBe(expected);
    expect(callerKey("2001:db8:1:2::")).toBe(expected);
    expect(callerKey("2001:db8:1:3::1")).not.toBe(expected);
    expect(callerKey("::1")).toBe("0:0:0:0::/64");
    expect(callerKey("::")).toBe("0:0:0:0::/64");
  });

  it("leaves text that is no address as it is", () => {
    expect(callerKey("unknown")).toBe("unknown");
    expect(callerKey("1::2::3")).toBe("1::2::3");
    expect(callerKey("zz::1")).toBe("zz::1");
    expect(callerKey("zz:1")).toBe("zz:1");
    expect(callerKey("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
    expect(callerKey("1:2:3:4:5:6:7:8::")).toBe("1:2:3:4:5:6:7:8::");
  });
});
