// docs.zkb.fi: a redirect only. The docs are part of the dapp (they load lazily at #/docs); _dnslink.docs.zkb.fi names the current
// DAPP CID (sites.yml -e docs_cid=<dapp cid>), and inbrowser.link resolves that DNSLink and loads the dapp in the browser,
// checking every block. The dapp sends the empty address of a docs host to #/docs (explorer/web/src/app/docs-host.ts).
// Nothing is served from here, so this Worker holds no content and no trust.
const GATEWAY = "https://docs-zkb-fi.ipns.inbrowser.link";

export default {
  fetch(request) {
    const url = new URL(request.url);
    return Response.redirect(`${GATEWAY}${url.pathname}${url.search}`, 302);
  },
};
