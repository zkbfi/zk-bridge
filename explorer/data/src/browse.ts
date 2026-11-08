/**
 * The browse API of the indexer: all-time counts (`GET /api/counts`) and the paged, filtered, sorted lists
 * (`GET /api/browse/messages`, `/proofs`, `/tokens`, `/addresses`). This file holds both ends of the contract: the
 * parsers of the query strings that the indexer reads, and the builders and strict parsers of the web client.
 *
 * A page is `limit` rows from `offset`, the `total` rows that match, and `asOf`. A request that names `asOf` sees only
 * rows sent at or before that second, so rows that arrive while a reader pages through do not move the pages.
 */
import type { Address, Hex } from "viem";
import { normalizeAddress } from "@zkb/core";
import { parseDirection } from "./feed-query.js";
import { IN_FLIGHT_STATUSES, MESSAGE_STATUSES, type MessageStatus } from "./status.js";

/** The page size when a request names none. */
export const BROWSE_PAGE_SIZE = 50;
/** The largest page. */
export const MAX_BROWSE_LIMIT = 200;
/** The largest offset a request may name. */
export const MAX_BROWSE_OFFSET = 10_000_000;

export const MESSAGE_SORTS = ["newest", "oldest", "amount-high", "amount-low"] as const;
export const PROOF_SORTS = ["newest", "oldest", "slot-high", "slot-low"] as const;
export const TOKEN_SORTS = ["symbol", "transfers"] as const;
export const ADDRESS_SORTS = ["activity", "recent"] as const;
export const ADDRESS_ROLES = ["sender", "recipient", "poster"] as const;
export const TOKEN_KINDS = ["native", "copy"] as const;

export type MessageSort = (typeof MESSAGE_SORTS)[number];
export type ProofSort = (typeof PROOF_SORTS)[number];
export type TokenSort = (typeof TOKEN_SORTS)[number];
export type AddressSort = (typeof ADDRESS_SORTS)[number];
export type AddressRole = (typeof ADDRESS_ROLES)[number];
export type TokenKind = (typeof TOKEN_KINDS)[number];

/** The window of a page, shared by every list. */
type Window = { readonly limit: number; readonly offset: number };

/** What the message list asks for, parsed. */
export type BrowseMessagesQuery = Window & {
  readonly direction: { readonly sourceChainId: number; readonly destinationChainId: number } | null;
  readonly kind: "token" | "message" | null;
  /** Empty means every status. */
  readonly statuses: readonly MessageStatus[];
  readonly token: Address | null;
  /** The account that sent the tokens, or the sender of a plain message. */
  readonly sender: Address | null;
  /** The account that receives the tokens, or is paid. */
  readonly recipient: Address | null;
  /** The sender, executor, recipient or payee. */
  readonly address: Address | null;
  readonly from: bigint | null;
  readonly to: bigint | null;
  readonly sort: MessageSort;
  readonly asOf: bigint | null;
};

/** What the proof list asks for, parsed. */
export type BrowseProofsQuery = Window & {
  /** The chain the light client is on. */
  readonly chainId: number | null;
  readonly poster: Address | null;
  readonly from: bigint | null;
  readonly to: bigint | null;
  readonly sort: ProofSort;
  readonly asOf: bigint | null;
};

/** What the token list asks for, parsed. */
export type BrowseTokensQuery = Window & {
  readonly chainId: number | null;
  readonly kind: TokenKind | null;
  readonly sort: TokenSort;
};

/** What the address list asks for, parsed. */
export type BrowseAddressesQuery = Window & {
  readonly role: AddressRole | null;
  /** A lowercase hex prefix, without `0x`. */
  readonly prefix: string | null;
  readonly sort: AddressSort;
};

type Parsed<T> = { readonly ok: true; readonly query: T } | { readonly ok: false; readonly problem: string };

const bad = (name: string, value: string | null): { readonly ok: false; readonly problem: string } => ({ ok: false, problem: `invalid ${name}: ${value}` });

