import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeHtml, findMalformedGateway, loadLandingState, renderLanding } from "../src/page.ts";
import type { LandingConfig, LandingState } from "../src/page.ts";
import { makeSigner, sampleManifest } from "./helpers.ts";

const gateways = ["https://one.example/ipfs/", "https://two.example/ipfs/", "https://three.example/ipfs/"];

function verified(manifest = sampleManifest, sequenceNote: string | null = null): LandingState {
  return { kind: "verified", title: "T", manifest, gateways, downloadBaseUrl: "./downloads", sequenceNote };
}

test("a failed signature shows the warning and no link", () => {
  const html = renderLanding({ kind: "failed", title: "T", reason: "bad" });
  assert.ok(html.includes("Warning"));
  assert.ok(!html.includes("<a "));
});

test("a good manifest shows the dapp and docs CIDs with at least three gateway links each, and every download with its SHA-256", () => {
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
