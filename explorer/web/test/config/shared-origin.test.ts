import { describe, expect, it } from "vitest";
import { originIsShared } from "../../src/config/shared-origin";

describe("originIsShared", () => {
  it("a path-style gateway is a shared origin", () => {
    expect(originIsShared({ pathname: "/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/", hostname: "dweb.link" })).toBe(true);
    expect(originIsShared({ pathname: "/ipns/bridge.example/", hostname: "ipfs.io" })).toBe(true);
    expect(originIsShared({ pathname: "/ipfs/bafy", hostname: "localhost" })).toBe(true);
  });

  it("a subdomain-style gateway, a normal domain and localhost are own origins", () => {
    expect(originIsShared({ pathname: "/", hostname: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.dweb.link" })).toBe(false);
    expect(originIsShared({ pathname: "/", hostname: "example.org" })).toBe(false);
    expect(originIsShared({ pathname: "/", hostname: "localhost" })).toBe(false);
  });

  it("only the first path segment counts, and the whole segment must match", () => {
    expect(originIsShared({ pathname: "/app/ipfs/x", hostname: "example.org" })).toBe(false);
    expect(originIsShared({ pathname: "/ipfs-tools/", hostname: "example.org" })).toBe(false);
    expect(originIsShared({ pathname: "/ipns", hostname: "example.org" })).toBe(true);
  });

  it("an empty path is an own origin", () => {
    expect(originIsShared({ pathname: "", hostname: "example.org" })).toBe(false);
  });

  it("cannot be bypassed with extra slashes, encoding or case", () => {
    for (const pathname of ["//ipfs/x/", "///ipns/y", "/%69pfs/x/", "/%69%70%6e%73/y", "/IPFS/x/", "/IpNs/y"]) {
      expect(originIsShared({ pathname, hostname: "example.org" }), pathname).toBe(true);
    }
  });

  it("fails closed on a segment that cannot be read", () => {
    expect(originIsShared({ pathname: "/%/x", hostname: "example.org" })).toBe(true);
    expect(originIsShared({ pathname: "/%E0%A4%A/x", hostname: "example.org" })).toBe(true);
    expect(originIsShared({ pathname: "/%2569pfs/x", hostname: "example.org" })).toBe(true);
  });

  it("keeps the own origins false with extra slashes", () => {
    expect(originIsShared({ pathname: "//", hostname: "localhost" })).toBe(false);
    expect(originIsShared({ pathname: "//app/ipfs", hostname: "example.org" })).toBe(false);
  });

  it("treats an encoded slash or backslash in the first segment as shared", () => {
    for (const pathname of ["/ipfs%2Fx/", "/IPNS%2fy/", "/ipfs%5Cx/"]) {
      expect(originIsShared({ pathname, hostname: "example.org" }), pathname).toBe(true);
    }
  });
});
