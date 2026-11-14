import { describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi, multicall3Abi, parseAbi, type Hex } from "viem";
import { METHOD_NOT_SERVED, PARAMETERS_REFUSED, refusalOf, selectorsOf, type ChainRules, type JsonRpcRequest } from "../src/rpc-proxy/rules.ts";
import { DEFAULT_ANY_ADDRESS_FUNCTIONS, DEFAULT_RPC_METHODS, MULTICALL3_ADDRESS } from "../src/rpc-proxy/settings.ts";

const BRIDGE = "0x5897d3de91d59fb691e3887d6ffbba072384293a";
const MEDIATOR = "0x571F96605921F76A24CF1388C2CAF126B15B09F7";
const OTHER = "0x1111111111111111111111111111111111111111";
const USER = "0x2222222222222222222222222222222222222222";

const RULES: ChainRules = {
  chainId: 943,
  methods: new Set([...DEFAULT_RPC_METHODS, "eth_getProof", "eth_getStorageAt"]),
  contracts: new Set([BRIDGE, MEDIATOR.toLowerCase()]),
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
      expect(refusal?.reason).toBe("eth_getLogs must name its addresses, all of them zkb.fi contracts of chain 943");
    }
    expect(check("eth_getLogs")?.code).toBe(PARAMETERS_REFUSED);
  });

  it("names the first address that is not a zkb.fi contract", () => {
    expect(check("eth_getLogs", [{ address: [BRIDGE, OTHER] }])?.reason).toMatch(/0x1111…1111 is not one$/);
    expect(check("eth_getLogs", [{ address: [BRIDGE, 7] }])?.reason).toBe("eth_getLogs must name its addresses, all of them zkb.fi contracts of chain 943");
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
