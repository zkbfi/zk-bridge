/**
 * Checks that a site loads from its archive the way a gateway serves it: under `/ipfs/<cid>/`.
 * A site with a root path such as `/assets/x.js` works on its own domain and breaks under the prefix, so this catches it.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { exporter } from "ipfs-unixfs-exporter";
import { readArchive, type Archive } from "./car.ts";

const ATTRIBUTE = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const SKIPPED = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** The local `src` and `href` values of a page: no other origin, no anchor, no `data:` or `mailto:`. */
export function assetReferences(html: string): string[] {
  return [...html.matchAll(ATTRIBUTE)].map((match) => match[1] ?? match[2]!).filter((value) => !SKIPPED.test(value));
}

async function fileBytes(archive: Archive, path: string): Promise<Uint8Array | null> {
  try {
    const entry = await exporter(`${archive.root}/${path}`, archive.blockstore);
    if (entry.type !== "file" && entry.type !== "raw") return null;
    const parts: Uint8Array[] = [];
    for await (const part of entry.content()) parts.push(part as Uint8Array);
    return new Uint8Array(Buffer.concat(parts));
  } catch {
    return null;
  }
}

/**
 * Serves the archive on a local port under `/ipfs/<cid>/`, fetches `index.html` and every asset it names.
 * @returns one line per failed fetch; empty when the site loads.
 */
export async function siteLoadProblems(carBytes: Uint8Array): Promise<string[]> {
  const archive = await readArchive(carBytes);
  const prefix = `/ipfs/${archive.root}/`;
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://local").pathname;
    const inside = path.startsWith(prefix) ? decodeURIComponent(path.slice(prefix.length)) : null;
    void (inside === null ? Promise.resolve(null) : fileBytes(archive, inside || "index.html")).then((bytes) => {
      response.writeHead(bytes === null ? 404 : 200);
      response.end(bytes ?? undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${prefix}`;
    const index = await fetch(new URL("index.html", base));
    if (!index.ok) return [`index.html gave ${index.status}`];
    const problems: string[] = [];
    for (const reference of assetReferences(await index.text())) {
      const answer = await fetch(new URL(reference, base));
      await answer.arrayBuffer();
      if (!answer.ok) problems.push(`${reference} gave ${answer.status}`);
    }
    return problems;
  } finally {
    server.close();
  }
}
