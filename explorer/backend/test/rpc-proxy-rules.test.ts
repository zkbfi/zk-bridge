import { describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi, multicall3Abi, parseAbi, type Hex } from "viem";
import { METHOD_NOT_SERVED, PARAMETERS_REFUSED, checkRequest, refusalOf, selectorsOf, type ChainRules, type JsonRpcRequest } from "../src/rpc-proxy/rules.ts";
import { DEFAULT_ANY_ADDRESS_FUNCTIONS, DEFAULT_RPC_METHODS, MULTICALL3_ADDRESS } from "../src/rpc-proxy/settings.ts";

const BRIDGE = "0x5897d3de91d59fb691e3887d6ffbba072384293a";
const MEDIATOR = "0x571F96605921F76A24CF1388C2CAF126B15B09F7";
const OTHER = "0x1111111111111111111111111111111111111111";
const USER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x6666666666666666666666666666666666666666";

const RULES: ChainRules = {
  chainId: 943,
  methods: new Set([...DEFAULT_RPC_METHODS, "eth_getProof", "eth_getStorageAt"]),
  contracts: new Set([BRIDGE, MEDIATOR.toLowerCase()]),
  tokens: new Set([TOKEN]),
  maxCallGas: 30_000_000n,
  multicall3: MULTICALL3_ADDRESS.toLowerCase(),
  anyAddressSelectors: selectorsOf(DEFAULT_ANY_ADDRESS_FUNCTIONS),
};

const request = (method: string, params?: readonly unknown[]): JsonRpcRequest => ({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });
const check = (method: string, params?: readonly unknown[]) => refusalOf(request(method, params), RULES);
const call = (to: unknown, data?: unknown, more: Record<string, unknown> = {}) => check("eth_call", [{ to, ...(data === undefined ? {} : { data }), ...more }, "latest"]);

const balanceOf = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [USER] });
const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [USER, 1n] });
const approve = (spender: `0x${string}`) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 5n] });
const bridgeRead = encodeFunctionData({ abi: parseAbi(["function depositsOpen() view returns (bool)"]), functionName: "depositsOpen" });

const aggregate3 = (calls: readonly { target: `0x${string}`; callData: Hex }[]) =>
  encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls.map((inner) => ({ ...inner, allowFailure: true }))] });
const legacyAbi = parseAbi(["function aggregate((address target, bytes callData)[] calls)", "function tryAggregate(bool requireSuccess, (address target, bytes callData)[] calls)"]);

describe("methods", () => {
  it("refuses a method that is not served, with the method-not-found code", () => {
    const refusal = check("eth_sendRawTransaction", ["0x00"]);
    expect(refusal?.code).toBe(METHOD_NOT_SERVED);
    expect(refusal?.reason).toMatch(/eth_sendRawTransaction is not served here/);
  });

  it("passes a served method without address parameters, with or without params", () => {
    expect(check("eth_chainId")).toBeNull();
    expect(check("eth_getBalance", [OTHER, "latest"])).toBeNull();
    expect(check("eth_getTransactionReceipt", [`0x${"ab".repeat(32)}`])).toBeNull();
  });
});

describe("eth_getLogs", () => {
  it("passes a filter whose addresses are all zkb.fi contracts, in any case", () => {
    expect(check("eth_getLogs", [{ address: BRIDGE, fromBlock: "0x1", toBlock: "0x2" }])).toBeNull();
    expect(check("eth_getLogs", [{ address: [BRIDGE, MEDIATOR], blockHash: `0x${"cd".repeat(32)}` }])).toBeNull();
  });

  it("refuses a filter without addresses, with an empty list, or that is no object", () => {
    for (const filter of [{ fromBlock: "0x1" }, { address: [] }, "latest", null]) {
      const refusal = check("eth_getLogs", [filter]);
      expect(refusal?.code).toBe(PARAMETERS_REFUSED);
      expect(refusal?.reason).toBe("eth_getLogs must name its addresses, all of them zkb.fi contracts or bridged tokens of chain 943");
    }
    expect(check("eth_getLogs")?.code).toBe(PARAMETERS_REFUSED);
  });

  it("names the first address that is not a zkb.fi contract", () => {
    expect(check("eth_getLogs", [{ address: [BRIDGE, OTHER] }])?.reason).toMatch(/0x1111…1111 is neither$/);
    expect(check("eth_getLogs", [{ address: [BRIDGE, 7] }])?.reason).toBe("eth_getLogs must name its addresses, all of them zkb.fi contracts or bridged tokens of chain 943");
  });
});

