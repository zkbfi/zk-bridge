import { decodeFunctionData, parseAbi, toEventSelector, toFunctionSelector, type Hex } from "viem";
import { ADDRESS, isObject } from "./values.ts";

/**
 * The rules of rpc.zkb.fi for one JSON-RPC request (docs/rpc-proxy.md). A request passes when its method is served and
 * its parameters stay around zkb.fi:
 *
 * - `eth_getLogs` names its addresses, each one a zkb.fi contract of the chain or a token the indexer knows (for a token,
 *   only its `Transfer` and `Approval` events);
 * - `eth_getProof` and `eth_getStorageAt` (when the configuration serves them) read a zkb.fi contract;
 * - `eth_call` and `eth_estimateGas` go to a zkb.fi contract (any function), to Multicall3 (each inner call is checked by
 *   the same rule), or to any other address with a token read of the exact ABI length (`anyAddressFunctions`) or an
 *   `approve` of the exact length whose spender is a zkb.fi contract; gas at most `maxCallGas` (the cap is forwarded as the gas of a call that names none); no state or block override;
 * - the other served methods the dapp uses pass only with the parameters of their own shape ({@link FIXED_SHAPES}); a
 *   served method that has no such shape is refused, so a configured method never forwards parameters nobody checked.
 *
 * A request that passes is REBUILT from what was checked ({@link checkRequest}): a fresh `{ jsonrpc, id, method, params }`
 * whose call object or log filter holds only the known keys, so the node never reads a field the filter did not see (a
 * key in another case, a duplicate key, an `input` beside `data`).
 *
 * "zkb.fi contract" means {@link ChainRules.contracts}: the deployment files, the contracts that a gate or a fork registry
 * of the deployment names, and the extra contracts of the configuration. The indexer's tokens are NOT in it: they are
 * {@link ChainRules.tokens}, which only widens `eth_getLogs`.
 */

/** One JSON-RPC request, as the filter accepts it. */
export type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: string;
  readonly params?: readonly unknown[];
};

/** What the rules need to know about one chain. Addresses are lower case. */
export type ChainRules = {
  readonly chainId: number;
  readonly methods: ReadonlySet<string>;
  /** The trusted contracts: any function, logs, proofs. */
  readonly contracts: ReadonlySet<string>;
  /** The tokens the indexer knows: their Transfer and Approval logs (token reads pass on any address anyway). */
  readonly tokens: ReadonlySet<string>;
  readonly multicall3: string;
  /** The four-byte selectors (lower case, with 0x) callable on any address, each with the exact calldata length in bytes. */
  readonly anyAddressSelectors: ReadonlyMap<string, number>;
  /** The most gas an `eth_call` or `eth_estimateGas` may name. */
  readonly maxCallGas: bigint;
};

/** Why a request was refused: the JSON-RPC error code and a sentence for the visitor. */
export type Refusal = { readonly code: number; readonly reason: string };

/** The outcome of {@link checkRequest}: the rebuilt request to forward, or why it is refused. */
export type Checked = { readonly ok: true; readonly request: JsonRpcRequest } | { readonly ok: false; readonly refusal: Refusal };

/** The code of a method that is not served (the JSON-RPC "method not found"). */
export const METHOD_NOT_SERVED = -32601;

/** The code of parameters that leave zkb.fi (the JSON-RPC "invalid params"). */
export const PARAMETERS_REFUSED = -32602;

/** The keys of a call object that are forwarded. Any other key is dropped. */
const CALL_KEYS = ["from", "to", "gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas", "value", "nonce", "accessList"] as const;

/** The keys of a log filter that are forwarded. */
const FILTER_KEYS = ["address", "topics", "fromBlock", "toBlock", "blockHash"] as const;

/** The events of a token whose logs pass: `Transfer` and `Approval`. */
const TOKEN_EVENTS = new Set([toEventSelector("Transfer(address,address,uint256)"), toEventSelector("Approval(address,address,uint256)")]);

