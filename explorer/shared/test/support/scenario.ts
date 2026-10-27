import { encodeEventTopics, encodeFunctionData, type Address, type Hex } from "viem";
import {
  buildMessageId,
  encodeAmbMessage,
  messageBridgeAbi,
  tokenMediatorAbi,
  type Pair,
} from "../../src/index.js";
import type { ChainReceipt, ViewCall } from "../../src/rpc/chain-reader.js";

/**
 * A synthetic history of one pair: the events that the real contracts would emit for a set of bridge messages, with
 * the answers of the view functions at the end. The RPC tests serve it through a fake chain. The indexer tests feed
 * the same events to the handlers of the indexer, so that the two data sources can be compared on one history.
 *
 * The messages, with the status that each ends with:
 * - `delivered`: a token send from chain 1, delivered on chain 369, which deploys the bridged copy.
 * - `returned`: the copy sent back from chain 369 and delivered on chain 1.
 * - `plain`: an arbitrary message sent and delivered.
 * - `failed`: an arbitrary message whose call reverted (`failed_call`).
 * - `fallback`: a token delivery that paid the fallback address (`fallback_used`).
 * - `claimable`: a token delivery that waits for `claim` (`claimable`).
 * - `claimed`: a token delivery recorded for `claim` and then claimed (`delivered`).
 * - `covered`: a token send that a stored head covers and that is not delivered (`covered`).
 * - `young`: a token send that is younger than the finality window (`sent`).
 * - `waiting`: an arbitrary send older than the finality window with no cover (`waiting_for_finality`).
 * - `backward`: the copy sent back from chain 369, younger than the finality window and not delivered (`sent`).
 *
 * The audit adds up: the escrow of the native token is 1650, the supply of the copy is 1150, and the transfers that are
 * not paid yet hold 560: forward `covered` 250, `claimable` 200 and `young` 50, and backward 60. The escrow is 1710.
 *
 * `plain` and `waiting` are sent in the same block, to test the order of equal send times.
 */

/** The first chain of the test pair. */
export const FIRST_CHAIN = 1;
/** The second chain of the test pair. */
export const SECOND_CHAIN = 369;

/** One event of the history. */
export type ScenarioEvent = {
  readonly chainId: number;
  /** The contract that emits it. */
  readonly contract: "bridge" | "mediator" | "lightClient" | "gate";
  readonly eventName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  /** The account that sent the transaction. */
  readonly from: Address;
};

/** The history. */
export type Scenario = {
  readonly pair: Pair;
  readonly events: readonly ScenarioEvent[];
  /** The latest block of each chain. */
  readonly head: Readonly<Record<number, bigint>>;
  readonly ids: Readonly<Record<MessageName, Hex>>;
  readonly accounts: Readonly<Record<"sender" | "recipient" | "recipientBack" | "fallback" | "executor" | "claimer", Address>>;
  readonly tokens: { readonly native: Address; readonly copy: Address };
  /** The timestamp of a block. */
  timestampOf(chainId: number, blockNumber: bigint): bigint;
  /** The answer of a view function at the end of the history. */
  view(chainId: number, call: ViewCall): unknown;
  /** The receipt of a transaction, with the bridge logs that it holds. */
  receipt(chainId: number, hash: Hex): ChainReceipt | undefined;
};

/** The names of the messages. */
export type MessageName = "delivered" | "returned" | "plain" | "failed" | "fallback" | "claimable" | "claimed" | "covered" | "young" | "waiting" | "backward";

const BASE_TIME = 1_700_000_000n;
const SECONDS_PER_BLOCK = 12n;
const byte = (value: string, length: number): `0x${string}` => `0x${value.repeat(length)}`;

/** The account that sent every transaction of the history. */
const SENDER_OF_TRANSACTIONS = byte("e0", 20);

const hashFor = (chainId: number, blockNumber: number, index: number): Hex =>
  `0x${chainId.toString(16).padStart(8, "0")}${blockNumber.toString(16).padStart(8, "0")}${index.toString(16).padStart(8, "0")}${"ab".repeat(20)}`;

/**
 * Builds the history for a pair. The pair must be the chain 1 and chain 369 pair.
 *
 * @param pair The pair, with the addresses that the events carry.
 */
