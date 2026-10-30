/**
 * Downloads chain (and listed token) icons from the image server once, at build time, into public/icons/, so the site
 * on IPFS never calls the image server for them. Every SVG must pass the allowlist in src/bridge/svg-check.ts (the
 * build fails, it never cleans and carries on), and every file's SHA-256 goes
 * in public/icons/icons.lock.json, so a rebuild is reproducible and a changed upstream image shows up in review.
 *
 *   node scripts/fetch-icons.ts            download what the lock lacks, verify what it has
 *   node scripts/fetch-icons.ts --refresh  download everything again
 *
 * The image server defaults to https://gib.show/image; set ICON_SERVER to use another with the same paths.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSvg, rasterKind } from "../src/bridge/svg-check.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "icons");
const lockPath = join(out, "icons.lock.json");
const server = (process.env.ICON_SERVER ?? "https://gib.show/image").replace(/\/$/, "");

/** Ethereum, PulseChain, Sepolia, PulseChain testnet v4. Tokens can be added as `<chainId>/<address>`. */
const WANTED: readonly string[] = ["1", "369", "11155111", "943"];

type Lock = Record<string, { file: string; sha256: string }>;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const lock: Lock = await readFile(lockPath, "utf8").then((text) => JSON.parse(text) as Lock, () => ({}));
const refresh = process.argv.includes("--refresh");
await mkdir(out, { recursive: true });

for (const key of WANTED) {
  const known = lock[key];
  if (known !== undefined && !refresh) {
    const bytes = new Uint8Array(await readFile(join(out, known.file)));
    if (sha256(bytes) !== known.sha256) throw new Error(`${known.file} does not match its hash in icons.lock.json`);
    // A shipped SVG is checked again on every build, so a tighter allowlist catches files already in the repository.
    if (known.file.endsWith(".svg")) {
      const reason = checkSvg(new TextDecoder().decode(bytes));
      if (reason !== null) throw new Error(`${known.file}: refused, ${reason}`);
    }
    continue;
  }
  const response = await fetch(`${server}/${key}`);
  if (!response.ok) throw new Error(`${key}: the image server answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const raster = rasterKind(bytes);
  let extension: string;
  if (raster !== null) extension = raster;
  else {
    const reason = checkSvg(new TextDecoder().decode(bytes));
    if (reason !== null) throw new Error(`${key}: refused, ${reason}`);
    extension = "svg";
  }
  const file = `${key.replace("/", "-").toLowerCase()}.${extension}`;
  await writeFile(join(out, file), bytes);
  lock[key] = { file, sha256: sha256(bytes) };
  console.log(`${key} -> ${file}`);
}

await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
