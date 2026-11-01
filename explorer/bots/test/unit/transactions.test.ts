import { BaseError, RpcRequestError, createPublicClient, custom, parseTransaction, recoverTransactionAddress, type Hex, type PublicClient, type TransactionSerializableEIP1559 } from "viem";
import { describe, expect, it, vi } from "vitest";
import { signerFromPrivateKeyText } from "../../../terminal/src/signing/key-sources.ts";
import { createTransactionPort, GAS_BUFFER_PERCENT, SIMULATION_GAS_LIMIT, sendTerms, worstCaseCostWei } from "../../src/chain/transactions.ts";
import type { Signer } from "../../src/signing/open-signer.ts";
import { address, word } from "../support/builders.ts";

// The first public development key of Anvil.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TARGET = address(0x55);
const DATA: Hex = "0xdeadbeef";
const SIMULATED = { gas: SIMULATION_GAS_LIMIT, maxFeePerGas: null };

interface ClientOverrides {
  baseFeePerGas?: bigint | null | undefined;
  call?: () => Promise<{ data?: Hex }>;
  estimateGas?: () => Promise<bigint>;
  receiptStatus?: "success" | "reverted";
  sendRawTransaction?: (arguments_: { serializedTransaction: Hex }) => Promise<Hex>;
}

function fakeClient(overrides: ClientOverrides = {}) {
  const client = {
    getBlock: vi.fn(async () => ({ baseFeePerGas: "baseFeePerGas" in overrides ? overrides.baseFeePerGas : 100n })),
    estimateMaxPriorityFeePerGas: vi.fn(async () => 7n),
    call: vi.fn(overrides.call ?? (async () => ({ data: "0xabcd" as Hex }))),
    estimateGas: vi.fn(overrides.estimateGas ?? (async () => 50_000n)),
    getTransactionCount: vi.fn(async () => 42),
    sendRawTransaction: vi.fn(overrides.sendRawTransaction ?? (async () => word(0xaa))),
    waitForTransactionReceipt: vi.fn(async () => ({
      status: overrides.receiptStatus ?? "success",
      gasUsed: 31_000n,
      effectiveGasPrice: 107n,
      blockNumber: 9n,
      logs: [{ address: TARGET, topics: [word(1)], data: "0x01" as Hex, logIndex: 3, removed: false }],
    })),
  };
  return client;
}

function portOver(client: ReturnType<typeof fakeClient>, extra: { priorityFeeWei?: bigint; minimumPriorityFeeWei?: bigint; signer?: Signer } = {}) {
  return createTransactionPort({
    client: client as unknown as PublicClient,
    signer: extra.signer ?? signerFromPrivateKeyText(ANVIL_KEY),
    chainId: 369,
    receiptTimeoutMilliseconds: 12_345,
    ...(extra.priorityFeeWei === undefined ? {} : { priorityFeeWei: extra.priorityFeeWei }),
    ...(extra.minimumPriorityFeeWei === undefined ? {} : { minimumPriorityFeeWei: extra.minimumPriorityFeeWei }),
  });
}

describe("the terms of a send", () => {
  it("adds the gas buffer, doubles the base fee and adds the priority fee once", () => {
    expect(GAS_BUFFER_PERCENT).toBe(30n);
    expect(sendTerms({ baseFee: 10n, priorityFee: 3n }, 1_000n)).toEqual({ gas: 1_300n, maxFeePerGas: 23n, maxPriorityFeePerGas: 3n });
  });

  it("prices the worst case as the gas limit times the maximum fee", () => {
    expect(worstCaseCostWei({ gas: 1_300n, maxFeePerGas: 23n, maxPriorityFeePerGas: 3n })).toBe(29_900n);
  });
});

