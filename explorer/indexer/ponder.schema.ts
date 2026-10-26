import { index, onchainTable, primaryKey } from "ponder";

/**
 * The tables of the explorer indexer. Every address and hash is lowercase hex. Block numbers, timestamps (seconds),
 * slots and amounts are bigint columns. Amounts are integers in base units; rates are scaled by 1e18.
 *
 * `messages` is the spine: one row per bridge message, from its send on the source chain to its delivery on the
 * destination chain. A row can start from either side, because the two chains are indexed without a shared order.
 * Every writer merges its facts into the row and recomputes `status` with `deriveStatus` from `@zk-bridge/shared`.
 */

/** One bridge message. `kind` is `token` when the executor is the remote mediator and the data is a handler call. */
export const messages = onchainTable(
  "messages",
  (t) => ({
    messageId: t.hex().primaryKey(),
    sourceChainId: t.integer().notNull(),
    destinationChainId: t.integer().notNull(),
    /** `<sourceChainId>><destinationChainId>`, for example `1>369`. */
    direction: t.text().notNull(),
    kind: t.text().notNull().default("message"),
    status: t.text().notNull(),
    sender: t.hex(),
    executor: t.hex(),
    gasLimit: t.integer(),
    dataType: t.integer(),
    data: t.hex(),
    sentTransactionHash: t.hex(),
    sentBlockNumber: t.bigint(),
    sentTimestamp: t.bigint(),
    deliveredTransactionHash: t.hex(),
    deliveredBlockNumber: t.bigint(),
    deliveredTimestamp: t.bigint(),
    /** True when the destination call succeeded, false when it reverted, null before delivery. */
    deliveredSuccess: t.boolean(),
    /** The account that sent the execution transaction. */
    executedBy: t.hex(),
    /** The slot of the first stored head that covered this message, or null. */
    coveredByHeadSlot: t.bigint(),
    coveredAtTimestamp: t.bigint(),
    fallbackUsed: t.boolean().notNull().default(false),
    callbackFailed: t.boolean().notNull().default(false),
    claimableOutstanding: t.boolean().notNull().default(false),
    claimableToken: t.hex(),
    claimableAccount: t.hex(),
    claimedTimestamp: t.bigint(),
  }),
  (table) => ({
    statusIndex: index().on(table.status),
    sentTimestampIndex: index().on(table.sentTimestamp),
    senderIndex: index().on(table.sender),
    destinationIndex: index().on(table.destinationChainId, table.coveredByHeadSlot),
  }),
);

/** The token view of a message of kind `token`. Joined to `messages` by `messageId`. */
export const transfers = onchainTable(
  "transfers",
  (t) => ({
    messageId: t.hex().primaryKey(),
    sourceChainId: t.integer().notNull(),
    destinationChainId: t.integer().notNull(),
    /** The token on the source chain. */
    sourceToken: t.hex(),
    /** The token on the destination chain. Known from the message, or from the delivery. */
    destinationToken: t.hex(),
    /** The account that started the transfer on the source chain. */
    sender: t.hex(),
    recipient: t.hex(),
    fallbackRecipient: t.hex(),
    /** The amount that was locked or burned, after the bridge fee. Base units of the source token. */
    value: t.bigint(),
    /** The amount that the delivery paid, from `TokensBridged`. Null until a payment. */
    deliveredValue: t.bigint(),
    /** The account that received the tokens. The fallback address when the recipient refused. */
    paidTo: t.hex(),
    handler: t.text(),
    deploysCopy: t.boolean().notNull().default(false),
    hasCallback: t.boolean().notNull().default(false),
    /** True when the source token is native on the source chain (lock) and false when it is a bridged copy (burn). */
    sourceIsNative: t.boolean(),
    sentTimestamp: t.bigint(),
  }),
  (table) => ({
    sourceTokenIndex: index().on(table.sourceToken),
    recipientIndex: index().on(table.recipient),
  }),
);

