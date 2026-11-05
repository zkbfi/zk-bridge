import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeHtml, findMalformedGateway, gatewayLinkList, loadLandingState, renderLanding } from "../src/page.ts";
import type { LandingConfig, LandingState } from "../src/page.ts";
import { parseManifest, canonicalManifestBytes } from "../src/manifest.ts";
import { legacyManifest, makeSigner, sampleManifest } from "./helpers.ts";

const gateways = ["https://one.example/ipfs/", "https://two.example/ipfs/", "https://three.example/ipfs/"];

function verified(manifest = sampleManifest, sequenceNote: string | null = null, gatewayList: readonly string[] = gateways): LandingState {
  return { kind: "verified", title: "T", manifest, gateways: gatewayList, downloadBaseUrl: "./downloads", sequenceNote };
}

test("a failed signature shows the warning and no link", () => {
  const html = renderLanding({ kind: "failed", title: "T", reason: "bad" });
  assert.ok(html.includes("Warning"));
  assert.ok(!html.includes("<a "));
});

test("a good manifest shows the dapp CID with at least three gateway links each, and every download with its SHA-256", () => {
  const html = renderLanding(verified());
  for (const release of sampleManifest.releases) {
    const links = html.match(new RegExp(`<a href="[^"]*${release.cid}"`, "g")) ?? [];
    assert.ok(links.length >= 3, `${release.name} has ${links.length} links`);
    assert.ok(html.includes(release.cid));
  }
  for (const download of sampleManifest.downloads) {
    assert.ok(html.includes(download.sha256));
    assert.ok(html.includes("./downloads/terminal-linux-x64"));
  }
});

test("fills {version} in the download address from the signed dapp release, URL-encoded", () => {
  const state = { ...verified(), downloadBaseUrl: "https://example.org/releases/download/v{version}" } as LandingState;
  const html = renderLanding(state);
  assert.ok(html.includes('href="https://example.org/releases/download/v1.0.0/terminal-linux-x64"'));
  const odd = { ...sampleManifest, releases: [{ ...sampleManifest.releases[0], version: "1.0 beta/2" }, ...sampleManifest.releases.slice(1)] };
  const oddHtml = renderLanding({ ...verified(odd), downloadBaseUrl: "https://example.org/v{version}" } as LandingState);
  assert.ok(oddHtml.includes('href="https://example.org/v1.0%20beta%2F2/terminal-linux-x64"'));
});

test("leaves {version} as written when the manifest has no dapp release", () => {
  const noDapp = { ...sampleManifest, releases: sampleManifest.releases.filter((release) => release.name !== "dapp") };
  const html = renderLanding({ ...verified(noDapp), downloadBaseUrl: "https://example.org/v{version}" } as LandingState);
  assert.ok(html.includes('href="https://example.org/v{version}/terminal-linux-x64"'));
});

test("escapes a version string holding <script>", () => {
  const hostile = { ...sampleManifest, releases: [{ ...sampleManifest.releases[0], version: "<script>x</script>" }] };
  const html = renderLanding(verified(hostile));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.equal(escapeHtml(`&"'<>`), "&amp;&quot;&#39;&lt;&gt;");
});

test("shows the loading text and the sequence note", () => {
  assert.ok(renderLanding({ kind: "loading", title: "T" }).includes("Checking"));
  assert.ok(renderLanding(verified(sampleManifest, "note here")).includes("note here"));
});

test("shows the notice of the page settings in every state, escaped, above the result", () => {
  const notice = "Maintenance <b>tonight</b>";
  for (const state of [{ kind: "loading", title: "T" } as LandingState, { kind: "failed", title: "T", reason: "bad" } as LandingState, verified()]) {
    const html = renderLanding(state, notice);
    assert.ok(html.includes('<p class="notice" role="note">Maintenance &lt;b&gt;tonight&lt;/b&gt;</p>'), state.kind);
    assert.ok(html.indexOf("notice") < html.indexOf(state.kind === "loading" ? "Checking" : state.kind === "failed" ? "Warning" : "signature"));
  }
  assert.ok(!renderLanding(verified()).includes('class="notice"'));
  assert.ok(!renderLanding(verified(), "  ").includes('class="notice"'));
});

async function withFetch<T>(files: Record<string, Uint8Array>, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) =>
    url in files
      ? new Response(files[url] as BodyInit)
      : new Response("no", { status: 404 })) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function configFor(publicKeys: JsonWebKey[]): LandingConfig {
  return { title: "T", manifestUrl: "m", signatureUrl: "s", downloadBaseUrl: "./d", gateways, publicKeys };
}

function storageWith(value: string | null) {
  return { getItem: () => value, setItem: () => {} };
}

test("loadLandingState verifies a signed manifest", async () => {
  const { publicKey, manifestBytes, signature } = await makeSigner();
  const state = await withFetch({ m: manifestBytes, s: signature }, () => loadLandingState(configFor([publicKey]), storageWith(null)));
  assert.equal(state.kind, "verified");
});

test("loadLandingState notes a browser that cannot remember", async () => {
  const { publicKey, manifestBytes, signature } = await makeSigner();
  const state = await withFetch({ m: manifestBytes, s: signature }, () => loadLandingState(configFor([publicKey]), null));
  assert.equal(state.kind === "verified" && state.sequenceNote !== null, true);
});