const MULTICALL_ABI = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls)",
  "function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls)",
  "function aggregate((address target, bytes callData)[] calls)",
  "function tryAggregate(bool requireSuccess, (address target, bytes callData)[] calls)",
]);

const APPROVE_ABI = parseAbi(["function approve(address spender, uint256 amount)"]);
const APPROVE_SELECTOR = toFunctionSelector("approve(address,uint256)");
/** `approve(address,uint256)`: the selector and two words. */
const APPROVE_BYTES = 68;

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
/** A storage slot: a quantity (`0x0`) or a full 32-byte word. */
const SLOT = /^0x(?:[0-9a-fA-F]{1,64})$/;
const BLOCK_TAGS = new Set(["latest", "earliest", "pending", "safe", "finalized"]);

/**
 * The selectors of function signatures such as `balanceOf(address)`, each with its exact calldata length: four bytes
 * and one word per argument. The configuration allows static argument types only, so the length is fixed.
 */
export function selectorsOf(signatures: readonly string[]): ReadonlyMap<string, number> {
  return new Map(
    signatures.map((signature) => {
      const inside = signature.slice(signature.indexOf("(") + 1, -1);
      const words = inside === "" ? 0 : inside.split(",").length;
      return [toFunctionSelector(signature).toLowerCase(), 4 + 32 * words];
    }),
  );
}

const short = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** The first key of an object that equals another key when both are lower case, or null. */
function collidingKey(value: Record<string, unknown>): string | null {
  const seen = new Set<string>();
  for (const key of Object.keys(value)) {
    const lower = key.toLowerCase();
    if (seen.has(lower)) return key;
    seen.add(lower);
  }
  return null;
}

/** Copies the named keys that are present. */
function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

/**
 * Checks one request and rebuilds it from what was checked.
 *
 * @returns The fresh request to forward, or why it is refused.
 */
export function checkRequest(request: JsonRpcRequest, rules: ChainRules): Checked {
  const refuse = (code: number, reason: string): Checked => ({ ok: false, refusal: { code, reason } });
  if (!rules.methods.has(request.method)) return refuse(METHOD_NOT_SERVED, `${request.method} is not served here; rpc.zkb.fi answers only the reads the zkb.fi dapp makes`);
  const params = request.params ?? [];
  const pass = (rebuilt: readonly unknown[]): Checked => ({ ok: true, request: { jsonrpc: "2.0", id: request.id, method: request.method, params: rebuilt } });
  const refused = (reason: string) => refuse(PARAMETERS_REFUSED, reason);
  switch (request.method) {
    case "eth_getLogs": {
      const outcome = checkFilter(params[0], rules);
      return typeof outcome === "string" ? refused(outcome) : pass([outcome, ...params.slice(1)]);
    }
    case "eth_getProof":
    case "eth_getStorageAt": {
      if (!isContract(params[0], rules)) return refused(`${request.method} reads only zkb.fi contracts of chain ${rules.chainId}`);
      const rebuilt = request.method === "eth_getProof" ? proofParams(params) : storageParams(params);
      return rebuilt === null ? refused(`${request.method} takes ${request.method === "eth_getProof" ? "[address, storage keys, block]" : "[address, slot, block]"}, each checked`) : pass(rebuilt);
    }
    case "eth_call":
    case "eth_estimateGas": {
      const outcome = checkCall(request.method, params, rules);
      return typeof outcome === "string" ? refused(outcome) : pass([outcome, ...params.slice(1)]);
    }
    default: {
      const shape = FIXED_SHAPES[request.method];
      if (shape === undefined) return refused(`${request.method} has no parameter rule here, so it is not forwarded`);
      const rebuilt = shape(params);
      return rebuilt === null ? refused(`${request.method} has parameters of the wrong shape`) : pass(rebuilt);
    }
  }
}