describe("the fee quote", () => {
  it("takes the base fee of the latest block and the priority fee that the node suggests", async () => {
    const client = fakeClient();
    expect(await portOver(client).feeQuote()).toEqual({ baseFee: 100n, priorityFee: 7n });
    expect(client.getBlock).toHaveBeenCalledWith({ blockTag: "latest" });
  });

  it("uses the fixed priority fee and does not ask the node", async () => {
    const client = fakeClient();
    expect(await portOver(client, { priorityFeeWei: 0n }).feeQuote()).toEqual({ baseFee: 100n, priorityFee: 0n });
    expect(client.estimateMaxPriorityFeePerGas).not.toHaveBeenCalled();
  });

  it("raises a suggested tip below the chain's minimum to the minimum, so a validator includes the transaction", async () => {
    const client = fakeClient();
    expect(await portOver(client, { minimumPriorityFeeWei: 10_000_000n }).feeQuote()).toEqual({ baseFee: 100n, priorityFee: 10_000_000n });
  });

  it("raises a fixed tip below the minimum as well", async () => {
    expect(await portOver(fakeClient(), { priorityFeeWei: 1n, minimumPriorityFeeWei: 1_000_001n }).feeQuote()).toEqual({ baseFee: 100n, priorityFee: 1_000_001n });
  });

  it("keeps a tip at or above the minimum", async () => {
    expect(await portOver(fakeClient(), { minimumPriorityFeeWei: 7n }).feeQuote()).toEqual({ baseFee: 100n, priorityFee: 7n });
    expect(await portOver(fakeClient(), { priorityFeeWei: 2_000_000_000n, minimumPriorityFeeWei: 10_000_000n }).feeQuote()).toEqual({ baseFee: 100n, priorityFee: 2_000_000_000n });
  });

  it("sends the raised tip, with a maximum fee of twice the base fee plus the tip", async () => {
    const client = fakeClient();
    const port = portOver(client, { minimumPriorityFeeWei: 10_000_000n });
    const terms = sendTerms(await port.feeQuote(), 21_000n);
    expect(terms).toMatchObject({ maxFeePerGas: 200n + 10_000_000n, maxPriorityFeePerGas: 10_000_000n });
    await port.send({ to: TARGET, data: DATA, ...terms });
    const sent = parseTransaction((client.sendRawTransaction.mock.calls[0] as [{ serializedTransaction: Hex }])[0].serializedTransaction) as TransactionSerializableEIP1559;
    expect(sent.maxPriorityFeePerGas).toBe(10_000_000n);
    expect(sent.maxFeePerGas).toBe(10_000_200n);
  });

  it.each([null, undefined])("refuses a chain that reports a base fee of %s", async (baseFeePerGas) => {
    await expect(portOver(fakeClient({ baseFeePerGas })).feeQuote()).rejects.toThrow("the chain reports no base fee");
  });
});

describe("the port identity", () => {
  it("reports the chain and the address of the signer", () => {
    const port = portOver(fakeClient());
    expect(port.chainId).toBe(369);
    expect(port.account).toBe(ANVIL_ADDRESS);
  });
});

