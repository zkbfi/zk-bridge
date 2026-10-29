import { z } from "zod";
import type { Pair, ProofDirection } from "@zk-bridge/shared";

/** How long one call to the chain indexer may take before the request is refused, in milliseconds. */
export const PROOF_NEED_TIMEOUT_MILLISECONDS = 5_000;

/**
 * Whether a direction needs a new proof, and why. A request only asks: the backend starts a paid proving run only when
 * the chain indexer shows that the chains need one.
 *
 * - `waiting-message`: a message of the direction is old enough to be final, and no stored head covers it.
 * - `keep-alive`: the light client of the destination holds no head, or a head older than the keep-alive time. A light
 *   client that falls more than one sync committee period behind can never move again.
 */
export type ProofNeed = { readonly needed: true; readonly why: "waiting-message" | "keep-alive" } | { readonly needed: false };

/**
 * Reads the need of a direction. `now` is in milliseconds since 1970.
 *
 * @throws When the chain indexer fails, answers too late, or answers a shape that the reader does not know.
 */
export type ProofNeedReader = (direction: ProofDirection, now: number) => Promise<ProofNeed>;

/** The reader of a backend that names no chain indexer. Only a backend without the requests module has it. */
export const withoutIndexer: ProofNeedReader = async () => {
  throw new Error("indexerUrl is not set");
};

const feedSchema =z.object({ items: z.array(z.unknown()) });

const headsSchema = z.object({
  heads: z.array(
    z.object({
      chainId: z.number().int(),
      trackedChainId: z.number().int(),
      storedHeadSlot: z.number().nullable(),
      storedHeadExecutionTimestamp: z.number().nullable(),
    }),
  ),
});

/**
 * Builds the reader over the chain indexer.
 *
 * @param input.baseUrl The address of the chain indexer.
 * @param input.pair The pair. The first side is the source of `first-to-second`.
 * @param input.keepAliveSeconds The age of the destination head, in seconds, after which a proof is needed anyway.
 * @param input.timeoutMilliseconds How long one call may take. The default is {@link PROOF_NEED_TIMEOUT_MILLISECONDS}.
 * @param input.fetchFunction The fetch function. The default is the global one, read at call time.
 */
export function createProofNeedReader(input: {
  baseUrl: string;
  pair: Pair;
  keepAliveSeconds: number;
  timeoutMilliseconds?: number;
  fetchFunction?: () => typeof fetch;
}): ProofNeedReader {
  const base = input.baseUrl.replace(/\/+$/, "");
  const timeout = input.timeoutMilliseconds ?? PROOF_NEED_TIMEOUT_MILLISECONDS;
  const fetchFunction = input.fetchFunction ?? (() => globalThis.fetch);

  async function read<Schema extends z.ZodType>(path: string, schema: Schema, what: string): Promise<z.infer<Schema>> {
    const answer = await fetchFunction()(`${base}${path}`, { signal: AbortSignal.timeout(timeout) });
    if (!answer.ok) throw new Error(`the chain indexer answered ${answer.status} for ${what}`);
    const parsed = schema.safeParse(await answer.json());
    if (!parsed.success) throw new Error(`the chain indexer sent ${what} in an unknown shape`);
    return parsed.data;
  }

  return async (direction, now) => {
    const [first, second] = input.pair.sides;
    const [source, destination] = direction === "first-to-second" ? [first, second] : [second, first];
    const query = new URLSearchParams({ direction: `${source.chainId}>${destination.chainId}`, status: "waiting_for_finality", limit: "1" });
    const [feed, heads] = await Promise.all([read(`/api/feed?${query}`, feedSchema, "the feed"), read("/api/heads", headsSchema, "the heads")]);
    if (feed.items.length > 0) return { needed: true, why: "waiting-message" };
    const head = heads.heads.find((entry) => entry.chainId === destination.chainId && entry.trackedChainId === source.chainId);
    if (head === undefined) throw new Error(`the chain indexer knows no light client on chain ${destination.chainId}`);
    const headTime = head.storedHeadSlot === null ? null : head.storedHeadExecutionTimestamp;
    if (headTime === null || now / 1000 - headTime > input.keepAliveSeconds) return { needed: true, why: "keep-alive" };
    return { needed: false };
  };
}
