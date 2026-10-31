// docs.zkb.fi: a redirect only. The docs live on IPFS; _dnslink.docs.zkb.fi names the current docs CID (the release
// publish updates it), and inbrowser.link resolves that DNSLink and loads the docs in the browser, checking every block.
// Nothing is served from here, so this Worker holds no content and no trust.
const GATEWAY = "https://docs-zkb-fi.ipns.inbrowser.link";

export default {
  fetch(request) {
    const url = new URL(request.url);
    return Response.redirect(`${GATEWAY}${url.pathname}${url.search}`, 302);
  },
};