/** A block tag (`latest`, ...) or a block number as a quantity. */
const isBlock = (value: unknown): value is string => typeof value === "string" && (BLOCK_TAGS.has(value) || QUANTITY.test(value));

/** `[address, storage keys, block]` with every field checked, or null. The address is checked by the caller. */
function proofParams(params: readonly unknown[]): unknown[] | null {
  const [address, keys, block] = params;
  if (params.length !== 3 || !Array.isArray(keys) || !keys.every((key) => typeof key === "string" && WORD.test(key)) || !isBlock(block)) return null;
  return [address, [...keys], block];
}

/** `[address, slot, block]` with every field checked, or null. The address is checked by the caller. */
function storageParams(params: readonly unknown[]): unknown[] | null {
  const [address, slot, block] = params;
  if (params.length !== 3 || typeof slot !== "string" || !SLOT.test(slot) || !isBlock(block)) return null;
  return [address, slot, block];
}

/** A rebuilder of the parameters of one method: the fresh array, or null when the given ones are not of that shape. */
type Shape = (params: readonly unknown[]) => unknown[] | null;

const noParams: Shape = (params) => (params.length === 0 ? [] : null);
const addressAndBlock: Shape = ([address, block, ...rest]) => (rest.length === 0 && typeof address === "string" && ADDRESS.test(address) && isBlock(block) ? [address, block] : null);
const oneHash: Shape = ([hash, ...rest]) => (rest.length === 0 && typeof hash === "string" && WORD.test(hash) ? [hash] : null);

/**
 * The parameters of the served methods that need no check of an address set, each rebuilt from checked fields. A method
 * that the configuration serves but that is not here is refused ({@link checkRequest}).
 */
const FIXED_SHAPES: Readonly<Record<string, Shape>> = {
  eth_chainId: noParams,
  eth_blockNumber: noParams,
  eth_gasPrice: noParams,
  eth_maxPriorityFeePerGas: noParams,
  eth_getBalance: addressAndBlock,
  eth_getCode: addressAndBlock,
  eth_getTransactionCount: addressAndBlock,
  eth_getTransactionByHash: oneHash,
  eth_getTransactionReceipt: oneHash,
  eth_getBlockByNumber: ([block, full, ...rest]) => (rest.length === 0 && isBlock(block) && typeof full === "boolean" ? [block, full] : null),
};

/**
 * Checks one request.
 *
 * @returns null when the request may pass, or why it may not.
 */
export function refusalOf(request: JsonRpcRequest, rules: ChainRules): Refusal | null {
  const checked = checkRequest(request, rules);
  return checked.ok ? null : checked.refusal;
}

const isContract = (value: unknown, rules: ChainRules): boolean => typeof value === "string" && ADDRESS.test(value) && rules.contracts.has(value.toLowerCase());

/** The rebuilt log filter, or why it is refused. */
function checkFilter(filter: unknown, rules: ChainRules): Record<string, unknown> | string {
  const needed = `eth_getLogs must name its addresses, all of them zkb.fi contracts or bridged tokens of chain ${rules.chainId}`;
  if (!isObject(filter)) return needed;
  const collision = collidingKey(filter);
  if (collision !== null) return `eth_getLogs has the key ${collision} twice in different cases`;
  const addresses = typeof filter.address === "string" ? [filter.address] : filter.address;
  if (!Array.isArray(addresses) || addresses.length === 0) return needed;
  let tokenNamed = false;
  for (const address of addresses) {
    if (isContract(address, rules)) continue;
    if (typeof address === "string" && ADDRESS.test(address) && rules.tokens.has(address.toLowerCase())) {
      tokenNamed = true;
      continue;
    }
    return typeof address === "string" && ADDRESS.test(address) ? `${needed}; ${short(address)} is neither` : needed;
  }
  if (tokenNamed && !onlyTokenEvents(filter.topics)) return "eth_getLogs of a token reads only its Transfer and Approval events (name them in topics[0])";
  return pick(filter, FILTER_KEYS);
}

