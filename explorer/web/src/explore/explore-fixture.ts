/**
 * Indexer answers recorded from https://indexer.zkb.fi on 2026-10-30 (Sepolia ↔ PulseChain testnet v4), for the
 * Explore tests and the sample page. They are real: one light-client update posted on Sepolia, both gates closed, no
 * transfers yet.
 */
import { createIndexerExploreSource, type ExploreSource } from "./explore-source";

/** The source the sample page reads: the recorded answers. */
export const createFixtureExploreSource = (): ExploreSource => createIndexerExploreSource(() => "https://indexer.zkb.fi", recordedRequester);

export const RECORDED_HEAD_UPDATES = {
  items: [
    {
      chainId: 11155111,
      slot: 11194368,
      headerRoot: "0xe1024bbfc98108ec3fe5851520f4510952a5d8e10913e900375cb8e29701835a",
      executionBlockHash: "0x9ddeae6daafa2e91d57c8efa240583ff83c1f95a2e20cce68a6564e56303ac43",
      executionBlockNumber: 25767883,
      transactionHash: "0x4663c8c20fc80a37f8e93102602d2fb969e93d1973c49011edff6915ab4828db",
      blockNumber: 12021502,
      timestamp: 1793300844,
      gasUsed: "604091",
      effectiveGasPrice: "100000000",
      costWei: "60409100000000",
      poster: "0xf71cbaa5a165fad2ffff6b0d68e84d67b1f75eac",
    },
  ],
};

export const RECORDED_GATE = {
  sides: [
    { chainId: 11155111, name: "sepolia", gate: "0x1782a38a37ce9fb9f53b0585b23b833847007e20", enforcing: true, sealed: false, sealedVersion: null, sealedSlot: null, lastConfirmedEpoch: null, lastConfirmedVersion: null, lastConfirmedTimestamp: null, confirmations: 0, depositsOpen: false, depositsOpenedTimestamp: null },
    { chainId: 943, name: "pulsechain-testnet-v4", gate: "0x0e8586fb952f8a299e31c8b8fbe093dde8e1be93", enforcing: false, sealed: false, sealedVersion: null, sealedSlot: null, lastConfirmedEpoch: null, lastConfirmedVersion: null, lastConfirmedTimestamp: null, confirmations: 0, depositsOpen: false, depositsOpenedTimestamp: null },
  ],
  events: [],
};

export const RECORDED_LIGHT_CLIENT_COSTS = {
  perChain: [{ chainId: 11155111, updates: 1, gasUsed: "604091", costWei: "60409100000000" }],
  perPoster: [{ chainId: 11155111, poster: "0xf71cbaa5a165fad2ffff6b0d68e84d67b1f75eac", updates: 1, gasUsed: "604091", costWei: "60409100000000" }],
};

export const RECORDED_HISTORY = {
  items: [{ kind: "head-update", chainId: 11155111, timestamp: 1793300844, transactionHash: "0x4663c8c20fc80a37f8e93102602d2fb969e93d1973c49011edff6915ab4828db", messageId: null, slot: 11194368, status: null }],
  nextCursor: null,
  partial: false,
};

export const RECORDED_ESCROW = { escrow: [], bridgedSupply: [] };
export const RECORDED_UNDELIVERED = { items: [], nextCursor: null };
export const RECORDED_RELEASE_EVENTS = { events: [] };
const POSTER = RECORDED_HEAD_UPDATES.items[0]?.poster;
export const RECORDED_COUNTS = {
  pair: "sepolia-pls943",
  asOf: 1_793_300_900,
  messages: { total: 0, inFlight: 0, transfers: 0, plain: 0, byStatus: {}, directions: [] },
  lightClientUpdates: { total: 1, chains: [{ chainId: 11155111, count: 1 }] },
  addresses: { total: 1, senders: 0, recipients: 0, posters: 1 },
  tokens: { total: 0, chains: [] },
  contracts: 12,
  gates: { total: 2, open: 0 },
  escrow: { entries: 0 },
};
export const RECORDED_BROWSE_MESSAGES = { items: [], total: 0, limit: 50, offset: 0, asOf: 1_793_300_900 };
export const RECORDED_BROWSE_PROOFS = { items: RECORDED_HEAD_UPDATES.items.map((item) => ({ ...item, number: 1 })), total: 1, limit: 50, offset: 0, asOf: 1_793_300_900 };
export const RECORDED_BROWSE_TOKENS = { items: [], total: 0, limit: 50, offset: 0, asOf: 1_793_300_900 };
export const RECORDED_BROWSE_ADDRESSES = { items: [{ address: POSTER, sent: 0, received: 0, posted: 1, lastActive: 1_793_300_844 }], total: 1, limit: 50, offset: 0, asOf: 1_793_300_900 };
export const RECORDED_DELIVERED = { now: 1_790_000_000, directions: [] };

/** A requester that answers the recorded responses by path. */
export const recordedRequester = async (url: string): Promise<unknown> => {
  const path = new URL(url).pathname;
  const answers: Record<string, unknown> = {
    "/api/head-updates": RECORDED_HEAD_UPDATES,
    "/api/gate": RECORDED_GATE,
    "/api/light-client-costs": RECORDED_LIGHT_CLIENT_COSTS,
    "/api/history": RECORDED_HISTORY,
    "/api/escrow": RECORDED_ESCROW,
    "/api/undelivered": RECORDED_UNDELIVERED,
    "/api/release-events": RECORDED_RELEASE_EVENTS,
    "/api/delivered": RECORDED_DELIVERED,
    "/api/counts": RECORDED_COUNTS,
    "/api/browse/messages": RECORDED_BROWSE_MESSAGES,
    "/api/browse/proofs": RECORDED_BROWSE_PROOFS,
    "/api/browse/tokens": RECORDED_BROWSE_TOKENS,
    "/api/browse/addresses": RECORDED_BROWSE_ADDRESSES,
  };
  if (!(path in answers)) throw new Error(`no recorded answer for ${path}`);
  return answers[path];
};
