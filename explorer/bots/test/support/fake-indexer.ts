import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import type { FeedItem } from "../../src/indexer/client.ts";

/** An indexer in this process. It serves the two routes that the runner reads, with the shapes of `explorer/indexer/README.md`. */
export interface FakeIndexer {
  readonly url: string;
  /** The covered items it lists. The test changes the array. */
  readonly items: FeedItem[];
  /** The call data by message identifier. */
  readonly data: Record<string, Hex>;
  /** The proof archive: entries by path, such as `/api/proofs/storage/1/0x.../900`. Other paths answer 404. */
  readonly storageProofs: Record<string, unknown[]>;
  /** The paths it was asked, in order. */
  readonly requested: string[];
  stop(): Promise<void>;
}

/** Starts the fake indexer on a free port. */
export async function startFakeIndexer(): Promise<FakeIndexer> {
  const items: FeedItem[] = [];
  const data: Record<string, Hex> = {};
  const storageProofs: Record<string, unknown[]> = {};
  const requested: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requested.push(url.pathname);
    response.setHeader("content-type", "application/json");
    const archived = storageProofs[url.pathname];
    if (archived !== undefined) {
      response.end(JSON.stringify({ entries: archived }));
      return;
    }
    if (url.pathname === "/api/feed") {
      const statuses = (url.searchParams.get("status") ?? "").split(",");
      response.end(JSON.stringify({ items: items.filter((item) => statuses.includes(item.status)), nextCursor: null }));
      return;
    }
    const message = /^\/api\/messages\/(0x[0-9a-f]+)$/.exec(url.pathname);
    const found = message === null ? undefined : items.find((item) => item.messageId === message[1]);
    if (found === undefined) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    response.end(JSON.stringify({ ...found, data: data[found.messageId] ?? "0x" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    items,
    data,
    storageProofs,
    requested,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
