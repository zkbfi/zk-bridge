import { z } from "zod";
import { ADDRESS } from "./values.ts";

/**
 * The settings of the `rpc-proxy` module: the filter in front of eRPC that serves `https://rpc.zkb.fi/<chainId>`
 * (docs/rpc-proxy.md). Every limit lives here, with its default; `backend.json` changes any of them under `rpcProxy`.
 */

/**
 * The JSON-RPC methods that the dapp (explorer/web and the code it bundles from terminal, data, core, shared and react)
 * sends to a chain RPC, found by listing every viem action it calls. Nothing else is served. Each one, and why:
 *
 * | Method                     | Who sends it                                                                                          |
 * |----------------------------|-------------------------------------------------------------------------------------------------------|
 * | `eth_chainId`              | `getChainId` (data/rpc/chain-reader, at-block); the Settings check of an RPC (data/connection-test)    |
 * | `eth_blockNumber`          | `getBlockNumber` (core/token-pricing, data/prover/light-client); the polling of `waitForTransactionReceipt` |
 * | `eth_getBlockByNumber`     | `getBlock` by tag or number (data/rpc, gate-evidence, Explore's block page); `estimateFeesPerGas` (base fee); the replacement check of `waitForTransactionReceipt` |
 * | `eth_getTransactionByHash` | Explore's transaction page (web/explore/chain-reader); `waitForTransactionReceipt`                      |
 * | `eth_getTransactionReceipt`| `getTransactionReceipt` (data/rpc, Explore); `waitForTransactionReceipt` after each send                 |
 * | `eth_call`                 | `readContract` and its Multicall3 batches (every contract read); `call` to the beacon roots contract (data/gate-evidence) |
 * | `eth_estimateGas`          | `prepareTransaction` (terminal/tx/prepare) before each send; the seal and observe offers (data/gate-evidence, fork-observation, fork-cutover-check) |
 * | `eth_getLogs`              | the RPC data source when the indexer is down (data/rpc/chain-scan, history-scan)                       |
 * | `eth_getBalance`           | the account panel (terminal/chain/live-reads); Explore's address page                                 |
 * | `eth_getCode`              | Explore's address page (contract or account)                                                           |
 * | `eth_getTransactionCount`  | the pending nonce in `prepareTransaction`; Explore's address page                                      |
 * | `eth_maxPriorityFeePerGas` | `estimateFeesPerGas` (the fee lines of the transaction dialog, web/app/queries)                        |
 * | `eth_gasPrice`             | `estimateFeesPerGas` when a node has no `eth_maxPriorityFeePerGas`                                     |
 *
 * Not served: `eth_sendRawTransaction` (a wallet sends through its own RPC), `eth_getProof` and `eth_getStorageAt` (the
 * dapp never asks; the backend and the prover read proofs through their own RPC), filters and subscriptions.
 */
export const DEFAULT_RPC_METHODS: readonly string[] = [
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_call",
  "eth_estimateGas",
  "eth_getLogs",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount",
  "eth_maxPriorityFeePerGas",
  "eth_gasPrice",
];

/**
 * The functions that `eth_call` and `eth_estimateGas` may call on any address, not only a zkb.fi contract, with calldata
 * of exactly the ABI length (the selector and one word per argument): the ERC-20
 * reads, so a custom token loads (web/bridge/custom-token, data/token-facts, the balances and allowances of the account
 * panel), and the two pool reads of the PulseChain prices (core/token-pricing reads `getReserves()` and `token0()` of a
 * PulseX pair, whose address the factory gives).
 */
export const DEFAULT_ANY_ADDRESS_FUNCTIONS: readonly string[] = [
  "name()",
  "symbol()",
  "decimals()",
  "balanceOf(address)",
  "allowance(address,address)",
  "totalSupply()",
  "getReserves()",
  "token0()",
];

/** Multicall3, at the same address on all four chains (terminal/chain/rpc-transport checked it with eth_getCode). */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** The EIP-4788 beacon roots contract that a gate reads (data/gate-evidence calls it before a seal). */
export const BEACON_ROOTS_ADDRESS = "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02";

/**
 * The contracts of PulseChain that the dapp reads besides its own: the two PulseX factories and the Omnibridge, which
 * price tokens (core/pulsex-pricing). The prices are read on PulseChain whatever pair the page shows.
 */
