import { canonicalManifestBytes } from "../src/manifest.ts";
import type { ReleaseManifest } from "../src/manifest.ts";

export const sampleManifest: ReleaseManifest = {
  schema: 1,
  sequence: 5,
  channels: { stable: "1.0.0" },
  releases: [
    { name: "dapp", version: "1.0.0", commit: "abc1234", cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", archiveSha256: "a".repeat(64), publishedAt: "2026-10-28T00:00:00Z" },
  ],
  downloads: [{ name: "terminal", platform: "linux-x64", file: "terminal-linux-x64", sha256: "c".repeat(64) }],
};

/** A release list signed before the docs moved into the dapp: it still names a separate docs site. */
export const legacyManifest: ReleaseManifest = {
  ...sampleManifest,
  releases: [
    ...sampleManifest.releases,
    { name: "docs", version: "1.0.0", commit: "abc1234", cid: "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku", archiveSha256: "b".repeat(64), publishedAt: "2026-10-28T00:00:00Z" },
  ],
};

export async function makeSigner(manifest: ReleaseManifest = sampleManifest) {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const manifestBytes = canonicalManifestBytes(manifest);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, manifestBytes as BufferSource));
  return { publicKey, manifestBytes, signature };
}
