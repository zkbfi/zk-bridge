import { decodeFunctionData, type Hex } from "viem";
import { beaconLightClientAbi, decodeLightClientOutput, multicall3Abi, type Pair, type ProofDirection } from "@zk-bridge/shared";
import { lightClientRecord, type LightClientProofRecord } from "./records";

/**
 * Light client proofs from the transactions the indexer already sees. A runner posts `update(proof, publicValues)` to
 * the light client either directly or as one call of a Multicall3 batch (explorer/bots/src/runner/batch.ts). Either way
 * the proof is in the calldata of the transaction that emitted `HeadUpdated`, so the archive gets every posted proof
 * without asking anyone.
 */

/** One `update` call found in calldata. */
export type UpdateCall = { readonly proof: Hex; readonly publicValues: Hex };

const callDataOf = (value: unknown): Hex[] => {
  if (Array.isArray(value)) return value.flatMap(callDataOf);
  if (typeof value === "object" && value !== null && "callData" in value) return [(value as { callData: Hex }).callData];
  return [];
};

/** Every `update` call in a transaction input: the input itself, or the calls of a Multicall3 batch, at any depth. */
export function updateCallsIn(input: Hex): UpdateCall[] {
  try {
    const call = decodeFunctionData({ abi: beaconLightClientAbi, data: input });
    if (call.functionName === "update") {
      const [proof, publicValues] = call.args as readonly [Hex, Hex];
      return [{ proof, publicValues }];
    }
    return [];
  } catch {
    // Not a call of the light client.
  }
  try {
    const batch = decodeFunctionData({ abi: multicall3Abi, data: input });
    return callDataOf(batch.args).flatMap(updateCallsIn);
  } catch {
    return [];
  }
}

/** The direction whose proofs land on the light client of `chainId`: the other side is the source of the beacon chain. */
export function directionOfLightClientChain(pair: Pair, chainId: number): ProofDirection {
  return chainId === pair.sides[1].chainId ? "first-to-second" : "second-to-first";
}

/** What the handler of `HeadUpdated` knows. */
export interface HeadUpdatedTransaction {
  readonly chainId: number;
  readonly input: Hex;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  /** The slot and header root of the event: they pick the `update` call that stored this head. */
  readonly slot: bigint;
  readonly headerRoot: Hex;
}

/**
 * The record of the proof that stored the head of a `HeadUpdated` event, or null when its transaction holds no
 * matching `update` call (such as a call through a contract that the indexer cannot decode).
 */
export function recordOfHeadUpdate(pair: Pair, transaction: HeadUpdatedTransaction): LightClientProofRecord | null {
  for (const call of updateCallsIn(transaction.input)) {
    let output;
    try {
      output = decodeLightClientOutput(call.publicValues);
    } catch {
      continue;
    }
    if (output.newHeadSlot !== transaction.slot || output.newHeaderRoot.toLowerCase() !== transaction.headerRoot.toLowerCase()) continue;
    return lightClientRecord({
      pair: pair.name,
      direction: directionOfLightClientChain(pair, transaction.chainId),
      proof: call.proof,
      publicValues: call.publicValues,
      source: "calldata",
      extras: { postedChainId: transaction.chainId, postedTransactionHash: transaction.transactionHash.toLowerCase(), postedBlockNumber: transaction.blockNumber.toString() },
    });
  }
  return null;
}
