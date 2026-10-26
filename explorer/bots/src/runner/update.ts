import { encodeFunctionData, type Address } from "viem";
import { beaconLightClientAbi, type ProofMessage } from "@zk-bridge/shared";
import { sendTerms, type TransactionPort } from "../chain/transactions.ts";

/** The result of an attempt to post `update`. */
export type UpdateOutcome =
  | { readonly posted: true; readonly transactionHash: `0x${string}`; readonly gasUsed: bigint; readonly effectiveGasPrice: bigint }
  | { readonly posted: false; readonly reason: "simulation-reverted" | "transaction-reverted"; readonly detail: string };

/**
 * Posts `update(proof, publicValues)` to the destination light client. The runner simulates first and sends only when
 * the simulation passes. A revert usually means that someone else posted a proof first, so it is no error.
 */
export async function postUpdate(input: {
  readonly chain: TransactionPort;
  readonly lightClient: Address;
  readonly message: ProofMessage;
}): Promise<UpdateOutcome> {
  const data = encodeFunctionData({
    abi: beaconLightClientAbi,
    functionName: "update",
    args: [input.message.proof, input.message.publicValues],
  });
  const request = { to: input.lightClient, data };
  const simulation = await input.chain.simulate(request);
  if (!simulation.ok) return { posted: false, reason: "simulation-reverted", detail: simulation.reason };
  const receipt = await input.chain.send({ ...request, ...sendTerms(await input.chain.feeQuote(), simulation.gas) });
  if (!receipt.success) return { posted: false, reason: "transaction-reverted", detail: receipt.hash };
  return { posted: true, transactionHash: receipt.hash, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice };
}
