import { describe, expect, it, vi } from "vitest";
import { sendDocsHostToDocs } from "../../src/app/docs-host";

const at = (hostname: string, hash: string, pathname = "/", search = "") => {
  const replaceState = vi.fn();
  const moved = sendDocsHostToDocs({ hostname, hash, pathname, search }, { state: { k: 1 }, replaceState });
  return { moved, replaceState };
};

describe("sendDocsHostToDocs", () => {
  it("moves docs.zkb.fi with no hash to #/docs, without a reload", () => {
    const { moved, replaceState } = at("docs.zkb.fi", "");
    expect(moved).toBe(true);
    expect(replaceState).toHaveBeenCalledWith({ k: 1 }, "", "/#/docs");
  });

  it("moves a bare #/ the same way and keeps the path and the query", () => {
    const { replaceState } = at("docs.zkb.fi", "#/", "/ipfs/x/", "?pair=eth-pls");
    expect(replaceState).toHaveBeenCalledWith({ k: 1 }, "", "/ipfs/x/?pair=eth-pls#/docs");
    expect(at("docs.zkb.fi", "#").moved).toBe(true);
  });

  it("applies to any host that starts with docs.", () => {
    expect(at("docs.localhost", "").moved).toBe(true);
    expect(at("docs.next.zkb.fi", "").moved).toBe(true);
  });

  it("also applies to the host that inbrowser.link gives docs.zkb.fi", () => {
    expect(at("docs-zkb-fi.ipns.inbrowser.link", "").moved).toBe(true);
  });

  it("leaves a hash that names a place alone", () => {
    for (const hash of ["#/docs/safety", "#/bridge/eth-pls", "#/explore"]) {
      const { moved, replaceState } = at("docs.zkb.fi", hash);
      expect(moved).toBe(false);
      expect(replaceState).not.toHaveBeenCalled();
    }
  });

  it("leaves other hosts alone", () => {
    for (const host of ["zkb.fi", "next.zkb.fi", "localhost", "mydocs.zkb.fi", "docs", ""]) {
      const { moved, replaceState } = at(host, "");
      expect(moved).toBe(false);
      expect(replaceState).not.toHaveBeenCalled();
    }
  });
});
