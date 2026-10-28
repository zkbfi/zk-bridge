/**
 * Delivery of messages: the evidence of the prover, the layout rows that it needs, and the call that executes the
 * message, through the router, through the bridge, or inside a Multicall3 batch.
 */
import type { Address, Hex } from "viem";
import { multicall3Abi, encodeAggregate3, decodeAggregate3, type BatchedCall, type BatchedCallResult } from "@zk-bridge/shared";
import { accountOf, chainOf, otherSide, routeFrom, sendFrom, type Context, type Role, type Sent, type Side } from "./context.ts";
import { record } from "./results.ts";
import { evidence as buildEvidence, type Evidence } from "./prover.ts";
import { postUpdate } from "./stages/updates.ts";

/** A message that the run sent and will deliver. */
export interface MessageRecord {
  readonly name: string;
  readonly from: Side;
  readonly transactionHash: Hex;
  readonly logIndex: number;
  readonly messageId: Hex;
}

/** The way a message is executed on the destination chain. */
export type DeliveryPath = "router" | "bridge";

/**
 * Asks the prover for the evidence of a message, and posts a light client update while the stored head does not cover it
 * yet. Prerequisite calls (layout rows) are sent, and the evidence is read again until none is left.
 *
 * @param context The run.
 * @param message The message.
 * @param stage The name for the records.
 * @returns The evidence with an empty list of prerequisites.
 */
export const readyEvidence = async (context: Context, message: MessageRecord, stage: string): Promise<Evidence> => {
  const route = routeFrom(message.from);
  const destination = chainOf(context, otherSide(message.from));
  const sentPrerequisites = new Set<Hex>();
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    let result: Evidence;
    try {
      result = await buildEvidence(context, { route, transactionHash: message.transactionHash, logIndex: message.logIndex });
    } catch (error) {
      const reason = (error as Error).message;
      console.log(`${message.name}: evidence attempt ${attempt}: ${reason.slice(0, 260)}`);
      await postUpdate(context, message.from, stage);
      await new Promise((done) => setTimeout(done, 8_000));
      continue;
    }
    if (result.prerequisites.length === 0) return result;
    // The calls for one function are alternatives. Send the first one that was not sent yet, then read the evidence again.
    const next = result.prerequisites.find((call) => !sentPrerequisites.has(call.data));
    if (next === undefined) throw new Error(`${message.name}: every prerequisite was sent and the bridge still lacks a row`);
    sentPrerequisites.add(next.data);
    try {
      const sent = await sendFrom(destination, "poster", { to: next.to, data: next.data, gas: 6_000_000n }, `${next.function} for ${message.name}`);
      console.log(`${message.name}: ${next.function} used ${sent.gasUsed} gas (${next.reason.slice(0, 90)})`);
      record(context, { stage, name: `layout-row-${next.function}`, ok: true, data: { message: message.name, gasUsed: sent.gasUsed.toString() } });
    } catch (error) {
      console.log(`${message.name}: ${next.function} not accepted: ${(error as Error).message.slice(0, 160)}`);
    }
  }
  throw new Error(`no usable evidence for ${message.name}`);
};

/** The gas of one layout row that the run added, for the report. */
export interface DeliverySent {
  readonly sent: Sent;
  readonly evidence: Evidence;
  readonly to: Address;
}

/**
 * Executes a message on the destination chain through the router or through the bridge.
 *
 * @param context The run.
 * @param message The message.
 * @param input The path, the account that pays, and the prepared evidence.
 */
export const execute = async (context: Context, message: MessageRecord, input: { readonly path: DeliveryPath; readonly role: Role; readonly evidence: Evidence }): Promise<DeliverySent> => {
  const destination = chainOf(context, otherSide(message.from));
  const to = input.path === "router" ? destination.deployment.delivery_router : destination.deployment.bridge;
  // The router and the bridge take the same call: executeMessage(MessageProof). Only the target differs.
  const sent = await sendFrom(destination, input.role, { to, data: input.evidence.execute.data }, `${input.path} executeMessage ${message.name}`);
  return { sent, evidence: input.evidence, to };
};

/**
 * Sends one Multicall3 `aggregate3` transaction. Every call allows failure.
 *
 * @param context The run.
 * @param side The chain of the batch.
 * @param role The account that sends it.
 * @param calls The calls, in order.
 * @returns The transaction and the result of each call, read from a simulation at the parent block.
 */
export const sendBatch = async (context: Context, side: Side, role: Role, calls: readonly BatchedCall[]): Promise<{ readonly sent: Sent; readonly results: readonly BatchedCallResult[] }> => {
  const chain = chainOf(context, side);
  const data = encodeAggregate3(calls);
  const sent = await sendFrom(chain, role, { to: context.run.multicall3, data, gas: 8_000_000n }, "aggregate3");
  // The receipt keeps no return data, so the results come from a call at the parent block, with the same state.
  const simulated = await chain.publicClient.call({ to: context.run.multicall3, data, blockNumber: sent.receipt.blockNumber - 1n, account: accountOf(role) });
  const results = simulated.data === undefined ? [] : decodeAggregate3(simulated.data);
  return { sent, results };
};

/** The ABI of Multicall3, for the callers that encode a single call. */
export { multicall3Abi };
