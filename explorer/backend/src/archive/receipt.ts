import { z } from "zod";

/** How long one call to the source chain's node may take, in milliseconds. */
export const RECEIPT_TIMEOUT_MILLISECONDS = 30_000;

const receiptSchema = z.object({ logs: z.array(z.object({ logIndex: z.string().regex(/^0x[0-9a-fA-F]+$/) })) }).nullable();
const answerSchema = z.object({ result: receiptSchema.optional(), error: z.unknown().optional() });

/**
 * The position of a log inside the receipt of its transaction. The chain indexer stores the index of a log inside its
 * block (the `logIndex` of a log object), and the `evidence` command of the prover counts inside the receipt, so the
 * two differ whenever an earlier transaction of the block, or an earlier log of the same transaction, comes first.
 *
 * @returns The position, or null when no log of the receipt has that block index.
 */
export function receiptPositionOf(logs: readonly { readonly logIndex: string }[], blockLogIndex: number): number | null {
  const position = logs.findIndex((log) => Number.parseInt(log.logIndex, 16) === blockLogIndex);
  return position < 0 ? null : position;
}

/** Turns the block index of a log into the index that `evidence --log-index` takes. */
export interface ReceiptIndexReader {
  /** @throws When the chain has no endpoint, the node fails or answers a wrong shape, or the receipt has no log with that block index. */
  receiptIndexOf(input: { readonly chainId: number; readonly transactionHash: string; readonly blockLogIndex: number }): Promise<number>;
}

/**
 * Builds the reader over the `eth_getTransactionReceipt` of the node of the source chain.
 *
 * @param input.rpcUrls The node addresses by chain id.
 * @param input.fetchFunction The fetch function. It is read at call time so a test can replace it.
 */
export function createReceiptIndexReader(input: { rpcUrls: Readonly<Record<string, string>>; fetchFunction: () => typeof fetch }): ReceiptIndexReader {
  return {
    async receiptIndexOf({ chainId, transactionHash, blockLogIndex }) {
      const url = input.rpcUrls[String(chainId)];
      if (url === undefined) throw new Error(`rpcUrls has no entry for chain ${chainId}`);
      const answer = await input.fetchFunction()(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [transactionHash] }),
        signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MILLISECONDS),
      });
      if (!answer.ok) throw new Error(`the node of chain ${chainId} answered ${answer.status} for a receipt`);
      const parsed = answerSchema.safeParse(await answer.json());
      if (!parsed.success || parsed.data.error !== undefined) throw new Error(`the node of chain ${chainId} sent a receipt answer that is an error or in an unknown shape`);
      const receipt = parsed.data.result;
      if (receipt === null || receipt === undefined) throw new Error(`the node of chain ${chainId} has no receipt for ${transactionHash}`);
      const position = receiptPositionOf(receipt.logs, blockLogIndex);
      if (position === null) throw new Error(`the receipt of ${transactionHash} has no log with block index ${blockLogIndex}`);
      return position;
    },
  };
}