describe("eth_getProof and eth_getStorageAt", () => {
  it("read zkb.fi contracts only", () => {
    expect(check("eth_getProof", [BRIDGE, [], "latest"])).toBeNull();
    expect(check("eth_getStorageAt", [MEDIATOR, "0x0", "latest"])).toBeNull();
    expect(check("eth_getProof", [OTHER, [], "latest"])?.reason).toBe("eth_getProof reads only zkb.fi contracts of chain 943");
    expect(check("eth_getStorageAt", [42, "0x0", "latest"])?.code).toBe(PARAMETERS_REFUSED);
  });
});

describe("eth_call and eth_estimateGas", () => {
  it("passes any function of a zkb.fi contract, and a plain send to one", () => {
    expect(call(BRIDGE, bridgeRead)).toBeNull();
    expect(call(MEDIATOR, transfer)).toBeNull();
    expect(check("eth_estimateGas", [{ from: USER, to: BRIDGE, value: "0x1" }])).toBeNull();
    expect(check("eth_estimateGas", [{ from: USER, to: BRIDGE, input: bridgeRead }])).toBeNull();
  });

  it("passes the token reads on any address, and an approve toward a zkb.fi contract", () => {
    expect(call(OTHER, balanceOf)).toBeNull();
    expect(call(OTHER, encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }))).toBeNull();
    expect(check("eth_estimateGas", [{ from: USER, to: OTHER, data: approve(MEDIATOR.toLowerCase() as `0x${string}`) }])).toBeNull();
  });

  it("refuses another function on another address, an approve toward someone else, and a send to another address", () => {
    expect(call(OTHER, transfer)?.reason).toBe("eth_call: 0x1111…1111 is not a zkb.fi contract of chain 943, and the call is not a token read");
    expect(check("eth_estimateGas", [{ to: OTHER, data: approve(USER) }])?.code).toBe(PARAMETERS_REFUSED);
    expect(call(OTHER, "0x095ea7b3")?.code).toBe(PARAMETERS_REFUSED);
    expect(check("eth_estimateGas", [{ to: OTHER, value: "0x1" }])?.code).toBe(PARAMETERS_REFUSED);
  });

  it("refuses a call without a target, without a call object, with an override or with bad calldata", () => {
    expect(call(undefined, bridgeRead)?.reason).toBe("eth_call: a call must name the contract it goes to");
    expect(check("eth_call", ["latest"])?.reason).toBe("eth_call needs a call object");
    expect(check("eth_call", [{ to: BRIDGE, data: bridgeRead }, "latest", { [BRIDGE]: { code: "0x00" } }])?.reason).toBe("eth_call takes no state or block override here");
    expect(call(BRIDGE, "0xzz")?.reason).toBe("eth_call has calldata that is not hex");
    expect(call(BRIDGE, 12)?.reason).toBe("eth_call has calldata that is not hex");
    expect(call(BRIDGE, bridgeRead, { input: balanceOf })?.reason).toBe("eth_call has both data and input, and they differ");
    expect(call(BRIDGE, bridgeRead, { input: bridgeRead })).toBeNull();
  });
});

describe("Multicall3", () => {
  it("passes an aggregate3 whose every call passes on its own", () => {
    expect(call(MULTICALL3_ADDRESS, aggregate3([{ target: BRIDGE, callData: bridgeRead }, { target: OTHER, callData: balanceOf }]))).toBeNull();
  });

  it("checks aggregate and tryAggregate the same way", () => {
    expect(call(MULTICALL3_ADDRESS, encodeFunctionData({ abi: legacyAbi, functionName: "aggregate", args: [[{ target: BRIDGE, callData: bridgeRead }]] }))).toBeNull();
    expect(call(MULTICALL3_ADDRESS, encodeFunctionData({ abi: legacyAbi, functionName: "tryAggregate", args: [false, [{ target: OTHER, callData: transfer }]] }))?.reason).toMatch(/inside Multicall3, 0x1111…1111 is not a zkb.fi contract/);
  });

  it("refuses an aggregate3 with one call that leaves zkb.fi", () => {
    const refusal = call(MULTICALL3_ADDRESS, aggregate3([{ target: BRIDGE, callData: bridgeRead }, { target: OTHER, callData: transfer }]));
    expect(refusal?.reason).toBe("eth_call: inside Multicall3, 0x1111…1111 is not a zkb.fi contract of chain 943, and the call is not a token read");
  });

  it("refuses Multicall3 inside Multicall3, and any other Multicall3 function", () => {
    const inner = aggregate3([{ target: BRIDGE, callData: bridgeRead }]);
    expect(call(MULTICALL3_ADDRESS, aggregate3([{ target: MULTICALL3_ADDRESS, callData: inner }]))?.reason).toBe("eth_call: inside Multicall3, Multicall3 inside Multicall3 is not served");
    expect(call(MULTICALL3_ADDRESS, encodeFunctionData({ abi: parseAbi(["function getBlockNumber() view returns (uint256)"]), functionName: "getBlockNumber" }))?.reason).toBe(
      "eth_call: Multicall3 is served for aggregate3, aggregate3Value, aggregate and tryAggregate only",
    );
  });
});

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

