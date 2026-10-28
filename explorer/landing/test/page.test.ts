import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeHtml, loadLandingState, renderLanding } from "../src/page.ts";
import type { LandingConfig, LandingState } from "../src/page.ts";
import { canonicalManifestBytes } from "../src/manifest.ts";
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
    const links = html.split(`${release.cid}"`).length - 1;
    assert.ok(links >= 3, `${release.name} has ${links} links`);
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

test("loadLandingState fails on a wrong key, a lower sequence, a missing file and a bad manifest", async () => {
  const { publicKey, manifestBytes, signature } = await makeSigner();
  const other = await makeSigner();
  const files = { m: manifestBytes, s: signature };
  assert.equal((await withFetch(files, () => loadLandingState(configFor([other.publicKey]), null))).kind, "failed");
  const lower = await withFetch(files, () => loadLandingState(configFor([publicKey]), storageWith("99")));
  assert.equal(lower.kind === "failed" && lower.reason.includes("99"), true);
  assert.equal((await withFetch({}, () => loadLandingState(configFor([publicKey]), null))).kind, "failed");
  const bad = { ...sampleManifest, schema: 2 } as unknown as typeof sampleManifest;
  const badSigner = await makeSigner(bad);
  const badState = await withFetch({ m: badSigner.manifestBytes, s: badSigner.signature }, () =>
    loadLandingState(configFor([badSigner.publicKey]), null),
  );
  assert.equal(badState.kind, "failed");
  assert.ok(canonicalManifestBytes(sampleManifest).length > 0);
});
