import { decodeFunctionData, parseAbi, toFunctionSelector, type Hex } from "viem";

/**
 * The rules of rpc.zkb.fi for one JSON-RPC request (docs/rpc-proxy.md). A request passes when its method is served and
 * its parameters stay around zkb.fi:
 *
 * - `eth_getLogs` names its addresses, and each one is a zkb.fi contract of the chain;
 * - `eth_getProof` and `eth_getStorageAt` (when the configuration serves them) read a zkb.fi contract;
 * - `eth_call` and `eth_estimateGas` go to a zkb.fi contract (any function), to Multicall3 (each inner call is checked by
 *   the same rule), or to any other address with a token read (`anyAddressFunctions`) or an `approve` whose spender is a
 *   zkb.fi contract; no state or block override;
 * - every other served method passes as it is.
 *
 * "zkb.fi contract" means the set of {@link ChainRules.contracts}: the deployment files, the contracts a gate or a fork
 * registry names, the bridged tokens the indexer knows, and the extra contracts of the configuration.
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
  readonly contracts: ReadonlySet<string>;
  readonly multicall3: string;
  /** The four-byte selectors, lower case with 0x, callable on any address. */
  readonly anyAddressSelectors: ReadonlySet<string>;
};

/** Why a request was refused: the JSON-RPC error code and a sentence for the visitor. */
export type Refusal = { readonly code: number; readonly reason: string };

/** The code of a method that is not served (the JSON-RPC "method not found"). */
export const METHOD_NOT_SERVED = -32601;

/** The code of parameters that leave zkb.fi (the JSON-RPC "invalid params"). */
export const PARAMETERS_REFUSED = -32602;

const MULTICALL_ABI = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls)",
  "function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls)",
  "function aggregate((address target, bytes callData)[] calls)",
  "function tryAggregate(bool requireSuccess, (address target, bytes callData)[] calls)",
]);

const APPROVE_ABI = parseAbi(["function approve(address spender, uint256 amount)"]);
const APPROVE_SELECTOR = toFunctionSelector("approve(address,uint256)");

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

/** The selectors of function signatures such as `balanceOf(address)`. */
export function selectorsOf(signatures: readonly string[]): ReadonlySet<string> {
  return new Set(signatures.map((signature) => toFunctionSelector(signature).toLowerCase()));
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const short = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * Checks one request.
 *
 * @returns null when the request may pass, or why it may not.
 */
export function refusalOf(request: JsonRpcRequest, rules: ChainRules): Refusal | null {
  if (!rules.methods.has(request.method)) return { code: METHOD_NOT_SERVED, reason: `${request.method} is not served here; rpc.zkb.fi answers only the reads the zkb.fi dapp makes` };
  const params = request.params ?? [];
  const refused = (reason: string): Refusal => ({ code: PARAMETERS_REFUSED, reason });
  switch (request.method) {
    case "eth_getLogs":
      return logsRefusal(params[0], rules, refused);
    case "eth_getProof":
    case "eth_getStorageAt":
      return isContract(params[0], rules) ? null : refused(`${request.method} reads only zkb.fi contracts of chain ${rules.chainId}`);
    case "eth_call":
    case "eth_estimateGas":
      return callRefusal(request.method, params, rules, refused);
    default:
      return null;
  }
}

const isContract = (value: unknown, rules: ChainRules): boolean => typeof value === "string" && ADDRESS.test(value) && rules.contracts.has(value.toLowerCase());

function logsRefusal(filter: unknown, rules: ChainRules, refused: (reason: string) => Refusal): Refusal | null {
  const needed = `eth_getLogs must name its addresses, all of them zkb.fi contracts of chain ${rules.chainId}`;
  if (!isObject(filter)) return refused(needed);
  const addresses = typeof filter.address === "string" ? [filter.address] : filter.address;
  if (!Array.isArray(addresses) || addresses.length === 0) return refused(needed);
  const outside = addresses.find((address) => !isContract(address, rules));
  if (outside === undefined) return null;
  return refused(typeof outside === "string" && ADDRESS.test(outside) ? `${needed}; ${short(outside)} is not one` : needed);
}

function callRefusal(method: string, params: readonly unknown[], rules: ChainRules, refused: (reason: string) => Refusal): Refusal | null {
  const [call] = params;
  if (!isObject(call)) return refused(`${method} needs a call object`);
  // A third parameter overrides state or blocks: it could run any code at a zkb.fi address.
  if (params.length > 2) return refused(`${method} takes no state or block override here`);
  const { data, input } = call;
  if (data !== undefined && input !== undefined && data !== input) return refused(`${method} has both data and input, and they differ`);
  const calldata = input ?? data ?? "0x";
  if (typeof calldata !== "string" || !HEX.test(calldata)) return refused(`${method} has calldata that is not hex`);
  const reason = innerRefusal(call.to, calldata as Hex, rules, 0);
  return reason === null ? null : refused(`${method}: ${reason}`);
}

/** Why a call (or a call inside Multicall3) leaves zkb.fi, or null. */
function innerRefusal(to: unknown, calldata: Hex, rules: ChainRules, depth: number): string | null {
  if (typeof to !== "string" || !ADDRESS.test(to)) return "a call must name the contract it goes to";
  const target = to.toLowerCase();
  if (rules.contracts.has(target)) return null;
  if (target === rules.multicall3) return depth === 0 ? multicallRefusal(calldata, rules) : "Multicall3 inside Multicall3 is not served";
  const selector = calldata.slice(0, 10).toLowerCase();
  if (rules.anyAddressSelectors.has(selector)) return null;
  if (selector === APPROVE_SELECTOR && approvesContract(calldata, rules)) return null;
  return `${short(target)} is not a zkb.fi contract of chain ${rules.chainId}, and the call is not a token read`;
}

function approvesContract(calldata: Hex, rules: ChainRules): boolean {
  try {
    const [spender] = decodeFunctionData({ abi: APPROVE_ABI, data: calldata }).args;
    return rules.contracts.has(spender.toLowerCase());
  } catch {
    return false;
  }
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