describe("tokens the indexer knows", () => {
  it("pass eth_getLogs for their Transfer and Approval events only", () => {
    expect(check("eth_getLogs", [{ address: [BRIDGE, TOKEN], topics: [TRANSFER] }])).toBeNull();
    expect(check("eth_getLogs", [{ address: TOKEN, topics: [[TRANSFER, APPROVAL.toUpperCase().replace("0X", "0x")], null] }])).toBeNull();
    const reason = "eth_getLogs of a token reads only its Transfer and Approval events (name them in topics[0])";
    expect(check("eth_getLogs", [{ address: TOKEN }])?.reason).toBe(reason);
    expect(check("eth_getLogs", [{ address: TOKEN, topics: [] }])?.reason).toBe(reason);
    expect(check("eth_getLogs", [{ address: TOKEN, topics: [[]] }])?.reason).toBe(reason);
    expect(check("eth_getLogs", [{ address: TOKEN, topics: [`0x${"12".repeat(32)}`] }])?.reason).toBe(reason);
    // A zkb.fi contract alone needs no topic.
    expect(check("eth_getLogs", [{ address: BRIDGE }])).toBeNull();
  });

  it("are not trusted as contracts: no other function, no proof", () => {
    expect(call(TOKEN, transfer)?.code).toBe(PARAMETERS_REFUSED);
    expect(call(TOKEN, balanceOf)).toBeNull();
    expect(check("eth_getProof", [TOKEN, [], "latest"])?.code).toBe(PARAMETERS_REFUSED);
  });
});

describe("exact lengths and the gas cap", () => {
  it("refuses a token read or an approve with calldata longer or shorter than its ABI", () => {
    expect(call(OTHER, `${balanceOf}00`)?.code).toBe(PARAMETERS_REFUSED);
    expect(call(OTHER, balanceOf.slice(0, -2))?.code).toBe(PARAMETERS_REFUSED);
    expect(call(OTHER, `${encodeFunctionData({ abi: erc20Abi, functionName: "decimals" })}${"00".repeat(32)}`)?.code).toBe(PARAMETERS_REFUSED);
    expect(call(OTHER, `${approve(MEDIATOR.toLowerCase() as `0x${string}`)}${"00".repeat(32)}`)?.code).toBe(PARAMETERS_REFUSED);
    expect([...selectorsOf(["allowance(address,address)", "totalSupply()"]).values()]).toEqual([68, 4]);
  });

  it("caps the gas a call may name", () => {
    expect(call(BRIDGE, bridgeRead, { gas: "0x1c9c380" })).toBeNull();
    expect(call(BRIDGE, bridgeRead, { gas: "0x1c9c381" })?.reason).toBe("eth_call may name at most 30000000 gas");
    expect(call(BRIDGE, bridgeRead, { gas: 5 })?.code).toBe(PARAMETERS_REFUSED);
    expect(call(BRIDGE, bridgeRead, { gas: "0x" })?.code).toBe(PARAMETERS_REFUSED);
  });
});

