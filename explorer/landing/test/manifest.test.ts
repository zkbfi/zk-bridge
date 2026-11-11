import assert from "node:assert/strict";
import { test } from "vitest";
import { canonicalManifestBytes, ManifestError, parseManifest, verifyManifestSignature } from "../src/manifest.ts";
import { makeSigner, sampleManifest } from "./helpers.ts";

test("accepts a manifest signed by a built-in key", async () => {
  const { publicKey, manifestBytes, signature } = await makeSigner();
  assert.equal(await verifyManifestSignature({ manifestBytes, signature, publicKeys: [publicKey] }), true);
});

test("refuses a manifest with one changed byte", async () => {
  const { publicKey, manifestBytes, signature } = await makeSigner();
  const changed = manifestBytes.slice();
  changed[10] ^= 1;
  assert.equal(await verifyManifestSignature({ manifestBytes: changed, signature, publicKeys: [publicKey] }), false);
});

test("refuses a signature by an unknown key", async () => {
  const signed = await makeSigner();
  const other = await makeSigner();
  assert.equal(
    await verifyManifestSignature({ manifestBytes: signed.manifestBytes, signature: signed.signature, publicKeys: [other.publicKey] }),
    false,
  );
  assert.equal(await verifyManifestSignature({ manifestBytes: signed.manifestBytes, signature: signed.signature, publicKeys: [] }), false);
});

test("accepts when only the second listed key matches", async () => {
  const signed = await makeSigner();
  const other = await makeSigner();
  assert.equal(
    await verifyManifestSignature({ manifestBytes: signed.manifestBytes, signature: signed.signature, publicKeys: [other.publicKey, signed.publicKey] }),
    true,
  );
});

test("a key that cannot load does not verify", async () => {
  const { manifestBytes, signature } = await makeSigner();
  assert.equal(await verifyManifestSignature({ manifestBytes, signature, publicKeys: [{ kty: "bad" }] }), false);
});

test("parseManifest refuses schema 2", () => {
  assert.throws(() => parseManifest(JSON.stringify({ ...sampleManifest, schema: 2 })), ManifestError);
});

test("parseManifest reads a good manifest and refuses bad shapes", () => {
  assert.deepEqual(parseManifest(JSON.stringify(sampleManifest)), sampleManifest);
  assert.throws(() => parseManifest("not json"), ManifestError);
  assert.throws(() => parseManifest("[]"), ManifestError);
  assert.throws(() => parseManifest(JSON.stringify({ ...sampleManifest, sequence: -1 })), ManifestError);
  assert.throws(() => parseManifest(JSON.stringify({ ...sampleManifest, releases: "x" })), ManifestError);
  assert.throws(() => parseManifest(JSON.stringify({ ...sampleManifest, channels: { a: "" } })), ManifestError);
  const badName = { ...sampleManifest, releases: [{ ...sampleManifest.releases[0], name: "other" }] };
  assert.throws(() => parseManifest(JSON.stringify(badName)), ManifestError);
  const badCid = { ...sampleManifest, releases: [{ ...sampleManifest.releases[0], cid: "a/../b" }] };
  assert.throws(() => parseManifest(JSON.stringify(badCid)), ManifestError);
  const badHash = { ...sampleManifest, downloads: [{ ...sampleManifest.downloads[0], sha256: "zz" }] };
  assert.throws(() => parseManifest(JSON.stringify(badHash)), ManifestError);
  const badDownload = { ...sampleManifest, downloads: [1] };
  assert.throws(() => parseManifest(JSON.stringify(badDownload)), ManifestError);
});

test("canonical bytes do not depend on key order", () => {
  const reordered = parseManifest(
    JSON.stringify({ downloads: sampleManifest.downloads, releases: sampleManifest.releases, channels: sampleManifest.channels, sequence: 5, schema: 1 }),
  );
  assert.deepEqual(canonicalManifestBytes(reordered), canonicalManifestBytes(sampleManifest));
  const text = new TextDecoder().decode(canonicalManifestBytes(sampleManifest));
  assert.ok(text.startsWith('{"channels":'));
  assert.ok(!text.includes(" "));
});

test("reads the size of a download and refuses a size that is not a whole number of bytes", () => {
  const withSize = (size: unknown) => JSON.stringify({ ...sampleManifest, downloads: [{ ...sampleManifest.downloads[0], size }] });
  assert.equal(parseManifest(withSize(1234)).downloads[0]?.size, 1234);
  assert.equal(parseManifest(withSize(0)).downloads[0]?.size, 0);
  assert.equal("size" in (parseManifest(JSON.stringify(sampleManifest)).downloads[0] ?? {}), false);
  for (const bad of ["12", -1, 1.5, 2 ** 60, null]) {
    assert.throws(() => parseManifest(withSize(bad)), /downloads\[0\]\.size must be a whole number of bytes/, String(bad));
  }
});

test("the signed bytes list keys in order whatever the order they were written in", () => {
  const shuffled = { sequence: 5, schema: 1, downloads: [], releases: [], channels: { b: "2", a: "1" } };
  assert.equal(new TextDecoder().decode(canonicalManifestBytes(shuffled as never)), '{"channels":{"a":"1","b":"2"},"downloads":[],"releases":[],"schema":1,"sequence":5}');
});