const windowOf = (params: URLSearchParams): Window | { readonly bad: string } => {
  const limitText = params.get("limit");
  const limit = limitText === null ? BROWSE_PAGE_SIZE : /^\d+$/.test(limitText) ? Number(limitText) : 0;
  if (limit < 1 || limit > MAX_BROWSE_LIMIT) return { bad: "limit" };
  const offsetText = params.get("offset");
  const offset = offsetText === null ? 0 : /^\d+$/.test(offsetText) ? Number(offsetText) : -1;
  if (offset < 0 || offset > MAX_BROWSE_OFFSET) return { bad: "offset" };
  return { limit, offset };
};

const seconds = (params: URLSearchParams, name: string): bigint | null | "bad" => {
  const text = params.get(name);
  if (text === null) return null;
  return /^\d{1,15}$/.test(text) ? BigInt(text) : "bad";
};

const addressParam = (params: URLSearchParams, name: string): Address | null | "bad" => {
  const text = params.get(name);
  if (text === null) return null;
  try {
    return normalizeAddress(text);
  } catch {
    return "bad";
  }
};

const choice = <T extends string>(params: URLSearchParams, name: string, allowed: readonly T[]): T | null | "bad" => {
  const text = params.get(name);
  if (text === null) return null;
  return (allowed as readonly string[]).includes(text) ? (text as T) : "bad";
};

const chainParam = (params: URLSearchParams, name: string): number | null | "bad" => {
  const text = params.get(name);
  if (text === null) return null;
  return /^\d{1,12}$/.test(text) ? Number(text) : "bad";
};

/** `status=inflight` stands for the three statuses of a message that is not final. */
const statusesOf = (text: string | null): readonly MessageStatus[] | "bad" => {
  if (text === null) return [];
  const names = text.split(",").filter((name) => name !== "").flatMap((name) => (name === "inflight" ? [...IN_FLIGHT_STATUSES] : [name]));
  if (!names.every((name) => (MESSAGE_STATUSES as readonly string[]).includes(name))) return "bad";
  return [...new Set(names)] as MessageStatus[];
};

/**
 * Parses the query of `GET /api/browse/messages`: `direction` (`1>369`), `kind` (`token` or `message`), `status` (a comma
 * list; `inflight` stands for sent, waiting_for_finality and covered), `token`, `sender`, `recipient`, `address`,
 * `from`, `to` (Unix seconds), `sort` (newest, oldest, amount-high, amount-low), `limit`, `offset` and `asOf`.
 */
export const parseBrowseMessagesQuery = (params: URLSearchParams): Parsed<BrowseMessagesQuery> => {
  const window = windowOf(params);
  if ("bad" in window) return bad(window.bad, params.get(window.bad));
  const directionText = params.get("direction");
  const direction = directionText === null ? null : (parseDirection(directionText) ?? "bad");
  if (direction === "bad") return bad("direction", directionText);
  const kind = choice(params, "kind", ["token", "message"] as const);
  if (kind === "bad") return bad("kind", params.get("kind"));
  const statuses = statusesOf(params.get("status"));
  if (statuses === "bad") return bad("status", params.get("status"));
  const sort = choice(params, "sort", MESSAGE_SORTS);
  if (sort === "bad") return bad("sort", params.get("sort"));
  const addresses = (["token", "sender", "recipient", "address"] as const).map((name) => addressParam(params, name));
  const badAddress = (["token", "sender", "recipient", "address"] as const).find((_, index) => addresses[index] === "bad");
  if (badAddress !== undefined) return bad(badAddress, params.get(badAddress));
  const times = (["from", "to", "asOf"] as const).map((name) => seconds(params, name));
  const badTime = (["from", "to", "asOf"] as const).find((_, index) => times[index] === "bad");
  if (badTime !== undefined) return bad(badTime, params.get(badTime));
  const [token, sender, recipient, address] = addresses as (Address | null)[];
  const [from, to, asOf] = times as (bigint | null)[];
  return {
    ok: true,
    query: { ...window, direction, kind, statuses, token: token ?? null, sender: sender ?? null, recipient: recipient ?? null, address: address ?? null, from: from ?? null, to: to ?? null, sort: sort ?? "newest", asOf: asOf ?? null },
  };
};