describe("the gas of a forwarded call", () => {
  const forwarded = (method: string, call: Record<string, unknown>, rules = RULES) => {
    const checked = checkRequest({ jsonrpc: "2.0", id: 5, method, params: [call, "latest"] } as JsonRpcRequest, rules);
    if (!checked.ok) throw new Error(checked.refusal.reason);
    return (checked.request.params as readonly Record<string, unknown>[])[0] ?? {};
  };

  it("names the cap when the call names no gas, so the upstream node's own default never applies", () => {
    expect(forwarded("eth_call", { to: BRIDGE, data: bridgeRead }).gas).toBe("0x1c9c380");
    expect(forwarded("eth_estimateGas", { to: BRIDGE, value: "0x1" }).gas).toBe("0x1c9c380");
    expect(forwarded("eth_call", { to: BRIDGE, data: bridgeRead }, { ...RULES, maxCallGas: 21_000n }).gas).toBe("0x5208");
  });

  it("leaves a gas within the cap as it was named, and still refuses one above it", () => {
    expect(forwarded("eth_call", { to: BRIDGE, data: bridgeRead, gas: "0x10" }).gas).toBe("0x10");
    expect(forwarded("eth_call", { to: BRIDGE, data: bridgeRead, gas: "0x1c9c380" }).gas).toBe("0x1c9c380");
    expect(call(BRIDGE, bridgeRead, { gas: "0x1c9c381" })?.reason).toBe("eth_call may name at most 30000000 gas");
  });

  it("covers the calls inside Multicall3 with the gas of the outer call", () => {
    const data = aggregate3([{ target: BRIDGE, callData: bridgeRead }]);
    expect(forwarded("eth_call", { to: RULES.multicall3, data }).gas).toBe("0x1c9c380");
  });
});

describe("the rebuilt request", () => {
  const rebuilt = (method: string, params: readonly unknown[]) => {
    const checked = checkRequest({ jsonrpc: "2.0", id: 5, method, params, extra: "dropped" } as JsonRpcRequest, RULES);
    if (!checked.ok) throw new Error(checked.refusal.reason);
    return checked.request;
  };

  it("keeps only the known keys of a call, with the checked calldata as data", () => {
    expect(rebuilt("eth_call", [{ to: BRIDGE, input: bridgeRead, gas: "0x10", from: USER, stateDiff: { x: 1 }, code: "0x00" }, "latest"])).toEqual({
      jsonrpc: "2.0",
      id: 5,
      method: "eth_call",
      params: [{ to: BRIDGE, gas: "0x10", from: USER, data: bridgeRead }, "latest"],
    });
    expect(rebuilt("eth_estimateGas", [{ to: BRIDGE, value: "0x1", gas: "0x5208" }]).params).toEqual([{ to: BRIDGE, value: "0x1", gas: "0x5208" }]);
  });

  it("keeps only the known keys of a log filter, and passes other methods' params as they are", () => {
    expect(rebuilt("eth_getLogs", [{ address: BRIDGE, fromBlock: "0x1", toBlock: "0x2", topics: [null], blockhash: "x", limit: 9 }]).params).toEqual([
      { address: BRIDGE, fromBlock: "0x1", toBlock: "0x2", topics: [null] },
    ]);
    expect(rebuilt("eth_getBalance", [USER, "latest"])).toEqual({ jsonrpc: "2.0", id: 5, method: "eth_getBalance", params: [USER, "latest"] });
    expect(rebuilt("eth_chainId", [])).toEqual({ jsonrpc: "2.0", id: 5, method: "eth_chainId", params: [] });
  });

  it("refuses a call or filter with a key twice in different cases", () => {
    expect(call(BRIDGE, bridgeRead, { To: OTHER })?.reason).toBe("eth_call has the key To twice in different cases");
    expect(check("eth_getLogs", [{ address: BRIDGE, Address: OTHER }])?.reason).toBe("eth_getLogs has the key Address twice in different cases");
  });
});

