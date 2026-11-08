// @vitest-environment node
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript Worker
import worker, { cidOfDnslink } from "../../../deploy/docs-redirect/worker.js";

const cid = "bafybeiggwi27xqoo5wu4wnzepydbqr5ipgqc7mbcntmbl3ymqyqdupkohe";
const dns = (data: string) => async () => new Response(JSON.stringify({ Answer: [{ data }] }), { status: 200 });
const call = (path: string, fetcher: unknown) => (worker as { fetch: (r: Request, e: unknown, c: unknown, f: unknown) => Promise<Response> }).fetch(new Request(`https://docs.zkb.fi${path}`), {}, {}, fetcher);

describe("docs.zkb.fi worker", () => {
  it("still redirects every other path to the browser loader", async () => {
    const response = await call("/", dns(`"dnslink=/ipfs/${cid}"`));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://docs-zkb-fi.ipns.inbrowser.link/");
  });
  it("sends llms.txt, llm.txt and llms-full.txt to the current dapp's file", async () => {
    for (const [path, file] of [["/llms.txt", "llms.txt"], ["/llm.txt", "llms.txt"], ["/llms-full.txt", "llms-full.txt"]]) {
      const response = await call(path as string, dns(`"dnslink=/ipfs/${cid}"`));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`https://${cid}.ipfs.zkb.fi/${file}`);
    }
  });
  it("answers 502 when the DNSLink cannot be read or holds no CID", async () => {
    expect((await call("/llms.txt", async () => { throw new Error("down"); })).status).toBe(502);
    expect((await call("/llms.txt", dns("nonsense"))).status).toBe(502);
  });
  it("accepts only a base32 CID from the record", () => {
    expect(cidOfDnslink(`"dnslink=/ipfs/${cid}"`)).toBe(cid);
    expect(cidOfDnslink('"dnslink=/ipfs/evil.example"')).toBeNull();
  });
});