/** Parses the query of `GET /api/browse/proofs`: `chainId`, `poster`, `from`, `to`, `sort` (newest, oldest, slot-high, slot-low), `limit`, `offset`, `asOf`. */
export const parseBrowseProofsQuery = (params: URLSearchParams): Parsed<BrowseProofsQuery> => {
  const window = windowOf(params);
  if ("bad" in window) return bad(window.bad, params.get(window.bad));
  const chainId = chainParam(params, "chainId");
  if (chainId === "bad") return bad("chainId", params.get("chainId"));
  const poster = addressParam(params, "poster");
  if (poster === "bad") return bad("poster", params.get("poster"));
  const sort = choice(params, "sort", PROOF_SORTS);
  if (sort === "bad") return bad("sort", params.get("sort"));
  const times = (["from", "to", "asOf"] as const).map((name) => seconds(params, name));
  const badTime = (["from", "to", "asOf"] as const).find((_, index) => times[index] === "bad");
  if (badTime !== undefined) return bad(badTime, params.get(badTime));
  const [from, to, asOf] = times as (bigint | null)[];
  return { ok: true, query: { ...window, chainId, poster, from: from ?? null, to: to ?? null, sort: sort ?? "newest", asOf: asOf ?? null } };
};

/** Parses the query of `GET /api/browse/tokens`: `chainId`, `kind` (native or copy), `sort` (symbol or transfers), `limit`, `offset`. */
export const parseBrowseTokensQuery = (params: URLSearchParams): Parsed<BrowseTokensQuery> => {
  const window = windowOf(params);
  if ("bad" in window) return bad(window.bad, params.get(window.bad));
  const chainId = chainParam(params, "chainId");
  if (chainId === "bad") return bad("chainId", params.get("chainId"));
  const kind = choice(params, "kind", TOKEN_KINDS);
  if (kind === "bad") return bad("kind", params.get("kind"));
  const sort = choice(params, "sort", TOKEN_SORTS);
  if (sort === "bad") return bad("sort", params.get("sort"));
  return { ok: true, query: { ...window, chainId, kind, sort: sort ?? "symbol" } };
};

/** Parses the query of `GET /api/browse/addresses`: `role` (sender, recipient or poster), `q` (a hex prefix), `sort` (activity or recent), `limit`, `offset`. */
export const parseBrowseAddressesQuery = (params: URLSearchParams): Parsed<BrowseAddressesQuery> => {
  const window = windowOf(params);
  if ("bad" in window) return bad(window.bad, params.get(window.bad));
  const role = choice(params, "role", ADDRESS_ROLES);
  if (role === "bad") return bad("role", params.get("role"));
  const sort = choice(params, "sort", ADDRESS_SORTS);
  if (sort === "bad") return bad("sort", params.get("sort"));
  const text = params.get("q");
  const prefix = text === null ? null : text.replace(/^0x/i, "").toLowerCase();
  if (prefix !== null && !/^[0-9a-f]{1,40}$/.test(prefix)) return bad("q", text);
  return { ok: true, query: { ...window, role, prefix, sort: sort ?? "activity" } };
};

// The client ---------------------------------------------------------------------------------------------------------

/** The error of a browse answer that is not what the client expects. */
export class BrowseError extends Error {
  override readonly name = "BrowseError";
}

/** A request value: what the web sends, as plain text and numbers. */
export type BrowseRequest = Readonly<Record<string, string | number | bigint | readonly string[] | null | undefined>>;

/**
 * The query string of a request. A missing value, an empty list and empty text are left out; a list joins with commas.
 */
export const browseParams = (request: BrowseRequest): URLSearchParams => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(request)) {
    if (value === undefined || value === null) continue;
    const text = typeof value === "object" ? value.join(",") : String(value);
    if (text !== "") params.set(name, text);
  }
  return params;
};

/** One page of a list. */
export type BrowsePage<T> = { readonly items: readonly T[]; readonly total: number; readonly limit: number; readonly offset: number; readonly asOf: number };