describe("simulate", () => {
  it("runs the call, then estimates the gas, with an explicit gas limit and no fee fields", async () => {
    const client = fakeClient();
    expect(await portOver(client).simulate({ to: TARGET, data: DATA })).toEqual({ ok: true, gas: 50_000n });
    const expected = { account: ANVIL_ADDRESS, to: TARGET, data: DATA, gas: SIMULATION_GAS_LIMIT };
    expect(client.call).toHaveBeenCalledWith(expected);
    expect(client.estimateGas).toHaveBeenCalledWith(expected);
  });

  it("never asks the node to check the balance against a fee cap (the PulseChain testnet approval that was refused with 1000 PLS)", async () => {
    // A node that refuses a request whose fee cap times its gas exceeds the balance, as the live node did.
    const balance = 1_000n * 10n ** 18n;
    const refuse = async (request?: unknown) => {
      const { gas, maxFeePerGas } = request as { gas?: bigint; maxFeePerGas?: bigint };
      if ((gas ?? 10n ** 12n) * (maxFeePerGas ?? 0n) > balance) throw new BaseError("The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.");
      return { data: "0x" as Hex };
    };
    const client = fakeClient({ call: refuse as never, estimateGas: (async (request?: unknown) => ((await refuse(request)), 56_139n)) as never });
    client.estimateMaxPriorityFeePerGas.mockResolvedValue(1_230_000_000n);
    client.getBlock.mockResolvedValue({ baseFeePerGas: 7n });
    expect(await portOver(client, { minimumPriorityFeeWei: 10_000_000n }).simulate({ to: TARGET, data: DATA })).toEqual({ ok: true, gas: 56_139n });
  });

  it("takes the gas limit of the request and reports it, with no fee, when the simulation fails", async () => {
    const client = fakeClient({ call: async () => Promise.reject(new BaseError("The execution reverted.")) });
    expect(await portOver(client).simulate({ to: TARGET, data: DATA, gas: 777n })).toEqual({ ok: false, reason: "The execution reverted.", used: { gas: 777n, maxFeePerGas: null } });
    expect(client.call).toHaveBeenCalledWith(expect.objectContaining({ gas: 777n }));
  });

  it("reports the short message and the selector of the revert data", async () => {
    const reverted = new BaseError("The execution reverted.", { cause: Object.assign(new Error("inner"), { data: "0x12345678abcdef" }) });
    const client = fakeClient({ call: async () => Promise.reject(reverted) });
    expect(await portOver(client).simulate({ to: TARGET, data: DATA })).toEqual({ ok: false, reason: "The execution reverted. (revert data 0x12345678)", used: SIMULATED });
    expect(client.estimateGas).not.toHaveBeenCalled();
  });

  it("reports the short message alone when the revert data is shorter than a selector", async () => {
    const reverted = new BaseError("The execution reverted.", { cause: Object.assign(new Error("inner"), { data: "0x12" }) });
    const client = fakeClient({ estimateGas: async () => Promise.reject(reverted) });
    expect(await portOver(client).simulate({ to: TARGET, data: DATA })).toEqual({ ok: false, reason: "The execution reverted.", used: SIMULATED });
  });

  it("reports the short message alone when the error carries no revert data", async () => {
    const client = fakeClient({ call: async () => Promise.reject(new BaseError("The request timed out.")) });
    expect(await portOver(client).simulate({ to: TARGET, data: DATA })).toEqual({ ok: false, reason: "The request timed out.", used: SIMULATED });
  });

  it("reports the message of a plain error", async () => {
    const client = fakeClient({ call: async () => Promise.reject(new Error("socket closed")) });
    expect(await portOver(client).simulate({ to: TARGET, data: DATA })).toEqual({ ok: false, reason: "socket closed", used: SIMULATED });
  });

  it("reports the short message of an object that is not an error", async () => {
    const client = fakeClient({ call: async () => Promise.reject({ shortMessage: "out of gas" }) });
    expect(await portOver(client).simulate({ to: TARGET, data: DATA })).toEqual({ ok: false, reason: "out of gas", used: SIMULATED });
  });

  it("reports the text of a value that is neither an error nor an object with a message", async () => {
    const client = fakeClient({ call: async () => Promise.reject("plain text") });
    expect(await portOver(client).simulate({ to: TARGET, data: DATA })).toEqual({ ok: false, reason: "plain text", used: SIMULATED });
    const second = fakeClient({ call: async () => Promise.reject({ shortMessage: 5 }) });
    expect(await portOver(second).simulate({ to: TARGET, data: DATA })).toEqual({ ok: false, reason: "[object Object]", used: SIMULATED });
  });
});

