import { describe, expect, it } from "vitest";
import { sanitize } from "../src/sanitize.ts";

describe("sanitize", () => {
  it("removes URLs of any scheme, known secrets and long tokens, and shortens the text", () => {
    expect(sanitize("failed to fetch https://rpc.example.org/v2/abc?key=1 and wss://x.example/ws")).toBe("failed to fetch [url] and [url]");
    expect(sanitize("bad hunter2-value here", ["hunter2-value"])).toBe("bad [redacted] here");
    expect(sanitize("token abcdefghijklmnopqrstuvwxyz0123456789 end")).toBe("token [redacted] end");
    expect(sanitize("a\n  b\tc")).toBe("a b c");
    expect(sanitize("x".repeat(400)).length).toBeLessThanOrEqual(200);
    expect(sanitize("x".repeat(30) + " y".repeat(150)).endsWith("...")).toBe(true);
  });

  it("keeps mode names, contract names, check ids, CIDs and public hashes readable", () => {
    expect(sanitize("not enforcing (mode detect-beacon-roots-and-registry)")).toBe("not enforcing (mode detect-beacon-roots-and-registry)");
    expect(sanitize("BeaconForkGateWithRegistryAndDetection reverted")).toBe("BeaconForkGateWithRegistryAndDetection reverted");
    expect(sanitize("see lightclient-first-to-second-and-then-some-more-words")).toBe("see lightclient-first-to-second-and-then-some-more-words");
    expect(sanitize("under /opt/zk-bridge/current/explorer/status/src/checks/x.ts")).toBe("under /opt/zk-bridge/current/explorer/status/src/checks/x.ts");
    const cidV1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    const cidV0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
    expect(sanitize(`dapp ${cidV1} and ${cidV0}`)).toBe(`dapp ${cidV1} and ${cidV0}`);
    const hash = "0x" + "ab12".repeat(16);
    expect(sanitize(`tx ${hash} from 0x${"cd".repeat(20)}`)).toBe(`tx ${hash} from 0x${"cd".repeat(20)}`);
    expect(sanitize(`file /ipfs/${hash}/x`)).toBe(`file /ipfs/${hash}/x`);
  });

  it("still hides keys in URLs, bearer tokens, long hex and long base64 secrets", () => {
    expect(sanitize("GET https://rpc.example.org/v2/abcdefghijklmnopqrstuvwxyz012345?apikey=x")).toBe("GET [url]");
    expect(sanitize("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789")).not.toContain("abcdefghijklmnop");
    expect(sanitize(`key ${"f0".repeat(24)} end`)).toBe("key [redacted] end");
    expect(sanitize("secret Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MDEyMzQ1Njc4OTA= end")).toBe("secret [redacted] end");
    expect(sanitize("secret Zm9vYmFy+bWF6cXV4MTIzNDU2Nzg5MDEyMzQ1/c4OTA end")).toBe("secret [redacted] end");
    expect(sanitize("secret abc/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MDEyMzQ1Njc4OTA end")).toBe("secret [redacted] end");
    expect(sanitize(`secret ${"A".repeat(20)}+${"b".repeat(20)} end`)).toBe("secret [redacted] end");
    expect(sanitize("path /home/user/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8/x ok")).toBe("path /home/user/[redacted]/x ok");
    expect(sanitize("path /home/user/token-abc123def456ghi789jkl012mno345pqr/x ok")).toBe("path /home/user/[redacted]/x ok");
  });
});