/** A message or transfer in the list. */
export type BrowseMessage = {
  readonly id: Hex;
  readonly kind: "token" | "message";
  readonly status: MessageStatus;
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly sender: Address | null;
  readonly recipient: Address | null;
  readonly token: { readonly chainId: number; readonly address: Address; readonly symbol: string | null; readonly decimals: number | null } | null;
  /** In base units of `token`. */
  readonly amount: bigint | null;
  /** The token on the destination chain, in which `fee` and `received` are counted. */
  readonly destinationToken: { readonly chainId: number; readonly address: Address; readonly symbol: string | null; readonly decimals: number | null } | null;
  /** The delivery fee to the deliverer, when a delivery router delivered and the fee is known. */
  readonly fee: bigint | null;
  /** What the recipient received after the fee, when known. */
  readonly received: bigint | null;
  /** Where the fee was read: `event`, `logs` or `terms`. */
  readonly feeSource: string | null;
  readonly sentAt: number | null;
  readonly deliveredAt: number | null;
  readonly sourceTransactionHash: Hex | null;
};

/** A light-client update in the list. `number` counts the updates of its chain from 1, oldest first. */
export type BrowseProof = {
  readonly number: number;
  readonly chainId: number;
  readonly slot: bigint;
  readonly timestamp: number;
  readonly transactionHash: Hex;
  readonly poster: Address;
  readonly costWei: bigint;
};

/** A token in the list, with the transfers that name it. */
export type BrowseToken = {
  readonly chainId: number;
  readonly address: Address;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly decimals: number | null;
  readonly isBridgedCopy: boolean;
  readonly transfers: number;
};

/** An address in the list, with what it did. */
export type BrowseAddress = { readonly address: Address; readonly sent: number; readonly received: number; readonly posted: number; readonly lastActive: number | null };

/** All-time counts. */
export type BrowseCounts = {
  readonly asOf: number;
  readonly messages: {
    readonly total: number;
    readonly inFlight: number;
    readonly transfers: number;
    readonly plain: number;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly directions: readonly { readonly sourceChainId: number; readonly destinationChainId: number; readonly total: number; readonly inFlight: number }[];
  };
  readonly lightClientUpdates: { readonly total: number; readonly chains: readonly { readonly chainId: number; readonly count: number }[] };
  readonly addresses: { readonly total: number; readonly senders: number; readonly recipients: number; readonly posters: number };
  readonly tokens: { readonly total: number; readonly chains: readonly { readonly chainId: number; readonly total: number; readonly native: number; readonly copies: number }[] };
  readonly contracts: number;
  readonly gates: { readonly total: number; readonly open: number };
  readonly escrow: { readonly entries: number };
};

type Json = Record<string, unknown>;
const fail = (what: string, expected: string): never => {
  throw new BrowseError(`The indexer's ${what} is not ${expected}.`);
};
const record = (value: unknown, what: string): Json => (value === null || typeof value !== "object" || Array.isArray(value) ? fail(what, "an object") : (value as Json));
const list = (value: unknown, what: string): readonly unknown[] => (Array.isArray(value) ? value : fail(what, "a list"));
const count = (value: unknown, what: string): number => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fail(what, "a count"));
const integer = (value: unknown, what: string): number => (typeof value === "number" && Number.isInteger(value) ? value : fail(what, "a whole number"));
const amount = (value: unknown, what: string): bigint => (typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : fail(what, "a whole amount"));
const hexOf = (value: unknown, what: string): Hex => (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? (value.toLowerCase() as Hex) : fail(what, "hex"));
const addressOf = (value: unknown, what: string): Address => (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value.toLowerCase() as Address) : fail(what, "an address"));
const orNull = <T>(value: unknown, read: (value: unknown, what: string) => T, what: string): T | null => (value === null || value === undefined ? null : read(value, what));
const textOrNull = (value: unknown, what: string): string | null => orNull(value, (text, name) => (typeof text === "string" ? text : fail(name, "text")), what);

const pageOf = <T>(body: unknown, what: string, item: (value: unknown) => T): BrowsePage<T> => {
  const answer = record(body, `${what} answer`);
  return {
    items: list(answer.items, `${what} items`).map(item),
    total: count(answer.total, `${what} total`),
    limit: count(answer.limit, `${what} limit`),
    offset: count(answer.offset, `${what} offset`),
    asOf: count(answer.asOf, `${what} asOf`),
  };
};

