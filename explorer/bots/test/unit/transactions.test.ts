import { BaseError, parseTransaction, recoverTransactionAddress, type Hex, type PublicClient, type TransactionSerializableEIP1559 } from "viem";
import { describe, expect, it, vi } from "vitest";
import { signerFromPrivateKeyText } from "../../../terminal/src/signing/key-sources.ts";
import { createTransactionPort, GAS_BUFFER_PERCENT, sendTerms, worstCaseCostWei } from "../../src/chain/transactions.ts";
import type { Signer } from "../../src/signing/open-signer.ts";
import { address, word } from "../support/builders.ts";

// The first public development key of Anvil.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TARGET = address(0x55);
const DATA: Hex = "0xdeadbeef";

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

function portOver(client: ReturnType<typeof fakeClient>, extra: { priorityFeeWei?: bigint; signer?: Signer } = {}) {
  return createTransactionPort({
    client: client as unknown as PublicClient,
    signer: extra.signer ?? signerFromPrivateKeyText(ANVIL_KEY),
    chainId: 369,
    receiptTimeoutMilliseconds: 12_345,
    ...(extra.priorityFeeWei === undefined ? {} : { priorityFeeWei: extra.priorityFeeWei }),
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
  it("runs the call, then estimates the gas, both at the current fees", async () => {
    const client = fakeClient();
    expect(await portOver(client).simulate({ to: TARGET, data: DATA })).toEqual({ ok: true, gas: 50_000n });
    const expected = { account: ANVIL_ADDRESS, to: TARGET, data: DATA, maxFeePerGas: 107n, maxPriorityFeePerGas: 7n };
    expect(client.call).toHaveBeenCalledWith(expected);
    expect(client.estimateGas).toHaveBeenCalledWith(expected);
  });

  it("reports the short message and the selector of the revert data", async () => {
    const reverted = new BaseError("The execution reverted.", { cause: Object.assign(new Error("inner"), { data: "0x12345678abcdef" }) });
    const client = fakeClient({ call: async () => Promise.reject(reverted) });
    expect(await portOver(client).simulate({ to: TARGET, data: DATA })).toEqual({ ok: false, reason: "The execution reverted. (revert data 0x12345678)" });
    expect(client.estimateGas).not.toHaveBeenCalled();
  });

  it("reports the short message alone when the revert data is shorter than a selector", async () => {
    const reverted = new BaseError("The execution reverted.", { cause: Object.assign(new Error("inner"), { data: "0x12" }) });
    const client = fakeClient({ estimateGas: async () => Promise.reject(reverted) });
    expect(await portOver(client).simulate({ to: TARGET, data: DATA })).toEqual({ ok: false, reason: "The execution reverted." });
  });

  it("reports the short message alone when the error carries no revert data", async () => {
    const client = fakeClient({ call: async () => Promise.reject(new BaseError("The request timed out.")) });
    expect(await portOver(client).simulate({ to: TARGET, data: DATA })).toEqual({ ok: false, reason: "The request timed out." });
  });

  it("reports the message of a plain error", async () => {
    const client = fakeClient({ call: async () => Promise.reject(new Error("socket closed")) });
    expect(await portOver(client).simulate({ to: TARGET, data: DATA })).toEqual({ ok: false, reason: "socket closed" });
  });

  it("reports the short message of an object that is not an error", async () => {
    const client = fakeClient({ call: async () => Promise.reject({ shortMessage: "out of gas" }) });
    expect(await portOver(client).simulate({ to: TARGET, data: DATA })).toEqual({ ok: false, reason: "out of gas" });
  });

  it("reports the text of a value that is neither an error nor an object with a message", async () => {
    const client = fakeClient({ call: async () => Promise.reject("plain text") });
    expect(await portOver(client).simulate({ to: TARGET, data: DATA })).toEqual({ ok: false, reason: "plain text" });
    const second = fakeClient({ call: async () => Promise.reject({ shortMessage: 5 }) });
    expect(await portOver(second).simulate({ to: TARGET, data: DATA })).toEqual({ ok: false, reason: "[object Object]" });
  });
});

describe("call", () => {
  it("returns the data of the answer and sets no gas limit when the request has none", async () => {
    const client = fakeClient();
    expect(await portOver(client).call({ to: TARGET, data: DATA })).toBe("0xabcd");
    expect(client.call).toHaveBeenCalledWith({ account: ANVIL_ADDRESS, to: TARGET, data: DATA, maxFeePerGas: 107n, maxPriorityFeePerGas: 7n });
  });

  it("sets the gas limit of the request, so the call shows what a transaction of that limit does", async () => {
    const client = fakeClient();
    await portOver(client).call({ to: TARGET, data: DATA, gas: 99_000n });
    expect(client.call).toHaveBeenCalledWith({ account: ANVIL_ADDRESS, to: TARGET, data: DATA, gas: 99_000n, maxFeePerGas: 107n, maxPriorityFeePerGas: 7n });
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
