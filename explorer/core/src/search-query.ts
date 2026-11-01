/**
 * What a typed search text can be. Pure parsing, no I/O: the same rules run in the dapp's palette, in the indexer's
 * search route and on the indexer's page. `classifyQuery` returns every reading of the text, best first, and the
 * resolver of `@zkb/data` checks each reading against what it can read.
 */

/** One reading of a search text. Hex is lowercase; numbers are decimal text, so no precision is lost. */
export type QueryCandidate =
  /** 32 bytes: the identifier of a bridge message. */
  | { readonly kind: "message-id"; readonly hash: string }
  /** 32 bytes: a transaction hash (on a chain that the resolver picks). */
  | { readonly kind: "transaction"; readonly hash: string }
  /** 20 bytes: an account or a contract. */
  | { readonly kind: "address"; readonly address: string }
  /** The start of a hash or an address. */
  | { readonly kind: "hex-prefix"; readonly prefix: string }
  /** A symbol or a name of a token. */
  | { readonly kind: "symbol"; readonly text: string }
  /** A beacon slot. */
  | { readonly kind: "slot"; readonly value: string }
  /** An execution block number (on each chain). */
  | { readonly kind: "block"; readonly value: string }
  /** The number of a light client update (a proof). */
  | { readonly kind: "proof"; readonly value: string }
  /** A content identifier: a release on IPFS. */
  | { readonly kind: "cid"; readonly cid: string };

/** A kind of reading. */
export type QueryCandidateKind = QueryCandidate["kind"];

/** The result of {@link classifyQuery}. */
export type QueryClassification = {
  /** The text, trimmed. */
  readonly query: string;
  /** The readings, best first. Empty when the text is nothing that the search knows. */
  readonly candidates: readonly QueryCandidate[];
  /** Set when the text is a kind of name that the search does not resolve (ENS-like names). */
  readonly unsupported: "name" | null;
};

/** The longest text that is classified. */
export const MAXIMUM_QUERY_LENGTH = 200;

/** The fewest hex digits of a prefix that are searched. */
export const MINIMUM_PREFIX_DIGITS = 6;

/** Name suffixes that read as ENS-like names. They are not resolved. */
const NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(eth|pls|xyz|id|art|dao|crypto|box|kred|luxe)$/i;

const CID = /^(bafy[a-z2-7]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{40,})$/;
const SYMBOL = /^(?!\d+$)[A-Za-z0-9][A-Za-z0-9 .$_-]{0,39}$/;

/**
 * The order of the groups when results are ranked: an exact identifier beats an address, which beats a prefix, a token
 * symbol and a number.
 */
export const CANDIDATE_CLASS: Readonly<Record<QueryCandidateKind, number>> = {
  "message-id": 0,
  transaction: 0,
  cid: 0,
  address: 1,
  "hex-prefix": 2,
  symbol: 3,
  slot: 4,
  proof: 4,
  block: 4,
};

/**
 * Reads a search text. Hex may omit its `0x` when it has 64 or 40 digits (a hash pasted from a tool).
 *
 * @param text The text in a search field.
 */
export function classifyQuery(text: string): QueryClassification {
  const query = text.trim();
  const none = (unsupported: QueryClassification["unsupported"] = null): QueryClassification => ({ query, candidates: [], unsupported });
  if (query === "" || query.length > MAXIMUM_QUERY_LENGTH) return none();
  const hex = /^(?:0x)?([0-9a-fA-F]+)$/.exec(query);
  if (hex !== null) {
    const digits = (hex[1] as string).toLowerCase();
    const prefixed = query.toLowerCase().startsWith("0x");
    if (digits.length === 64) return { query, candidates: [{ kind: "message-id", hash: `0x${digits}` }, { kind: "transaction", hash: `0x${digits}` }], unsupported: null };
    if (digits.length === 40) return { query, candidates: [{ kind: "address", address: `0x${digits}` }], unsupported: null };
    if (prefixed) return digits.length >= MINIMUM_PREFIX_DIGITS && digits.length < 64 ? { query, candidates: [{ kind: "hex-prefix", prefix: `0x${digits}` }], unsupported: null } : none();
  }
  if (/^\d{1,18}$/.test(query)) {
    const value = BigInt(query).toString();
    return { query, candidates: [{ kind: "proof", value }, { kind: "slot", value }, { kind: "block", value }], unsupported: null };
  }
  if (CID.test(query)) return { query, candidates: [{ kind: "cid", cid: query }], unsupported: null };
  if (NAME.test(query)) return none("name");
  if (SYMBOL.test(query)) return { query, candidates: [{ kind: "symbol", text: query }], unsupported: null };
  return none();
}
