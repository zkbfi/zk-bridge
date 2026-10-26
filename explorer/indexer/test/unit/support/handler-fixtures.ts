import { mergeMessage } from "../../../src/lib/messages";
import { createFakeClient, type ReadCall } from "./fake-client";
import { createFakeDatabase } from "./fake-database";

/** The contract addresses of the test deployment (`deployment-with-registry.json`). */
export const BRIDGE_ON_ETHEREUM = "0x00000000000000000000000000000000000000b1";
export const BRIDGE_ON_PULSECHAIN = "0x00000000000000000000000000000000000000b2";
export const MEDIATOR_ON_ETHEREUM = "0x00000000000000000000000000000000000000d1";
export const MEDIATOR_ON_PULSECHAIN = "0x00000000000000000000000000000000000000d2";
export const GATE_ON_PULSECHAIN = "0x00000000000000000000000000000000000000c2";
export const LIGHT_CLIENT_ON_PULSECHAIN = "0x00000000000000000000000000000000000000a8";

/** A transaction hash made of one repeated byte. */
export const hashOf = (byte: string): `0x${string}` => `0x${byte.repeat(32)}`;

/** An address made of one repeated byte, for a test that needs a distinct account. */
export const addressOf = (byte: string): `0x${string}` => `0x${byte.repeat(20)}`;

/** What a handler receives besides the event: the chain, the database and the client. */
export const createContext = (chainId: number, answer: (call: ReadCall) => unknown = () => undefined) => {
  const database = createFakeDatabase();
  const client = createFakeClient(answer);
  return { database, client, context: { chain: { id: chainId }, db: database.handle, client } };
};

/** An event with the block and the transaction that every handler reads. */
export const createEvent = <args>(args: args, overrides: Record<string, unknown> = {}) => ({
  id: `event-${Math.random().toString(16).slice(2)}`,
  args,
  block: { number: 100n, timestamp: 1_000n, baseFeePerGas: null },
  transaction: { hash: hashOf("aa"), from: addressOf("f0") },
  transactionReceipt: { gasUsed: 21_000n, effectiveGasPrice: 3n },
  log: { address: addressOf("c0") },
  ...overrides,
});

/**
 * A stored `messages` row for a send on chain 1 to chain 369, built by the same merge that the handlers use, so that
 * every column holds the value that a real row holds.
 */
export const sentMessageRow = (messageId: `0x${string}`, sentBlockNumber: bigint) =>
  mergeMessage({
    messageId,
    sourceChainId: 1,
    destinationChainId: 369,
    existing: null,
    patch: { kind: "token", sentBlockNumber, sentTimestamp: 1_000n },
    latestSourceTimestamp: 1_000n,
    finalitySeconds: 768,
  });