const tokenOfView = (value: unknown): BrowseMessage["token"] => {
  if (value === null || value === undefined) return null;
  const token = record(value, "token");
  return { chainId: integer(token.chainId, "token chainId"), address: addressOf(token.address, "token address"), symbol: textOrNull(token.symbol, "token symbol"), decimals: orNull(token.decimals, integer, "token decimals") };
};

/** Parses `GET /api/browse/messages`. */
export const parseBrowseMessages = (body: unknown): BrowsePage<BrowseMessage> =>
  pageOf(body, "message list", (value) => {
    const item = record(value, "message");
    const direction = record(item.direction, "direction");
    const status = item.status;
    if (typeof status !== "string" || !(MESSAGE_STATUSES as readonly string[]).includes(status)) fail("message status", "a status");
    const transfer = item.transfer === null || item.transfer === undefined ? null : record(item.transfer, "transfer");
    const sent = item.sent === null || item.sent === undefined ? null : record(item.sent, "sent");
    const delivered = item.delivered === null || item.delivered === undefined ? null : record(item.delivered, "delivered");
    return {
      id: hexOf(item.messageId, "messageId"),
      kind: item.kind === "token" ? "token" : "message",
      status: status as MessageStatus,
      sourceChainId: integer(direction.sourceChainId, "sourceChainId"),
      destinationChainId: integer(direction.destinationChainId, "destinationChainId"),
      sender: transfer === null ? orNull(item.sender, addressOf, "sender") : (orNull(transfer.sender, addressOf, "transfer sender") ?? orNull(item.sender, addressOf, "sender")),
      recipient:
        transfer === null
          ? orNull(item.executor, addressOf, "executor")
          : (orNull(transfer.finalRecipient, addressOf, "finalRecipient") ?? orNull(transfer.recipient, addressOf, "recipient") ?? orNull(transfer.paidTo, addressOf, "paidTo")),
      token: transfer === null ? null : tokenOfView(transfer.sourceToken),
      amount: transfer === null ? null : orNull(transfer.value, amount, "value"),
      destinationToken: transfer === null ? null : tokenOfView(transfer.destinationToken),
      fee: transfer === null ? null : orNull(transfer.fee, amount, "fee"),
      received: transfer === null ? null : orNull(transfer.received, amount, "received"),
      feeSource: transfer === null ? null : textOrNull(transfer.feeSource, "feeSource"),
      sentAt: sent === null ? null : orNull(sent.timestamp, integer, "sent timestamp"),
      deliveredAt: delivered === null ? null : orNull(delivered.timestamp, integer, "delivered timestamp"),
      sourceTransactionHash: sent === null ? null : orNull(sent.transactionHash, hexOf, "sent transactionHash"),
    };
  });

/** Parses `GET /api/browse/proofs`. */
export const parseBrowseProofs = (body: unknown): BrowsePage<BrowseProof> =>
  pageOf(body, "proof list", (value) => {
    const item = record(value, "proof");
    return {
      number: count(item.number, "proof number"),
      chainId: integer(item.chainId, "chainId"),
      slot: amount(String(item.slot), "slot"),
      timestamp: integer(item.timestamp, "timestamp"),
      transactionHash: hexOf(item.transactionHash, "transactionHash"),
      poster: addressOf(item.poster, "poster"),
      costWei: amount(item.costWei, "costWei"),
    };
  });

/** Parses `GET /api/browse/tokens`. */
export const parseBrowseTokens = (body: unknown): BrowsePage<BrowseToken> =>
  pageOf(body, "token list", (value) => {
    const item = record(value, "token");
    return {
      chainId: integer(item.chainId, "chainId"),
      address: addressOf(item.address, "address"),
      symbol: textOrNull(item.symbol, "symbol"),
      name: textOrNull(item.name, "name"),
      decimals: orNull(item.decimals, integer, "decimals"),
      isBridgedCopy: item.isBridgedCopy === true,
      transfers: count(item.transfers, "transfers"),
    };
  });

/** Parses `GET /api/browse/addresses`. */
export const parseBrowseAddresses = (body: unknown): BrowsePage<BrowseAddress> =>
  pageOf(body, "address list", (value) => {
    const item = record(value, "address");
    return { address: addressOf(item.address, "address"), sent: count(item.sent, "sent"), received: count(item.received, "received"), posted: count(item.posted, "posted"), lastActive: orNull(item.lastActive, count, "lastActive") };
  });

