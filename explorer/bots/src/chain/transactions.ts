import { BaseError, type Address, type Hex, type PublicClient, type TransactionSerializableEIP1559 } from "viem";
import { assertSignedTransactionMatches, type Signer } from "../signing/open-signer.ts";

/** A call to a contract. The account is the signer of the port. */
export interface CallRequest {
  readonly to: Address;
  readonly data: Hex;
}

/** The result of a simulation: the gas of the call, or the reason it reverts. */
export type Simulation = { readonly ok: true; readonly gas: bigint } | { readonly ok: false; readonly reason: string };

/** The fees of the next block. */
export interface FeeQuote {
  readonly baseFee: bigint;
  readonly priorityFee: bigint;
}

/** A log of a receipt. */
export interface ReceiptLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

/** What a mined transaction left behind. */
export interface ReceiptSummary {
  readonly hash: Hex;
  readonly success: boolean;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly blockNumber: bigint;
  readonly logs: readonly ReceiptLog[];
}

/**
 * Everything a bot does on the destination chain. The real one sits on a viem client and a signer. Tests pass a fake,
 * so the decisions of a bot run without a chain.
 */
export interface TransactionPort {
  readonly chainId: number;
  /** The account that signs and pays. */
  readonly account: Address;
  /** Runs `eth_call`, then `eth_estimateGas`. A revert gives `ok: false` with the reason. */
  simulate(request: CallRequest): Promise<Simulation>;
  /** A read-only call. @throws when the call reverts. */
  call(request: CallRequest): Promise<Hex>;
  feeQuote(): Promise<FeeQuote>;
  /** Signs, sends and waits for the receipt. */
  send(request: CallRequest & { readonly gas: bigint }): Promise<ReceiptSummary>;
}

/** The share of gas added to an estimate when a transaction is sent: 30 percent. The bridge forwards an exact gas limit, and a short estimate would revert. */
export const GAS_BUFFER_PERCENT = 30n;

/** Input of {@link createTransactionPort}. */
export interface TransactionPortInput {
  readonly client: PublicClient;
  readonly signer: Signer;
  readonly chainId: number;
  /** A fixed priority fee in wei. Default: what the node suggests. */
  readonly priorityFeeWei?: bigint;
  readonly receiptTimeoutMilliseconds: number;
}

/** The reason of a failed call: the short message of the client, and the four byte selector of the revert data when there is one. */
function reasonOf(error: unknown): string {
  const message = typeof error === "object" && error !== null && "shortMessage" in error && typeof error.shortMessage === "string" ? error.shortMessage : error instanceof Error ? error.message : String(error);
  const raw = error instanceof BaseError ? error.walk((candidate) => typeof (candidate as { data?: unknown }).data === "string") : null;
  const data = (raw as { data?: string } | null)?.data;
  return data === undefined || data.length < 10 ? message : `${message} (revert data ${data.slice(0, 10)})`;
}

/** Builds the port over a viem client. */
export function createTransactionPort(input: TransactionPortInput): TransactionPort {
  const { client, signer } = input;

  async function feeQuote(): Promise<FeeQuote> {
    const block = await client.getBlock({ blockTag: "latest" });
    if (block.baseFeePerGas === null || block.baseFeePerGas === undefined) throw new Error("the chain reports no base fee");
    const priorityFee = input.priorityFeeWei ?? (await client.estimateMaxPriorityFeePerGas());
    return { baseFee: block.baseFeePerGas, priorityFee };
  }

  return {
    chainId: input.chainId,
    account: signer.address,
    feeQuote,
    async simulate(request) {
      const quote = await feeQuote();
      const gasPrice = { maxFeePerGas: quote.baseFee + quote.priorityFee, maxPriorityFeePerGas: quote.priorityFee };
      try {
        await client.call({ account: signer.address, to: request.to, data: request.data, ...gasPrice });
        const gas = await client.estimateGas({ account: signer.address, to: request.to, data: request.data, ...gasPrice });
        return { ok: true, gas };
      } catch (error) {
        return { ok: false, reason: reasonOf(error) };
      }
    },
    async call(request) {
      const quote = await feeQuote();
      const result = await client.call({
        account: signer.address,
        to: request.to,
        data: request.data,
        maxFeePerGas: quote.baseFee + quote.priorityFee,
        maxPriorityFeePerGas: quote.priorityFee,
      });
      return result.data ?? "0x";
    },
    async send(request) {
      const quote = await feeQuote();
      const nonce = await client.getTransactionCount({ address: signer.address, blockTag: "pending" });
      const unsigned: TransactionSerializableEIP1559 = {
        type: "eip1559",
        chainId: input.chainId,
        nonce,
        to: request.to,
        value: 0n,
        data: request.data,
        gas: request.gas + (request.gas * GAS_BUFFER_PERCENT) / 100n,
        maxFeePerGas: quote.baseFee * 2n + quote.priorityFee,
        maxPriorityFeePerGas: quote.priorityFee,
      };
      const signed = await signer.signTransaction(unsigned);
      await assertSignedTransactionMatches({ signed, unsigned, expectedSigner: signer.address });
      const hash = await client.sendRawTransaction({ serializedTransaction: signed });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: input.receiptTimeoutMilliseconds });
      return {
        hash,
        success: receipt.status === "success",
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        blockNumber: receipt.blockNumber,
        logs: receipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data })),
      };
    },
  };
}
