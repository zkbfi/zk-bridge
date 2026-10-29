import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A temporary directory that is removed after the test. */
export async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "zk-bridge-release-"));
  made.push(path);
  return path;
}

/** Writes each file of `files` (relative path to content) under `root`. */
export async function writeTree(root: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** A small site with relative asset paths, as the three real sites are built. */
export const sampleSite: Record<string, string> = {
  "index.html": `<!doctype html><html><head><link rel="stylesheet" href="./assets/style.css"><link rel="icon" href="data:,"></head>` +
    `<body><a href="#/help">help</a><a href="https://example.org/">out</a><script type="module" src="./assets/main.js"></script></body></html>`,
  "assets/style.css": "body { color: black; }\n",
  "assets/main.js": "console.log('hello');\n",
};

/** A throwaway Ed25519 key pair as JWK. Only tests make keys, and only in memory or a temporary directory. */
export async function throwawayKey(): Promise<{ privateKey: JsonWebKey; publicKey: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
    publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
  };
}

/** An in-memory stream of standard input. */
export async function* streamOf(...chunks: string[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield new TextEncoder().encode(chunk);
}
