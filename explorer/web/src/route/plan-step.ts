/**
 * What "Post it from your wallet" does for each kind of step: read the finished proof (or, for a seal and a fork
 * observation, the offer that the Forks section uses), check that it still lands, and plan the transaction for the normal
 * review dialog. A step that someone else posted meanwhile is said so and stops.
 */
import type { Address, Hex } from "viem";
import { proofStartProblem, tryDecodeProofMessage, type RouteStep, type StepProof } from "@zk-bridge/shared";
import { planForkObservation, planGateSeal } from "@terminal/tx/gate-step";
import { planOpenDeposits, planRegistryUpdate } from "@terminal/tx/route-step";
import type { PairConfig } from "@terminal/model/types";
import type { ForkPort } from "../fork/fork-port";
import type { WebStep } from "../tx/bridge-steps";
import { chosenDeliverySteps, planDelivery, planProofUpdate } from "../views/proof-panel-model";
import type { StepBackend } from "./route-port";

/** What the post button does: the transactions to review, a reason it cannot go on, or the news that someone else posted. */
export type PostPlan =
  | { readonly kind: "ready"; readonly steps: readonly WebStep[] }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "posted-elsewhere"; readonly reason: string };

/** What planning reads. */
export type PostInput = {
  readonly step: RouteStep;
  readonly pair: PairConfig;
  readonly account: Address;
  readonly backend: StepBackend;
  readonly forks: ForkPort;
  /** The slot of the head that the light client on a chain stores now, read from the chain. */
  readonly readLightClientHead: (chainId: number) => Promise<bigint>;
};

const DISCLOSURE = { feesApplyTo: "this-transaction", deliveryCall: null, destinationNativeSymbol: null, destinationChainId: null, amountToken: null, delivery: null } as const;

const blocked = (reason: string): PostPlan => ({ kind: "blocked", reason });
const NO_PROOF = "The backend holds no finished proof for this step now. Make the proof again.";

/**
 * Plans the post of one step.
 *
 * @param input The step, the pair, the account and the reads.
 */
export const planStepPost = async (input: PostInput): Promise<PostPlan> => {
  const { step, pair } = input;
  const chain = pair.first.chainId === step.chainId ? pair.first : pair.second;
  const one = (plan: Parameters<typeof wrap>[0]): PostPlan => ({ kind: "ready", steps: [wrap(plan)] });
  try {
    if (step.kind === "seal") {
      const offer = await input.forks.sealOffer(step.chainId, input.account);
      return offer.kind === "ready" ? one(planGateSeal(chain, offer)) : blocked(offer.kind === "sealed" ? "The gate is sealed already." : `The seal call would not go through now: ${offer.reason}.`);
    }
    if (step.kind === "fork-observation") {
      const registry = chain.contracts.forkRegistry ?? step.target;
      if (registry === null) return blocked(`${chain.name} has no fork registry in this deployment.`);
      const offer = await input.forks.observeOffer(step.chainId, registry as Address, input.account);
      return offer.kind === "ready" ? one(planForkObservation(chain, offer)) : blocked(`The observation would not go through now: ${offer.reason}.`);
    }
    const proof = await input.backend.proof(step.kind, step.subject);
    // A proof of another kind than the step is never planned.
    if (proof === null || proof.kind !== step.kind) return blocked(NO_PROOF);
    if (proof.kind === "light-client-update") {
      const decoded = tryDecodeProofMessage(proof.payload as Hex);
      if (!decoded.ok) return blocked(`The proof could not be read: ${decoded.detail}.`);
      // The contract refuses an update that does not start at its current head, so the head is read again from the chain.
      const head = await input.readLightClientHead(step.chainId).catch(() => null);
      if (head === null) return blocked("The page could not read the head of the light client. Check the RPC setting for the chain in Connections.");
      const problem = proofStartProblem(decoded.message, head);
      if (problem !== null) return { kind: "posted-elsewhere", reason: problem };
      return { kind: "ready", steps: [planProofUpdate(decoded.message, pair)] };
    }
    if (proof.kind === "registry-light-client-update") return one(planRegistryUpdate(chain, proof));
    if (proof.kind === "open-deposits") return one(planOpenDeposits(chain, proof));
    // What is left is the evidence of a layout step or a delivery: the proof has the kind of the step.
    const evidenceProof = proof as Extract<StepProof, { readonly kind: "layout-rows" | "deliver" }>;
    const delivery = planDelivery({ kind: "found", text: JSON.stringify(evidenceProof.evidence) }, pair, { messageId: step.messageId ?? step.subject, sourceTransactionHash: null });
    if (delivery.kind === "unavailable") return blocked(delivery.reason);
    const rows = delivery.steps.filter((row) => (evidenceProof.kind === "layout-rows" ? row.role === "prerequisite" : row.role === "execute"));
    return rows.length === 0 ? blocked("The evidence holds no call for this step.") : { kind: "ready", steps: chosenDeliverySteps(rows, []) };
  } catch (error) {
    return blocked(`The transaction could not be planned: ${(error as Error).message}`);
  }
};

const wrap = (plan: WebStep["plan"]): WebStep => ({ plan, disclosure: DISCLOSURE });