export const PULSECHAIN_PRICE_CONTRACTS: readonly string[] = [
  "0x1715a3E4A142d8b698131108995174F37aEBA10D",
  "0x29eA7545DEf87022BAdc76323F373EA1e707C523",
  "0x4fD0aaa7506f3d9cB8274bdB946Ec42A1b8751Ef",
];

const address = z.string().regex(ADDRESS, "must be an address (0x and 40 hex digits)");
const STATIC_TYPE = "(?:address|bool|u?int(?:8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?|bytes(?:[1-9]|[12][0-9]|3[0-2]))";
/** A function with static arguments only, so its calldata has one exact length (the filter checks it). */
const functionSignature = z.string().regex(new RegExp(`^[A-Za-z_][A-Za-z0-9_]*\\((?:${STATIC_TYPE}(?:,${STATIC_TYPE})*)?\\)$`), "must be a function signature with static arguments, such as balanceOf(address)");
const chainSettings = z.object({ extraContracts: z.array(address).default([]) }).strict();

/** The chains served by default: Ethereum, PulseChain, Sepolia and PulseChain testnet v4. */
export const DEFAULT_RPC_CHAINS = {
  "1": { extraContracts: [] },
  "369": { extraContracts: [...PULSECHAIN_PRICE_CONTRACTS] },
  "11155111": { extraContracts: [] },
  "943": { extraContracts: [] },
};

/** The `rpcProxy` section of the backend configuration. */
export const rpcProxySchema = z
  .object({
    /** Where eRPC listens, with `{chainId}` for the chain. Localhost: eRPC is never reached from outside. */
    upstreamUrl: z
      .string()
      .regex(/^https?:\/\/\S+$/, "must be an http or https address")
      .refine((value) => value.includes("{chainId}"), { message: "must hold {chainId}" })
      .default("http://127.0.0.1:8792/zkb/evm/{chainId}"),
    /** How long one answer of eRPC may take. */
    timeoutSeconds: z.number().int().min(1).max(300).default(30),
    /** The largest request body, in bytes. A batch of 50 reads is about 15 KB. */
    maxBodyBytes: z.number().int().min(1024).max(10_485_760).default(262_144),
    /** The largest answer of eRPC that is passed on, in bytes (`eth_getLogs` and full blocks are the large ones). */
    maxResponseBytes: z.number().int().min(65_536).max(268_435_456).default(33_554_432),
    /** The most requests in one batch. viem batches at most 50 (terminal/chain/rpc-transport). */
    maxBatchLength: z.number().int().min(1).max(1000).default(50),
    /** The methods served. See {@link DEFAULT_RPC_METHODS}. eRPC's `allowMethods` (deploy/app-server/config/erpc) mirrors this list. */
    methods: z.array(z.string().regex(/^[a-z0-9]+_[A-Za-z0-9]+$/, "must be a JSON-RPC method name")).min(1).default([...DEFAULT_RPC_METHODS]),
    /** The functions callable on any address. See {@link DEFAULT_ANY_ADDRESS_FUNCTIONS}. */
    anyAddressFunctions: z.array(functionSignature).default([...DEFAULT_ANY_ADDRESS_FUNCTIONS]),
    /** The most gas an eth_call or eth_estimateGas may name (the dapp names none; nodes cap a call at about 50 million). */
    maxCallGas: z.number().int().min(21_000).max(1_000_000_000).default(30_000_000),
    /** Multicall3: every call inside an `aggregate3` (or `aggregate`, `tryAggregate`) call is checked like a call of its own. */
    multicall3: address.default(MULTICALL3_ADDRESS),
    /** Contracts allowed on every served chain, besides those of the deployment files. */
    extraContracts: z.array(address).default([BEACON_ROOTS_ADDRESS]),
    /** The chains served, by chain id, each with contracts of its own besides those of the deployment files. */
    chains: z.record(z.string().regex(/^\d+$/), chainSettings).default(DEFAULT_RPC_CHAINS),
    /** The deployment files whose contracts are allowed. Default: the backend's `deploymentFile`. */
    deploymentFiles: z.array(z.string().min(1)).min(1).optional(),
    /**
     * How often the bridged tokens (from the indexer's `/api/tokens`) and the contracts that a gate or a fork registry
     * names (its registry, its beacon roots contract, the registry's light client) are read again.
     */
    refreshSeconds: z.number().int().min(10).max(86_400).default(300),
  })
  .strict();

/** The parsed `rpcProxy` section. */
export type RpcProxySettings = z.infer<typeof rpcProxySchema>;