describe("rebuilt parameters of the methods without a checked object", () => {
  const SLOT = `0x${"00".repeat(31)}01`;
  const HASH = `0x${"ab".repeat(32)}`;
  const params = (method: string, given: readonly unknown[]) => {
    const checked = checkRequest(request(method, given), RULES);
    return checked.ok ? checked.request.params : checked.refusal.reason;
  };

  it("eth_getProof forwards [address, storage keys, block tag] and refuses anything else", () => {
    expect(params("eth_getProof", [BRIDGE, [SLOT, HASH], "0x10"])).toEqual([BRIDGE, [SLOT, HASH], "0x10"]);
    expect(params("eth_getProof", [BRIDGE, [], "finalized"])).toEqual([BRIDGE, [], "finalized"]);
    expect(check("eth_getProof", [BRIDGE, [], "latest", "extra"])?.code).toBe(PARAMETERS_REFUSED);
    expect(check("eth_getProof", [BRIDGE, [], "latest", { stateOverride: 1 }])?.code).toBe(PARAMETERS_REFUSED);
    expect(check("eth_getProof", [BRIDGE, []])?.code).toBe(PARAMETERS_REFUSED);
    for (const keys of ["0x01", [1], ["0x01"], [`${SLOT}00`], [{ a: 1 }]]) expect(check("eth_getProof", [BRIDGE, keys, "latest"])?.code).toBe(PARAMETERS_REFUSED);
    for (const tag of ["soon", "0x", 5, null, { blockNumber: "0x1" }, "0x" + "1".repeat(65)]) expect(check("eth_getProof", [BRIDGE, [], tag])?.code).toBe(PARAMETERS_REFUSED);
  });

  it("eth_getStorageAt forwards [address, slot, block tag] and refuses anything else", () => {
    expect(params("eth_getStorageAt", [MEDIATOR, "0x0", "latest"])).toEqual([MEDIATOR, "0x0", "latest"]);
    expect(params("eth_getStorageAt", [MEDIATOR, SLOT, "0x5"])).toEqual([MEDIATOR, SLOT, "0x5"]);
    expect(check("eth_getStorageAt", [MEDIATOR, SLOT, "latest", "extra"])?.code).toBe(PARAMETERS_REFUSED);
    expect(check("eth_getStorageAt", [MEDIATOR, SLOT])?.code).toBe(PARAMETERS_REFUSED);
    for (const slot of ["zz", 1, "0x", `0x${"11".repeat(33)}`, null]) expect(check("eth_getStorageAt", [MEDIATOR, slot, "latest"])?.code).toBe(PARAMETERS_REFUSED);
    expect(check("eth_getStorageAt", [MEDIATOR, SLOT, "tomorrow"])?.code).toBe(PARAMETERS_REFUSED);
  });

  it("the parameterless methods take none, and drop nothing silently", () => {
    for (const method of ["eth_chainId", "eth_blockNumber", "eth_gasPrice", "eth_maxPriorityFeePerGas"]) {
      expect(params(method, [])).toEqual([]);
      expect(params(method, undefined as never)).toEqual([]);
      expect(check(method, ["x"])?.code).toBe(PARAMETERS_REFUSED);
    }
  });

  it("the address reads take [address, block tag]", () => {
    for (const method of ["eth_getBalance", "eth_getCode", "eth_getTransactionCount"]) {
      expect(params(method, [USER, "latest"])).toEqual([USER, "latest"]);
      expect(check(method, [USER, "latest", "extra"])?.code).toBe(PARAMETERS_REFUSED);
      expect(check(method, [USER])?.code).toBe(PARAMETERS_REFUSED);
      expect(check(method, ["nope", "latest"])?.code).toBe(PARAMETERS_REFUSED);
      expect(check(method, [USER, "later"])?.code).toBe(PARAMETERS_REFUSED);
    }
  });

  it("the transaction lookups take one 32-byte hash, and the block lookup [block tag, boolean]", () => {
    for (const method of ["eth_getTransactionByHash", "eth_getTransactionReceipt"]) {
      expect(params(method, [HASH])).toEqual([HASH]);
      expect(check(method, [HASH, 1])?.code).toBe(PARAMETERS_REFUSED);
      expect(check(method, ["0x12"])?.code).toBe(PARAMETERS_REFUSED);
    }
    expect(params("eth_getBlockByNumber", ["0x10", false])).toEqual(["0x10", false]);
    expect(params("eth_getBlockByNumber", ["latest", true])).toEqual(["latest", true]);
    expect(check("eth_getBlockByNumber", ["latest"])?.code).toBe(PARAMETERS_REFUSED);
    expect(check("eth_getBlockByNumber", ["latest", "yes"])?.code).toBe(PARAMETERS_REFUSED);
    expect(check("eth_getBlockByNumber", ["latest", false, 1])?.code).toBe(PARAMETERS_REFUSED);
    expect(check("eth_getBlockByNumber", ["nonsense", false])?.code).toBe(PARAMETERS_REFUSED);
  });

  it("refuses a configured method that has no parameter rule", () => {
    const rules = { ...RULES, methods: new Set([...RULES.methods, "eth_newFilter"]) };
    const refusal = refusalOf(request("eth_newFilter", [{}]), rules);
    expect(refusal?.code).toBe(PARAMETERS_REFUSED);
    expect(refusal?.reason).toBe("eth_newFilter has no parameter rule here, so it is not forwarded");
  });
});
