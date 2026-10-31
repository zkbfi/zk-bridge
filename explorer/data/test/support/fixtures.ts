import { mergeMessage } from "../../src/message-merge.js";
import { loadPair, type Pair } from "../../src/pairs.js";

/** A transaction hash made of one repeated byte. */
export const hashOf = (byte: string): `0x${string}` => `0x${byte.repeat(32)}`;

/** An address made of one repeated byte, for a test that needs a distinct account. */
export const addressOf = (byte: string): `0x${string}` => `0x${byte.repeat(20)}`;

/**
 * A `messages` row for a send on chain 1 to chain 369, built by the same merge that the indexer handlers use, so that
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

const deploymentSection = (chainId: number, digit: string, extra: Record<string, unknown> = {}) => ({
  chain_id: chainId,
  rpc_url: "http://127.0.0.1:1",
  bridge: `0x${digit}b${"0".repeat(38)}`,
  mediator: `0x${digit}d${"0".repeat(38)}`,
  token_factory: `0x${digit}f${"0".repeat(38)}`,
  wrapped_native: `0x${digit}e${"0".repeat(38)}`,
  gate: `0x${digit}c${"0".repeat(38)}`,
  light_client: `0x${digit}9${"0".repeat(38)}`,
  start_block: 10,
  ...extra,
});

/** The deployment file of the test pair: chain 1 and chain 369, each address distinct. */
export const TEST_DEPLOYMENT = {
  chain_a: deploymentSection(1, "1"),
  chain_b: deploymentSection(369, "2", { fork_registry: `0x2${"7".repeat(39)}` }),
};

/** The pair that the shared tests use. */
export const testPair = (environment: Record<string, string | undefined> = {}): Pair =>
  loadPair({ environment, deployment: TEST_DEPLOYMENT });