/** A token seen by the bridge, native or bridged copy. */
export const tokens = onchainTable(
  "tokens",
  (t) => ({
    chainId: t.integer().notNull(),
    address: t.hex().notNull(),
    name: t.text(),
    symbol: t.text(),
    decimals: t.integer().notNull(),
    /** False when the token metadata could not be read from the chain. `decimals` is then 18 by assumption. */
    metadataRead: t.boolean().notNull(),
    isBridgedCopy: t.boolean().notNull(),
    /** The chain where the native token lives. For a native token, its own chain. */
    homeChainId: t.integer().notNull(),
    homeToken: t.hex().notNull(),
    registeredTransactionHash: t.hex(),
    registeredBlockNumber: t.bigint(),
    registeredTimestamp: t.bigint(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.chainId, table.address] }) }),
);

/** Mediator balance of a native token on its home chain, and its accrued fees. Read from the contract. */
export const escrow = onchainTable(
  "escrow",
  (t) => ({
    chainId: t.integer().notNull(),
    token: t.hex().notNull(),
    /** `mediatorBalance(token)`: the tokens locked for holders of the bridged copy. */
    balance: t.bigint().notNull(),
    /** `accruedFees(token)`: fees charged and not yet collected. Not part of `balance`. */
    accruedFees: t.bigint().notNull(),
    updatedBlockNumber: t.bigint().notNull(),
    updatedTimestamp: t.bigint().notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.chainId, table.token] }) }),
);

/** Supply of a bridged copy, summed from its mint and burn transfers. */
export const bridgedSupply = onchainTable(
  "bridged_supply",
  (t) => ({
    chainId: t.integer().notNull(),
    token: t.hex().notNull(),
    nativeToken: t.hex().notNull(),
    homeChainId: t.integer().notNull(),
    minted: t.bigint().notNull(),
    burned: t.bigint().notNull(),
    supply: t.bigint().notNull(),
    updatedBlockNumber: t.bigint().notNull(),
    updatedTimestamp: t.bigint().notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.chainId, table.token] }) }),
);

/** Amounts that a release recorded for `claim`. `outstanding` is zero after the claim. */
export const claimables = onchainTable(
  "claimables",
  (t) => ({
    chainId: t.integer().notNull(),
    token: t.hex().notNull(),
    account: t.hex().notNull(),
    outstanding: t.bigint().notNull(),
    recordedTotal: t.bigint().notNull(),
    claimedTotal: t.bigint().notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.chainId, table.token, table.account] }) }),
);

/** Fallback, claimable and claim events, one row each. `kind` is `fallback_used`, `claimable_recorded`, `claimed` or `callback_failed`. */
export const claimEvents = onchainTable(
  "claim_events",
  (t) => ({
    id: t.text().primaryKey(),
    chainId: t.integer().notNull(),
    kind: t.text().notNull(),
    token: t.hex().notNull(),
    account: t.hex(),
    fallbackRecipient: t.hex(),
    value: t.bigint(),
    messageId: t.hex(),
    transactionHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({ messageIndex: index().on(table.messageId) }),
);

/** Fee events. `kind` is `charged_outgoing`, `charged_incoming` or `collected`. */
export const feeEvents = onchainTable(
  "fee_events",
  (t) => ({
    id: t.text().primaryKey(),
    chainId: t.integer().notNull(),
    kind: t.text().notNull(),
    token: t.hex(),
    amount: t.bigint(),
    recipient: t.hex(),
    /** Not used by any current kind. Kept null. */
    rate: t.bigint(),
    transactionHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({ chainIndex: index().on(table.chainId, table.kind) }),
);

/** Fee totals per chain and token. `accrued` is `charged - collected`. */
export const feeBalances = onchainTable(
  "fee_balances",
  (t) => ({
    chainId: t.integer().notNull(),
    token: t.hex().notNull(),
    charged: t.bigint().notNull(),
    collected: t.bigint().notNull(),
    accrued: t.bigint().notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.chainId, table.token] }) }),
);

/** The fee of the mediator on a chain, read from the contract at the last charged fee. The schedule never changes. */
export const feeTerms = onchainTable("fee_terms", (t) => ({
  chainId: t.integer().primaryKey(),
  /** `currentFeeRate()` at the last charged fee, scaled by 1e18. The rate only falls. */
  rate: t.bigint().notNull(),
  recipient: t.hex(),
}));

/** One light client head update. `chainId` is the chain that holds the light client (the destination). */
export const headUpdates = onchainTable(
  "head_updates",
  (t) => ({
    chainId: t.integer().notNull(),
    slot: t.bigint().notNull(),
    headerRoot: t.hex().notNull(),
    executionBlockHash: t.hex().notNull(),
    /** The execution block of the tracked (source) chain that the head holds. Read from the light client. */
    executionBlockNumber: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    gasUsed: t.bigint().notNull(),
    effectiveGasPrice: t.bigint().notNull(),
    /** `gasUsed * effectiveGasPrice`, in wei of the chain's coin. */
    costWei: t.bigint().notNull(),
    poster: t.hex().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.slot] }),
    timeIndex: index().on(table.chainId, table.timestamp),
  }),
);