const chainsOf = <T>(value: unknown, what: string, item: (row: Json) => T): readonly T[] => list(value, what).map((row) => item(record(row, what)));

/** Parses `GET /api/counts`. */
export const parseBrowseCounts = (body: unknown): BrowseCounts => {
  const answer = record(body, "counts answer");
  const messages = record(answer.messages, "message counts");
  const updates = record(answer.lightClientUpdates, "light-client update counts");
  const addresses = record(answer.addresses, "address counts");
  const tokens = record(answer.tokens, "token counts");
  const gates = record(answer.gates, "gate counts");
  const byStatus = record(messages.byStatus, "status counts");
  return {
    asOf: count(answer.asOf, "asOf"),
    messages: {
      total: count(messages.total, "message total"),
      inFlight: count(messages.inFlight, "in-flight total"),
      transfers: count(messages.transfers, "transfer total"),
      plain: count(messages.plain, "plain message total"),
      byStatus: Object.fromEntries(Object.entries(byStatus).map(([status, n]) => [status, count(n, `${status} count`)])),
      directions: chainsOf(messages.directions, "direction counts", (row) => ({
        sourceChainId: integer(row.sourceChainId, "sourceChainId"),
        destinationChainId: integer(row.destinationChainId, "destinationChainId"),
        total: count(row.total, "direction total"),
        inFlight: count(row.inFlight, "direction in flight"),
      })),
    },
    lightClientUpdates: { total: count(updates.total, "update total"), chains: chainsOf(updates.chains, "update chains", (row) => ({ chainId: integer(row.chainId, "chainId"), count: count(row.count, "update count") })) },
    addresses: { total: count(addresses.total, "address total"), senders: count(addresses.senders, "senders"), recipients: count(addresses.recipients, "recipients"), posters: count(addresses.posters, "posters") },
    tokens: {
      total: count(tokens.total, "token total"),
      chains: chainsOf(tokens.chains, "token chains", (row) => ({ chainId: integer(row.chainId, "chainId"), total: count(row.total, "token chain total"), native: count(row.native, "native tokens"), copies: count(row.copies, "bridged copies") })),
    },
    contracts: count(answer.contracts, "contracts"),
    gates: { total: count(gates.total, "gate total"), open: count(gates.open, "open gates") },
    escrow: { entries: count(record(answer.escrow, "escrow counts").entries, "escrow entries") },
  };
};

/** Gets JSON from a URL. */
export type BrowseFetcher = (url: string) => Promise<unknown>;

/** The typed client of the browse API. `baseUrl` is read at each call, because the reader may change it. */
export type BrowseClient = {
  counts(): Promise<BrowseCounts>;
  messages(request: BrowseRequest): Promise<BrowsePage<BrowseMessage>>;
  proofs(request: BrowseRequest): Promise<BrowsePage<BrowseProof>>;
  tokens(request: BrowseRequest): Promise<BrowsePage<BrowseToken>>;
  addresses(request: BrowseRequest): Promise<BrowsePage<BrowseAddress>>;
};

/**
 * Creates the client.
 *
 * @param baseUrl The indexer base URL now, or null when none is set.
 * @param fetchJson Gets and parses JSON; it throws on a status that is not a success.
 */
export const createBrowseClient = (baseUrl: () => string | null, fetchJson: BrowseFetcher): BrowseClient => {
  const get = async (path: string, request: BrowseRequest = {}): Promise<unknown> => {
    const base = baseUrl();
    if (base === null) throw new BrowseError("No indexer is set; set one in Settings.");
    const query = browseParams(request).toString();
    return fetchJson(`${base.replace(/\/$/, "")}${path}${query === "" ? "" : `?${query}`}`);
  };
  return {
    counts: async () => parseBrowseCounts(await get("/api/counts")),
    messages: async (request) => parseBrowseMessages(await get("/api/browse/messages", request)),
    proofs: async (request) => parseBrowseProofs(await get("/api/browse/proofs", request)),
    tokens: async (request) => parseBrowseTokens(await get("/api/browse/tokens", request)),
    addresses: async (request) => parseBrowseAddresses(await get("/api/browse/addresses", request)),
  };
};