describe("call", () => {
  it("returns the data of the answer, from the signer, with the explicit simulation gas limit and no fee fields", async () => {
    const client = fakeClient();
    expect(await portOver(client).call({ to: TARGET, data: DATA })).toBe("0xabcd");
    expect(client.call).toHaveBeenCalledWith({ account: ANVIL_ADDRESS, to: TARGET, data: DATA, gas: SIMULATION_GAS_LIMIT });
    expect(client.getBlock).not.toHaveBeenCalled();
  });

  it("sets the gas limit of the request, so the call shows what a transaction of that limit does", async () => {
    const client = fakeClient();
    await portOver(client).call({ to: TARGET, data: DATA, gas: 99_000n });
    expect(client.call).toHaveBeenCalledWith({ account: ANVIL_ADDRESS, to: TARGET, data: DATA, gas: 99_000n });
  });

  it("reads an answer without data as empty data", async () => {
    expect(await portOver(fakeClient({ call: async () => ({}) })).call({ to: TARGET, data: DATA })).toBe("0x");
  });
});

describe("send", () => {
  const request = { to: TARGET, data: DATA, gas: 65_000n, maxFeePerGas: 220n, maxPriorityFeePerGas: 7n };

  it("signs the exact terms with the pending nonce, broadcasts the signed bytes and waits for the receipt", async () => {
    const client = fakeClient();
    const receipt = await portOver(client).send(request);
    expect(client.getTransactionCount).toHaveBeenCalledWith({ address: ANVIL_ADDRESS, blockTag: "pending" });
    const { serializedTransaction } = client.sendRawTransaction.mock.calls[0]![0];
    expect(parseTransaction(serializedTransaction)).toMatchObject({ type: "eip1559", chainId: 369, nonce: 42, to: TARGET.toLowerCase(), data: DATA, gas: 65_000n, maxFeePerGas: 220n, maxPriorityFeePerGas: 7n });
    expect(await recoverTransactionAddress({ serializedTransaction: serializedTransaction as `0x02${string}` })).toBe(ANVIL_ADDRESS);
    expect(client.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: word(0xaa), timeout: 12_345 });
    expect(receipt).toEqual({
      hash: word(0xaa),
      success: true,
      gasUsed: 31_000n,
      effectiveGasPrice: 107n,
      blockNumber: 9n,
      logs: [{ address: TARGET, topics: [word(1)], data: "0x01" }],
    });
  });

  it("reports a reverted receipt as a failure", async () => {
    expect((await portOver(fakeClient({ receiptStatus: "reverted" })).send(request)).success).toBe(false);
  });

  it("does not broadcast when the signer returns a signature for another transaction", async () => {
    const honest = signerFromPrivateKeyText(ANVIL_KEY);
    const tampering: Signer = {
      ...honest,
      signTransaction: (transaction: TransactionSerializableEIP1559) => honest.signTransaction({ ...transaction, value: 1n }),
    };
    const client = fakeClient();
    await expect(portOver(client, { signer: tampering }).send(request)).rejects.toMatchObject({ name: "SignatureMismatchError" });
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("does not broadcast when the signature belongs to another account", async () => {
    const other = signerFromPrivateKeyText("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const impostor: Signer = { ...other, address: ANVIL_ADDRESS };
    const client = fakeClient();
    await expect(portOver(client, { signer: impostor }).send(request)).rejects.toMatchObject({ name: "SignatureMismatchError" });
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("against a node that checks the sender and the balance like the live one", () => {
  const ASKER = ANVIL_ADDRESS.toLowerCase();
  // Gas that a node assumes when a request names none: geth with an unlimited gas cap uses half the largest 64 bit number.
  const NODE_DEFAULT_GAS = 2n ** 63n - 1n;
  const BASE_FEE = 10n ** 15n; // 1,000,000 gwei, as on PulseChain

  /** A JSON-RPC node over a viem client. It refuses a call without `from`, and one whose `from` cannot pay gas * fee. */
  function nodeWith(balances: Record<string, bigint>) {
    const requests: { method: string; params: Record<string, string | undefined> }[] = [];
    const client = createPublicClient({
      transport: custom({
        async request({ method, params }: { method: string; params?: unknown }) {
          const [call] = (params ?? []) as Record<string, string | undefined>[];
          requests.push({ method, params: { ...call, from: call?.from?.toLowerCase() } });
          if (method === "eth_chainId") return "0x3af";
          if (method === "eth_getBlockByNumber") return { number: "0x1", baseFeePerGas: `0x${BASE_FEE.toString(16)}`, transactions: [] };
          if (method === "eth_maxPriorityFeePerGas") return "0x3b9aca00";
          if (method !== "eth_call" && method !== "eth_estimateGas") throw new Error(`unexpected ${method}`);
          const from = call?.from?.toLowerCase();
          // The node checks the zero address (balance 0) when the request has no sender.
          const balance = balances[from ?? "0x0000000000000000000000000000000000000000"] ?? 0n;
          const gas = call?.gas === undefined ? NODE_DEFAULT_GAS : BigInt(call.gas);
          const fee = BigInt(call?.maxFeePerGas ?? call?.gasPrice ?? "0x0");
          if (from === undefined) throw new RpcRequestError({ body: {}, url: "node", error: { code: -32000, message: "insufficient funds for gas * price + value: address 0x0000000000000000000000000000000000000000 have 0 want 1" } });
          if (balance < gas * fee) throw new RpcRequestError({ body: {}, url: "node", error: { code: -32000, message: `insufficient funds for gas * price + value: address ${from} have ${balance} want ${gas * fee}` } });
          return method === "eth_call" ? "0x01" : "0xdac0";
        },
      }),
    });
    return { client, requests };
  }
  const port = (client: PublicClient) => createTransactionPort({ client, signer: signerFromPrivateKeyText(ANVIL_KEY), chainId: 943, receiptTimeoutMilliseconds: 1, priorityFeeWei: 1_230_000_000n });
  const RUNNER_BALANCE = 5_000_000n * 10n ** 18n;
  const TRAFFIC_BALANCE = 1_000n * 10n ** 18n;

  it("lets the runner wallet (5,000,000 coins) read: a call used to carry a fee cap and the node's own gas", async () => {
    const { client, requests } = nodeWith({ [ASKER]: RUNNER_BALANCE });
    expect(await port(client).call({ to: TARGET, data: DATA })).toBe("0x01");
    const sent = requests.filter((request) => request.method === "eth_call");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params).toMatchObject({ from: ASKER, gas: `0x${SIMULATION_GAS_LIMIT.toString(16)}` });
    expect(sent[0]!.params.maxFeePerGas).toBeUndefined();
    expect(sent[0]!.params.gasPrice).toBeUndefined();
  });

  it("lets the traffic wallet (1,000 coins) simulate, and names the signer in both the call and the estimate", async () => {
    const { client, requests } = nodeWith({ [ASKER]: TRAFFIC_BALANCE });
    expect(await port(client).simulate({ to: TARGET, data: DATA })).toEqual({ ok: true, gas: 0xdac0n });
    expect(requests.filter((request) => request.method === "eth_call" || request.method === "eth_estimateGas").map((request) => [request.method, request.params.from])).toEqual([
      ["eth_call", ASKER],
      ["eth_estimateGas", ASKER],
    ]);
  });

  it("the fake node does refuse what the old call sent (fee cap, no gas) and a request with no sender", async () => {
    const { client } = nodeWith({ [ASKER]: RUNNER_BALANCE });
    await expect(client.call({ account: ANVIL_ADDRESS, to: TARGET, data: DATA, maxFeePerGas: BASE_FEE + 1_230_000_000n, maxPriorityFeePerGas: 1_230_000_000n })).rejects.toThrow(/exceeds the balance|insufficient funds/);
    await expect(client.call({ to: TARGET, data: DATA, gas: 30_000_000n })).rejects.toThrow(/exceeds the balance|insufficient funds/);
  });

  it("asks no balance of the sender at all, since the request carries no fee", async () => {
    const { client } = nodeWith({});
    expect(await port(client).simulate({ to: TARGET, data: DATA })).toEqual({ ok: true, gas: 0xdac0n });
  });
});
