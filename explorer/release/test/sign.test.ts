import { describe, expect, it } from "vitest";
import { canonicalManifestBytes, verifyManifestSignature } from "../../landing/src/manifest.ts";
import { writeManifest } from "../src/manifest-writer.ts";
import { publicKeyOf, readPrivateKey, SignError, signManifest } from "../src/sign.ts";
import { streamOf, throwawayKey } from "./helpers.ts";

const manifest = writeManifest({
  previous: null,
  releases: [
    { name: "landing", version: "1.0.0", commit: "abc1234", cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", archiveSha256: "a".repeat(64), publishedAt: "2026-10-28T00:00:00Z" },
  ],
  downloads: [],
});

describe("signManifest", () => {
  it("a signature from signManifest verifies with the landing page's check", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const signature = await signManifest({ manifest, privateKey });
    expect(signature.length).toBe(64);
    const manifestBytes = canonicalManifestBytes(manifest);
    expect(await verifyManifestSignature({ manifestBytes, signature, publicKeys: [publicKey] })).toBe(true);
    expect(await verifyManifestSignature({ manifestBytes, signature, publicKeys: [publicKeyOf(privateKey)] })).toBe(true);
  });

  it("refuses a key that cannot sign", async () => {
    const { publicKey } = await throwawayKey();
    await expect(signManifest({ manifest, privateKey: publicKey })).rejects.toThrow(SignError);
  });
});

describe("readPrivateKey", () => {
  it("reads one Ed25519 private key in JWK form, split over chunks", async () => {
    const { privateKey } = await throwawayKey();
    const text = JSON.stringify(privateKey);
    const read = await readPrivateKey(streamOf(text.slice(0, 10), text.slice(10), "\n"));
    expect(read).toEqual(privateKey);
  });

  it("refuses when nothing arrives", async () => {
    await expect(readPrivateKey(streamOf())).rejects.toThrow(/no signing key arrived on standard input/);
    await expect(readPrivateKey(streamOf("  \n"))).rejects.toThrow(/no signing key arrived on standard input/);
  });

  it("refuses text that is not a private Ed25519 key, without echoing it", async () => {
    await expect(readPrivateKey(streamOf("secret-not-json"))).rejects.toThrow(/not a JSON Web Key/);
    await expect(readPrivateKey(streamOf("secret-not-json"))).rejects.not.toThrow(/secret/);
    await expect(readPrivateKey(streamOf("[1]"))).rejects.toThrow(/not a JSON Web Key/);
    await expect(readPrivateKey(streamOf("null"))).rejects.toThrow(/not a JSON Web Key/);
    const { publicKey } = await throwawayKey();
    await expect(readPrivateKey(streamOf(JSON.stringify(publicKey)))).rejects.toThrow(/private Ed25519 key/);
    await expect(readPrivateKey(streamOf(JSON.stringify({ kty: "EC", crv: "P-256", d: "x", x: "y" })))).rejects.toThrow(
      /private Ed25519 key/,
    );
  });
});