export const buildScenario = (
  pair: Pair,
  options: {
    /** Whether the gates confirm an epoch and one gate seals. Default true. */
    readonly confirmations?: boolean;
    /** Drops the events for which it answers true, to test a history with a gap. */
    readonly drop?: (event: ScenarioEvent) => boolean;
  } = {},
): Scenario => {
  const [first, second] = pair.sides;
  const accounts = {
    sender: byte("11", 20),
    recipient: byte("22", 20),
    recipientBack: byte("23", 20),
    fallback: byte("24", 20),
    executor: byte("33", 20),
    claimer: byte("44", 20),
  } as const;
  const native = byte("aa", 20);
  const copy = byte("bb", 20);
  const executionHashes = { first: byte("c1", 32), second: byte("c2", 32) } as const;
  const nonces = new Map<number, bigint>();
  const nextId = (side: typeof first): Hex => {
    const nonce = nonces.get(side.chainId) ?? 0n;
    nonces.set(side.chainId, nonce + 1n);
    return buildMessageId(BigInt(side.chainId), side.contracts.bridge, nonce);
  };
  const ids = {
    delivered: nextId(first),
    plain: nextId(first),
    failed: nextId(first),
    fallback: nextId(first),
    claimable: nextId(first),
    claimed: nextId(first),
    covered: nextId(first),
    young: nextId(first),
    waiting: nextId(first),
    returned: nextId(second),
    backward: nextId(second),
  } as const;

  const kept: ScenarioEvent[] = [];
  const events = kept;
  const counters = new Map<string, number>();
  /** Adds the events of one transaction. */
  const transaction = (chainId: number, blockNumber: number, emit: (add: (contract: ScenarioEvent["contract"], eventName: string, args: Record<string, unknown>) => void) => void): void => {
    const index = counters.get(`${chainId}:${blockNumber}`) ?? 0;
    counters.set(`${chainId}:${blockNumber}`, index + 1);
    const transactionHash = hashFor(chainId, blockNumber, index);
    emit((contract, eventName, args) =>
      void events.push({ chainId, contract, eventName, args, blockNumber: BigInt(blockNumber), transactionHash, from: SENDER_OF_TRANSACTIONS }),
    );
  };

  const send = (from: typeof first, to: typeof first, messageId: Hex, executor: Address, data: Hex): { messageId: Hex; encodedData: Hex } => ({
    messageId,
    encodedData: encodeAmbMessage({
      header: { messageId, sender: accounts.sender, executor, gasLimit: 250_000, dataType: 0, sourceChainId: BigInt(from.chainId), destinationChainId: BigInt(to.chainId) },
      data,
    }),
  });
  const tokenSend = (
    from: typeof first,
    to: typeof first,
    messageId: Hex,
    call: { functionName: "handleBridgedTokens" | "handleNativeTokens" | "handleBridgedTokensWithFallback"; token: Address; recipient: Address; value: bigint; fallbackRecipient?: Address },
  ) =>
    send(
      from,
      to,
      messageId,
      to.contracts.mediator,
      encodeFunctionData({
        abi: tokenMediatorAbi,
        functionName: call.functionName,
        args: call.functionName === "handleBridgedTokensWithFallback" ? [call.token, call.recipient, call.value, call.fallbackRecipient as Address] : [call.token, call.recipient, call.value],
      } as never),
    );
  const delivered = (messageId: Hex, status: boolean, executor: Address) => ({ sender: accounts.sender, executor, messageId, status });

  // Chain 1: the sends and the deliveries of the return trip.
  transaction(first.chainId, 100, (add) => {
    add("bridge", "UserRequestForAffirmation", tokenSend(first, second, ids.delivered, { functionName: "handleBridgedTokens", token: native, recipient: accounts.recipient, value: 1_000n }));
    add("mediator", "TokensBridgingInitiated", { token: native, sender: accounts.sender, value: 1_000n, messageId: ids.delivered });
  });
  transaction(first.chainId, 103, (add) => {
    add("bridge", "UserRequestForAffirmation", tokenSend(first, second, ids.covered, { functionName: "handleBridgedTokens", token: native, recipient: accounts.recipient, value: 250n }));
    add("mediator", "TokensBridgingInitiated", { token: native, sender: accounts.sender, value: 250n, messageId: ids.covered });
  });
  transaction(first.chainId, 120, (add) => {
    add("bridge", "UserRequestForAffirmation", send(first, second, ids.waiting, accounts.executor, "0x1234"));
  });
  transaction(first.chainId, 120, (add) => {
    add("bridge", "UserRequestForAffirmation", send(first, second, ids.plain, accounts.executor, "0xabcd"));
  });
  transaction(first.chainId, 220, (add) => {
    add("bridge", "AffirmationCompleted", delivered(ids.returned, true, first.contracts.mediator));
    add("mediator", "TokensBridged", { token: native, recipient: accounts.recipientBack, value: 400n, messageId: ids.returned });
  });
  transaction(first.chainId, 216, (add) => {
    add("lightClient", "HeadUpdated", { slot: 340n, headerRoot: byte("d2", 32), executionBlockHash: executionHashes.second });
  });
  transaction(first.chainId, 160, (add) => {
    add("bridge", "UserRequestForAffirmation", send(first, second, ids.failed, accounts.executor, "0xdead"));
  });
  transaction(first.chainId, 165, (add) => {
    add("bridge", "UserRequestForAffirmation", tokenSend(first, second, ids.fallback, { functionName: "handleBridgedTokensWithFallback", token: native, recipient: accounts.recipient, value: 300n, fallbackRecipient: accounts.fallback }));
    add("mediator", "TokensBridgingInitiated", { token: native, sender: accounts.sender, value: 300n, messageId: ids.fallback });
  });
  transaction(first.chainId, 170, (add) => {
    add("bridge", "UserRequestForAffirmation", tokenSend(first, second, ids.claimable, { functionName: "handleBridgedTokens", token: native, recipient: accounts.recipient, value: 200n }));
    add("mediator", "TokensBridgingInitiated", { token: native, sender: accounts.sender, value: 200n, messageId: ids.claimable });
  });
  transaction(first.chainId, 175, (add) => {
    add("bridge", "UserRequestForAffirmation", tokenSend(first, second, ids.claimed, { functionName: "handleBridgedTokens", token: native, recipient: accounts.claimer, value: 100n }));
    add("mediator", "TokensBridgingInitiated", { token: native, sender: accounts.sender, value: 100n, messageId: ids.claimed });
  });
  transaction(first.chainId, 295, (add) => {
    add("bridge", "UserRequestForAffirmation", tokenSend(first, second, ids.young, { functionName: "handleBridgedTokens", token: native, recipient: accounts.recipient, value: 50n }));
    add("mediator", "TokensBridgingInitiated", { token: native, sender: accounts.sender, value: 50n, messageId: ids.young });
  });

  // Chain 369: the deliveries, and the send of the return trip.
  transaction(second.chainId, 205, (add) => {
    add("mediator", "NewTokenRegistered", { nativeToken: native, bridgedToken: copy });
    add("mediator", "TokensBridged", { token: copy, recipient: accounts.recipient, value: 1_000n, messageId: ids.delivered });
    add("bridge", "AffirmationCompleted", delivered(ids.delivered, true, second.contracts.mediator));
  });
  transaction(second.chainId, 210, (add) => {
    add("bridge", "UserRequestForAffirmation", tokenSend(second, first, ids.returned, { functionName: "handleNativeTokens", token: native, recipient: accounts.recipientBack, value: 400n }));
    add("mediator", "TokensBridgingInitiated", { token: copy, sender: accounts.sender, value: 400n, messageId: ids.returned });
  });
  transaction(second.chainId, 215, (add) => {
    add("lightClient", "HeadUpdated", { slot: 300n, headerRoot: byte("d1", 32), executionBlockHash: executionHashes.first });
  });
  // An earlier head that a second transaction stored in the same block, to test the order of equal times.
  transaction(second.chainId, 215, (add) => {
    add("lightClient", "HeadUpdated", { slot: 299n, headerRoot: byte("d3", 32), executionBlockHash: byte("c3", 32) });
  });
  transaction(second.chainId, 220, (add) => {
    add("bridge", "AffirmationCompleted", delivered(ids.failed, false, accounts.executor));
  });
  transaction(second.chainId, 225, (add) => {
    add("bridge", "AffirmationCompleted", delivered(ids.plain, true, accounts.executor));
  });
  transaction(second.chainId, 230, (add) => {
    add("mediator", "FallbackUsed", { token: copy, recipient: accounts.recipient, fallbackRecipient: accounts.fallback, messageId: ids.fallback });
    add("mediator", "TokensBridged", { token: copy, recipient: accounts.fallback, value: 300n, messageId: ids.fallback });
    add("bridge", "AffirmationCompleted", delivered(ids.fallback, true, second.contracts.mediator));
  });
  transaction(second.chainId, 240, (add) => {
    add("mediator", "ClaimableRecorded", { token: copy, account: accounts.recipient, value: 200n, messageId: ids.claimable });
    add("bridge", "AffirmationCompleted", delivered(ids.claimable, true, second.contracts.mediator));
  });
  transaction(second.chainId, 250, (add) => {
    add("mediator", "ClaimableRecorded", { token: copy, account: accounts.claimer, value: 100n, messageId: ids.claimed });
    add("mediator", "CallbackFailed", { token: copy, recipient: accounts.claimer, messageId: ids.claimed });
    add("bridge", "AffirmationCompleted", delivered(ids.claimed, true, second.contracts.mediator));
  });
  transaction(second.chainId, 260, (add) => {
    add("mediator", "Claimed", { token: copy, account: accounts.claimer, value: 100n });
  });
  transaction(second.chainId, 290, (add) => {
    add("bridge", "UserRequestForAffirmation", tokenSend(second, first, ids.backward, { functionName: "handleNativeTokens", token: native, recipient: accounts.recipientBack, value: 60n }));
    add("mediator", "TokensBridgingInitiated", { token: copy, sender: accounts.sender, value: 60n, messageId: ids.backward });
  });

  if (options.confirmations !== false) {
    transaction(first.chainId, 250, (add) => {
      add("gate", "ForkConfirmed", { epoch: 10n, version: "0x01020304" });
    });
    transaction(second.chainId, 255, (add) => {
      add("gate", "ForkConfirmed", { epoch: 10n, version: "0x01020304" });
    });
    transaction(second.chainId, 260, (add) => {
      add("gate", "GateSealedByFork", { version: "0xdeadbeef", slot: 7n });
    });
  }

  if (options.drop !== undefined) {
    const dropped = options.drop;
    kept.splice(0, kept.length, ...kept.filter((event) => !dropped(event)));
  }

  const head = { [first.chainId]: 300n, [second.chainId]: 300n } as Readonly<Record<number, bigint>>;
  // The stored head of the light client on chain 369 holds chain 1 block 105, so it covers the sends at blocks 100 and 103.
  // The stored head of the light client on chain 1 holds chain 369 block 212, so it covers the return trip.
  const lightClients = {
    [first.chainId]: { slot: 340n, hash: executionHashes.second, executionBlock: 212n },
    [second.chainId]: { slot: 300n, hash: executionHashes.first, executionBlock: 105n },
  } as const;

  const view = (chainId: number, call: ViewCall): unknown => {
    const side = chainId === first.chainId ? first : second;
    const address = call.address.toLowerCase();
    const args = call.args ?? [];
    const name = call.functionName;
    if (address === side.contracts.lightClient) {
      const light = lightClients[chainId] as { slot: bigint; hash: Hex; executionBlock: bigint };
      if (name === "head") return light.slot;
      if (name === "executionBlockHashes") return light.hash;
      if (name === "executionBlockNumber") return args[0] === light.hash ? light.executionBlock : 0n;
      if (name === "genesisTime") return BASE_TIME - 1_000n;
      if (name === "secondsPerSlot") return 12n;
    }
    if (address === side.contracts.gate) {
      if (name === "enforcing") return true;
      if (name === "isSealed") return false;
      if (name === "confirmedEpoch") return [10n, true];
      if (name === "genesisTime") return BASE_TIME - 1_000n;
      if (name === "slotsPerEpoch") return 32n;
      if (name === "secondsPerSlot") return 12n;
    }
    if (address === side.contracts.bridge && name === "depositsOpen") return true;
    if (address === side.contracts.mediator) {
      const token = String(args[0]).toLowerCase();
      if (name === "nativeTokenAddress") return token === copy ? native : "0x0000000000000000000000000000000000000000";
      if (name === "bridgedTokenAddress") return copy;
      if (name === "mediatorBalance") return token === native ? 1_710n : 0n;
    }
    if (address === native || address === copy) {
      if (name === "name") return address === native ? "Tether" : "Tether from Ethereum";
      if (name === "symbol") return address === native ? "USDT" : "USDT.e";
      if (name === "decimals") return 6;
      if (name === "totalSupply") return 1_150n;
    }
    throw new Error(`the scenario has no answer for ${name} on ${address}`);
  };

  const receipts = new Map<string, ChainReceipt>();
  const unknownTopic = byte("5e", 32);
  for (const event of events) {
    const side = event.chainId === first.chainId ? first : second;
    const key = `${event.chainId}:${event.transactionHash}`;
    const existing = receipts.get(key) ?? { from: event.from, blockNumber: event.blockNumber, gasUsed: 210_000n, effectiveGasPrice: 3n, logs: [] };
    const address = side.contracts[event.contract];
    const topics =
      event.contract === "bridge"
        ? encodeEventTopics({
            abi: messageBridgeAbi,
            eventName: event.eventName as "UserRequestForAffirmation" | "AffirmationCompleted",
            args: event.eventName === "UserRequestForAffirmation" ? { messageId: event.args.messageId as Hex } : { sender: event.args.sender as Address, executor: event.args.executor as Address, messageId: event.args.messageId as Hex },
          } as never)
        : [unknownTopic];
    // A bridge event that the lookup does not read comes first in the first send transaction.
    const other = event.eventName === "UserRequestForAffirmation" && event.args.messageId === ids.delivered ? [{ address, topics: [unknownTopic] as Hex[] }] : [];
    receipts.set(key, { ...existing, logs: [...existing.logs, ...other, { address, topics: topics as Hex[] }] });
  }

  return {
    pair,
    events,
    head,
    ids,
    accounts,
    tokens: { native, copy },
    timestampOf: (_chainId, blockNumber) => BASE_TIME + blockNumber * SECONDS_PER_BLOCK,
    view,
    receipt: (chainId, hash) => receipts.get(`${chainId}:${hash}`),
  };
};
