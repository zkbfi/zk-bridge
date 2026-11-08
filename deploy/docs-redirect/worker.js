// docs.zkb.fi: a redirect only. The docs are part of the dapp (they load lazily at #/docs); _dnslink.docs.zkb.fi names the current
// DAPP CID (sites.yml -e docs_cid=<dapp cid>), and inbrowser.link resolves that DNSLink and loads the dapp in the browser,
// checking every block. The dapp sends the empty address of a docs host to #/docs (explorer/web/src/app/docs-host.ts).
// Nothing is served from here, so this Worker holds no content and no trust.
//
// One exception to "everything goes to the browser loader": the text files for LLMs (llmstxt.org). /llms.txt and /llms-full.txt
// redirect to the same file of the current dapp at https://<cid>.ipfs.zkb.fi/, where the CID is the one the DNSLink names
// (read over DNS-over-HTTPS at request time). /llm.txt is the same as /llms.txt. The inbrowser.link loader cannot serve a
// plain file to a program, so these paths do not go there. The #/docs redirect for every other path is unchanged.
const GATEWAY = "https://docs-zkb-fi.ipns.inbrowser.link";
const DNSLINK_NAME = "_dnslink.docs.zkb.fi";
const DOH = "https://cloudflare-dns.com/dns-query";
const TEXT_FILES = { "/llms.txt": "llms.txt", "/llm.txt": "llms.txt", "/llms-full.txt": "llms-full.txt" };
const CID = /^[a-z2-7]{20,120}$/;

/** The CID in a DNSLink TXT record such as `dnslink=/ipfs/<cid>`, or null. */
export function cidOfDnslink(data) {
  const match = /^"?dnslink=\/ipfs\/([A-Za-z0-9]+)"?$/.exec(String(data).trim());
  const cid = match === null ? "" : match[1].toLowerCase();
  return CID.test(cid) ? cid : null;
}

async function currentCid(fetcher) {
  const response = await fetcher(`${DOH}?name=${DNSLINK_NAME}&type=TXT`, { headers: { accept: "application/dns-json" } });
  if (!response.ok) return null;
  const answer = (await response.json()).Answer ?? [];
  for (const record of answer) {
    const cid = cidOfDnslink(record.data);
    if (cid !== null) return cid;
  }
  return null;
}

export default {
  async fetch(request, _env, _context, fetcher = fetch) {
    const url = new URL(request.url);
    const file = TEXT_FILES[url.pathname];
    if (file !== undefined) {
      let cid = null;
      try {
        cid = await currentCid(fetcher);
      } catch {
        cid = null;
      }
      if (cid === null) return new Response("The current docs release could not be resolved. Try again shortly.\n", { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
      return Response.redirect(`https://${cid}.ipfs.zkb.fi/${file}`, 302);
    }
    return Response.redirect(`${GATEWAY}${url.pathname}${url.search}`, 302);
  },
};