test("loadLandingState fails on a signature by a wrong key", async () => {
  const { manifestBytes, signature } = await makeSigner();
  const other = await makeSigner();
  const state = await withFetch({ m: manifestBytes, s: signature }, () => loadLandingState(configFor([other.publicKey]), null));
  assert.deepEqual(state, { kind: "failed", title: "T", reason: "The signature does not match any built-in release key." });
});

test("loadLandingState fails on a lower sequence and names the remembered one", async () => {
  const { publicKey, manifestBytes, signature } = await makeSigner();
  const state = await withFetch({ m: manifestBytes, s: signature }, () => loadLandingState(configFor([publicKey]), storageWith("99")));
  assert.deepEqual(state, {
    kind: "failed",
    title: "T",
    reason: "This list is older (number 5) than one this browser saw before (number 99).",
  });
});

test("loadLandingState fails when a file cannot be fetched", async () => {
  const { publicKey } = await makeSigner();
  const state = await withFetch({}, () => loadLandingState(configFor([publicKey]), null));
  assert.deepEqual(state, { kind: "failed", title: "T", reason: "could not fetch m (status 404)" });
});

test("loadLandingState fails on a signed manifest with an unsupported schema", async () => {
  const bad = { ...sampleManifest, schema: 2 } as unknown as typeof sampleManifest;
  const signer = await makeSigner(bad);
  const state = await withFetch({ m: signer.manifestBytes, s: signer.signature }, () =>
    loadLandingState(configFor([signer.publicKey]), null),
  );
  assert.deepEqual(state, { kind: "failed", title: "T", reason: "the manifest schema is not supported" });
});

test("a malformed gateway shows the failure warning and no link", async () => {
  const { publicKey, manifestBytes, signature } = await makeSigner();
  const config = { ...configFor([publicKey]), gateways: [...gateways, "not a web address"] };
  const state = await withFetch({ m: manifestBytes, s: signature }, () => loadLandingState(config, null));
  assert.equal(state.kind, "failed");
  const html = renderLanding(state);
  assert.ok(html.includes("Warning"));
  assert.ok(html.includes("not a web address"));
  assert.ok(!html.includes("<a "));
});

test("a gateway with another protocol is refused", () => {
  assert.equal(findMalformedGateway(["https://ok.example/ipfs/", "javascript:alert(1)"]), "javascript:alert(1)");
  assert.equal(findMalformedGateway(gateways), null);
});

test("gateway links prefer subdomain style", () => {
  const cid = sampleManifest.releases[0].cid;
  const mixed = ["https://path.example/ipfs/", "https://{cid}.ipfs.sub.example/", "https://other.example/ipfs/"];
  const links = gatewayLinkList(cid, mixed);
  assert.deepEqual(links, [
    { address: `https://${cid}.ipfs.sub.example/`, label: "ipfs.sub.example", sharedOrigin: false },
    { address: `https://path.example/ipfs/${cid}`, label: "path.example", sharedOrigin: true },
    { address: `https://other.example/ipfs/${cid}`, label: "other.example", sharedOrigin: true },
  ]);
  const html = renderLanding(verified(sampleManifest, null, mixed));
  assert.ok(html.indexOf(`https://${cid}.ipfs.sub.example/`) < html.indexOf(`https://path.example/ipfs/${cid}`));
  assert.equal((html.match(/shared origin/g) ?? []).length, 2);
});

test("a content address that cannot be a host label gets no subdomain link", () => {
  const links = gatewayLinkList("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", ["https://{cid}.ipfs.sub.example/", "https://path.example/ipfs/"]);
  assert.deepEqual(links.map((link) => link.label), ["path.example"]);
  assert.deepEqual(gatewayLinkList(`b${"a".repeat(63)}`, ["https://{cid}.ipfs.sub.example/"]), []);
});

test("a subdomain template passes the gateway check and a bad one does not", () => {
  assert.equal(findMalformedGateway(["https://{cid}.ipfs.sub.example/"]), null);
  assert.equal(findMalformedGateway(["ftp://{cid}.ipfs.sub.example/"]), "ftp://{cid}.ipfs.sub.example/");
});

test("the dapp has a Docs link at each gateway form: the dapp's #/docs, with a slash before the hash", () => {
  const html = renderLanding(verified(sampleManifest, null, ["https://one.example/ipfs/", "https://{cid}.ipfs.sub.example/"]));
  const cid = sampleManifest.releases[0]!.cid;
  assert.ok(html.includes(`<a href="https://${cid}.ipfs.sub.example/#/docs" rel="noopener">Docs</a>`));
  assert.ok(html.includes(`<a href="https://one.example/ipfs/${cid}/#/docs" rel="noopener">Docs</a>`));
  assert.equal(html.match(/>Docs<\/a>/g)?.length, 2);
});

test("a list signed before the docs moved into the dapp still reads, and lists the dapp only", () => {
  const parsed = parseManifest(new TextDecoder().decode(canonicalManifestBytes(legacyManifest)));
  assert.deepEqual(parsed.releases.map((release) => release.name), ["dapp", "docs"]);
  const html = renderLanding(verified(parsed));
  assert.ok(html.includes("<h2>dapp 1.0.0</h2>"));
  assert.ok(!html.includes("<h2>docs"));
  assert.ok(!html.includes(legacyManifest.releases[1]!.cid));
});