/** Whether `topics[0]` names only Transfer or Approval. */
function onlyTokenEvents(topics: unknown): boolean {
  if (!Array.isArray(topics)) return false;
  const first: unknown = topics[0];
  const named = Array.isArray(first) ? first : [first];
  return named.length > 0 && named.every((topic) => typeof topic === "string" && TOKEN_EVENTS.has(topic.toLowerCase() as Hex));
}

/** The rebuilt call object, or why it is refused. */
function checkCall(method: string, params: readonly unknown[], rules: ChainRules): Record<string, unknown> | string {
  const [call] = params;
  if (!isObject(call)) return `${method} needs a call object`;
  // A third parameter overrides state or blocks: it could run any code at a zkb.fi address.
  if (params.length > 2) return `${method} takes no state or block override here`;
  const collision = collidingKey(call);
  if (collision !== null) return `${method} has the key ${collision} twice in different cases`;
  const { data, input, gas } = call;
  if (data !== undefined && input !== undefined && data !== input) return `${method} has both data and input, and they differ`;
  const calldata = input ?? data ?? "0x";
  if (typeof calldata !== "string" || !HEX.test(calldata)) return `${method} has calldata that is not hex`;
  if (gas !== undefined && (typeof gas !== "string" || !QUANTITY.test(gas) || BigInt(gas) > rules.maxCallGas)) return `${method} may name at most ${rules.maxCallGas} gas`;
  const reason = innerRefusal(call.to, calldata as Hex, rules, 0);
  if (reason !== null) return `${method}: ${reason}`;
  // One calldata field, the one checked; a plain send keeps none. A call that names no gas is forwarded with the cap as
  // its gas, so the upstream node's own, larger default never applies (inner calls of Multicall3 run under this gas).
  return { ...pick(call, CALL_KEYS), gas: gas ?? `0x${rules.maxCallGas.toString(16)}`, ...(data === undefined && input === undefined ? {} : { data: calldata }) };
}

/** Why a call (or a call inside Multicall3) leaves zkb.fi, or null. */
function innerRefusal(to: unknown, calldata: Hex, rules: ChainRules, depth: number): string | null {
  if (typeof to !== "string" || !ADDRESS.test(to)) return "a call must name the contract it goes to";
  const target = to.toLowerCase();
  if (rules.contracts.has(target)) return null;
  if (target === rules.multicall3) return depth === 0 ? multicallRefusal(calldata, rules) : "Multicall3 inside Multicall3 is not served";
  const selector = calldata.slice(0, 10).toLowerCase();
  const bytes = (calldata.length - 2) / 2;
  if (rules.anyAddressSelectors.get(selector) === bytes) return null;
  if (selector === APPROVE_SELECTOR && bytes === APPROVE_BYTES && approvesContract(calldata, rules)) return null;
  return `${short(target)} is not a zkb.fi contract of chain ${rules.chainId}, and the call is not a token read`;
}

function approvesContract(calldata: Hex, rules: ChainRules): boolean {
  const [spender] = decodeFunctionData({ abi: APPROVE_ABI, data: calldata }).args;
  return rules.contracts.has(spender.toLowerCase());
}

function multicallRefusal(calldata: Hex, rules: ChainRules): string | null {
  let calls: readonly { readonly target: string; readonly callData: Hex }[];
  try {
    const decoded = decodeFunctionData({ abi: MULTICALL_ABI, data: calldata });
    calls = decoded.functionName === "tryAggregate" ? decoded.args[1] : decoded.args[0];
  } catch {
    return "Multicall3 is served for aggregate3, aggregate3Value, aggregate and tryAggregate only";
  }
  for (const inner of calls) {
    const reason = innerRefusal(inner.target, inner.callData, rules, 1);
    if (reason !== null) return `inside Multicall3, ${reason}`;
  }
  return null;
}