/** The newest stored head of the light client on each chain. */
export const lightClientHeads = onchainTable("light_client_heads", (t) => ({
  chainId: t.integer().primaryKey(),
  slot: t.bigint().notNull(),
  headerRoot: t.hex().notNull(),
  executionBlockNumber: t.bigint().notNull(),
  updatedTimestamp: t.bigint().notNull(),
  updateCount: t.integer().notNull(),
}));

/** The newest block that the indexer processed on each chain (every few blocks). */
export const chainTips = onchainTable("chain_tips", (t) => ({
  chainId: t.integer().primaryKey(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  /** The base fee of that block in wei per gas. Null when the chain has no base fee or the block did not report one. */
  baseFeePerGas: t.bigint(),
}));

/**
 * The gas of one delivery transaction, one row per delivered message. The row holds no kind, because the send and the
 * delivery arrive in either order. The report classifies at query time from `messages` and `transfers`.
 * `gasUsed` is the gas of the whole transaction receipt. A batch transaction has no row, since its gas cannot be split.
 */
export const deliveryCosts = onchainTable(
  "delivery_costs",
  (t) => ({
    messageId: t.hex().primaryKey(),
    destinationChainId: t.integer().notNull(),
    transactionHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    gasUsed: t.bigint().notNull(),
    effectiveGasPrice: t.bigint().notNull(),
  }),
  (table) => ({ chainTimeIndex: index().on(table.destinationChainId, table.timestamp) }),
);

/** Gate events. `kind` is `confirmed`, `sealed`, `beacon_roots_detected` or `canary_fired`. */
export const gateEvents = onchainTable(
  "gate_events",
  (t) => ({
    id: t.text().primaryKey(),
    chainId: t.integer().notNull(),
    kind: t.text().notNull(),
    epoch: t.bigint(),
    version: t.hex(),
    slot: t.bigint(),
    canary: t.integer(),
    transactionHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({ chainIndex: index().on(table.chainId, table.timestamp) }),
);

/** The gate state on each chain, folded from its events. */
export const gateStates = onchainTable("gate_states", (t) => ({
  chainId: t.integer().primaryKey(),
  sealed: t.boolean().notNull(),
  sealedVersion: t.hex(),
  sealedSlot: t.bigint(),
  /** True once a beacon roots probe or a canary worked, or a confirmation happened. Null-free: starts false. */
  enforcing: t.boolean().notNull(),
  lastConfirmedEpoch: t.bigint(),
  lastConfirmedVersion: t.hex(),
  lastConfirmedTimestamp: t.bigint(),
  confirmations: t.integer().notNull(),
}));

/** Fork versions that the fork registry observed. */
export const registryObservations = onchainTable(
  "registry_observations",
  (t) => ({
    chainId: t.integer().notNull(),
    version: t.hex().notNull(),
    slot: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.chainId, table.version] }) }),
);

/** Bridge state on each chain: whether sends are open. */
export const bridgeStates = onchainTable("bridge_states", (t) => ({
  chainId: t.integer().primaryKey(),
  depositsOpen: t.boolean().notNull(),
  openedRemoteSlot: t.bigint(),
  openedBlockNumber: t.bigint(),
  openedTimestamp: t.bigint(),
}));
