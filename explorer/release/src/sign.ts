/**
 * Signs `version.json` with the release key.
 * The private key arrives on standard input at the moment of use and lives only in memory: nothing here writes it.
 */
import { canonicalManifestBytes, type ReleaseManifest } from "../../landing/src/manifest.ts";

/** Thrown when no usable signing key is given. The message never repeats the input. */
export class SignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignError";
  }
}

/**
 * Reads one Ed25519 private key in JWK form from a stream (standard input).
 * @throws SignError when nothing arrives or the text is not a private Ed25519 key.
 */
export async function readPrivateKey(stream: AsyncIterable<Uint8Array>): Promise<JsonWebKey> {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  const text = Buffer.concat(parts).toString("utf8").trim();
  if (text.length === 0) throw new SignError("no signing key arrived on standard input");
  let key: unknown;
  try {
    key = JSON.parse(text);
  } catch {
    throw new SignError("standard input is not a JSON Web Key");
  }
  if (typeof key !== "object" || key === null || Array.isArray(key)) throw new SignError("standard input is not a JSON Web Key");
  const jwk = key as JsonWebKey;
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string") {
    throw new SignError("standard input is not a private Ed25519 key");
  }
  return jwk;
}

/** The public half of a private JWK: what `public-keys.json` and the landing page hold. */
export function publicKeyOf(privateKey: JsonWebKey): JsonWebKey {
  return { kty: privateKey.kty!, crv: privateKey.crv!, x: privateKey.x! };
}

/**
 * Signs the canonical bytes of the manifest, the same bytes `version.json` holds.
 * @returns the 64-byte Ed25519 signature, written as `version.json.sig`.
 * @throws SignError when the key cannot sign.
 */
export async function signManifest(input: { manifest: ReleaseManifest; privateKey: JsonWebKey }): Promise<Uint8Array> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("jwk", input.privateKey, { name: "Ed25519" }, false, ["sign"]);
  } catch {
    throw new SignError("the key cannot sign: it is not a private Ed25519 key");
  }
  const bytes = canonicalManifestBytes(input.manifest);
  return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, bytes as BufferSource));
}
