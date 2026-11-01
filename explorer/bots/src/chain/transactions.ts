import { BaseError, type Address, type Hex, type PublicClient, type TransactionSerializableEIP1559 } from "viem";
import { assertSignedTransactionMatches, type Signer } from "../signing/open-signer.ts";

/** A call to a contract. The account is the signer of the port. */
export interface CallRequest {
  readonly to: Address;
  readonly data: Hex;
  /**
   * The gas limit of a read-only {@link TransactionPort.call}. Without it the node picks its own, usually the block limit.
   * A call that must show what a transaction with a given limit does (a batch skips items that lack gas) sets it.
   */
  readonly gas?: bigint;
}

/**
 * The gas limit of a simulation unless the request names one. A node that is not told a limit picks its own (the block
 * limit, or an RPC cap that some chains set very high), and a node that checks the balance against `gas * fee` then
 * refuses the simulation of a wallet that is well funded.
 */
export const SIMULATION_GAS_LIMIT = 30_000_000n;

/** What a simulation asked the node for: the gas limit, and the fee cap (null: none, so the node checks no balance). */
export interface SimulationTerms {
  readonly gas: bigint;
  readonly maxFeePerGas: bigint | null;
}

/** The result of a simulation: the gas of the call, or the reason it reverts and the terms the request carried. */
export type Simulation = { readonly ok: true; readonly gas: bigint } | { readonly ok: false; readonly reason: string; readonly used?: SimulationTerms };

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
  /**
   * Signs, sends and waits for the receipt. The port sends exactly the gas limit and the fees of the request, so the
   * caller can price the worst case of the transaction before it leaves. Build the request with {@link sendTerms}.
   * @throws when the transaction may have been broadcast and no receipt arrived.
   */
  send(request: SendRequest): Promise<ReceiptSummary>;
}

/** The share of gas added to an estimate when a transaction is sent: 30 percent. The bridge forwards an exact gas limit, and a short estimate would revert. */
export const GAS_BUFFER_PERCENT = 30n;

/** The gas limit and the fee limits of one transaction. The most it can cost is `gas * maxFeePerGas`. */
export interface SendTerms {
  /** The gas limit of the transaction, with the buffer. */
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

/** A call with the terms it is sent under. */
export type SendRequest = CallRequest & SendTerms;

/**
 * The terms that a send uses for a simulated gas amount: the gas plus the buffer, a maximum fee of twice the base fee
 * plus the priority fee, and the priority fee. One function makes the terms, so an estimate, a reservation and the
 * transaction all use the same price.
 */
export function sendTerms(quote: FeeQuote, simulatedGas: bigint): SendTerms {
  return {
    gas: simulatedGas + (simulatedGas * GAS_BUFFER_PERCENT) / 100n,
    maxFeePerGas: quote.baseFee * 2n + quote.priorityFee,
    maxPriorityFeePerGas: quote.priorityFee,
  };
}

/** The most wei that a transaction can cost under its terms. */
export function worstCaseCostWei(terms: SendTerms): bigint {
  return terms.gas * terms.maxFeePerGas;
}

/** Input of {@link createTransactionPort}. */
export interface TransactionPortInput {
  readonly client: PublicClient;
  readonly signer: Signer;
  readonly chainId: number;
  /** A fixed priority fee in wei. Default: what the node suggests. */
  readonly priorityFeeWei?: bigint;
  /**
   * The smallest priority fee the chain's validators include, in wei. A smaller fixed or suggested fee is raised to it.
   * A transaction with a tip below it waits in the pool for good and holds back every later nonce. Default: 0.
   */
  readonly minimumPriorityFeeWei?: bigint;
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
    const chosen = input.priorityFeeWei ?? (await client.estimateMaxPriorityFeePerGas());
    const minimum = input.minimumPriorityFeeWei ?? 0n;
    return { baseFee: block.baseFeePerGas, priorityFee: chosen < minimum ? minimum : chosen };
  }

  return {
    chainId: input.chainId,
    account: signer.address,
    feeQuote,
    async simulate(request) {
      // A simulation shows what the call does, not what the wallet can pay: the bot prices the real send afterwards and
      // checks the balance against its worst case. So the request carries an explicit gas limit and no fee fields; a node
      // then checks no balance (a fee cap times the node's own default gas can exceed a funded wallet).
      const gas = request.gas ?? SIMULATION_GAS_LIMIT;
      const used: SimulationTerms = { gas, maxFeePerGas: null };
      try {
        await client.call({ account: signer.address, to: request.to, data: request.data, gas });
        const estimated = await client.estimateGas({ account: signer.address, to: request.to, data: request.data, gas });
        return { ok: true, gas: estimated };
      } catch (error) {
        return { ok: false, reason: reasonOf(error), used };
      }
    },
    async call(request) {
      const quote = await feeQuote();
      const result = await client.call({
        account: signer.address,
        to: request.to,
        data: request.data,
        ...(request.gas === undefined ? {} : { gas: request.gas }),
        maxFeePerGas: quote.baseFee + quote.priorityFee,
        maxPriorityFeePerGas: quote.priorityFee,
      });
      return result.data ?? "0x";
    },
    async send(request) {
      const nonce = await client.getTransactionCount({ address: signer.address, blockTag: "pending" });
      const unsigned: TransactionSerializableEIP1559 = {
        type: "eip1559",
        chainId: input.chainId,
        nonce,
        to: request.to,
        value: 0n,
        data: request.data,
        gas: request.gas,
        maxFeePerGas: request.maxFeePerGas,
        maxPriorityFeePerGas: request.maxPriorityFeePerGas,
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
