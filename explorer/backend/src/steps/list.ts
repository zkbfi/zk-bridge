/**
 * `GET /route/steps`: every pending step of the route, both directions, with its situation and constraints in numbers.
 *
 * - **Light client update**, per direction: pending while transfers wait for it, a proof waits to land, the bridge on the
 *   destination waits for it to open, a job runs, or the head is {@link LIGHT_CLIENT_STEP_AGE_SECONDS} old. The backend's
 *   keep-alive proves it at `limits.keepAliveSeconds` after the head's last update (the runner posts it).
 * - **Open deposits**, per direction: pending while the bridge on the destination takes no deposits. The runner opens it
 *   as soon as it can.
 * - **Layout rows / delivery**, per message the light client covers and nobody delivered (the newest
 *   {@link COVERED_LIMIT} of each direction): layout rows while the evidence lists some. The runner delivers a paying one.
 * - **Fork registry light client update**, per chain with a registry: pending from half a sync committee period of age;
 *   the backend posts it after one period (`seal/registry-watch.ts`); its fold stops at 64 periods.
 * - **Fork observation**, per chain with a registry: pending while the chain runs a fork version the registry does not
 *   hold. The backend proves and posts it at once (seal module).
 *
 * A read that fails leaves its steps out and is named in `unread`.
 */
import { encodeFunctionData, type Address, type Hex } from "viem";
import {
  DEFAULT_DELIVERY_GAS,
  PROOF_DIRECTIONS,
  SLOTS_PER_EPOCH,
  beaconLightClientAbi,
  observationNeed,
  observeCalldata,
  stepIdOf,
  tryDecodeProofMessage,
  type Pair,
  type PairSide,
  type ProofDirection,
  type RouteStep,
  type RouteSteps,
  type StepProof,
} from "@zk-bridge/shared";
import { UPDATE_GAS_FALLBACK } from "../../../bots/src/runner/batch.ts";
import type { Pipeline } from "../progress/pipeline.ts";
import type { IndexedMessage } from "../progress/indexer.ts";
import { periodMillisecondsOf, slotTimeOf, type StepChainReads } from "./chain.ts";
import { directionFrom, opposite, sidesOf, type StepService } from "./service.ts";
import { latestStepJob } from "./store.ts";
import type { Storage } from "../storage.ts";
import { provingObservation } from "../seal/observations.ts";

/** A light client this old is a pending step even when nothing waits for it, in seconds. */
export const LIGHT_CLIENT_STEP_AGE_SECONDS = 3_600;

/** The covered messages of a direction that the list reads. */
export const COVERED_LIMIT = 20;

/** The most sync committee periods one fold of the fork observation program spans. */
export const FOLD_PERIODS = 64;

/** The GPU of a direction now. */
export type GpuView = NonNullable<RouteStep["constraints"]["gpu"]>;

/** What the list reads. A read that throws leaves its steps out. */
export type RouteStepInput = {
  readonly now: number;
  readonly pair: Pair;
  readonly storage: Storage;
  readonly keepAliveSeconds: number;
  readonly proverTimeoutMilliseconds: number;
  readonly service: StepService;
  readonly chain: StepChainReads;
  readonly pipelineOf: (direction: ProofDirection) => Promise<Pipeline>;
  /** The messages a light client covers and nobody delivered, newest first. */
  readonly coveredOf: (direction: ProofDirection) => Promise<readonly IndexedMessage[]>;
  readonly gpuOf: (direction: ProofDirection) => Promise<GpuView>;
};

type Posting = RouteStep["constraints"]["posting"];

const situation = (fields: Partial<RouteStep["situation"]>): RouteStep["situation"] => ({
  since: null,
  behindSeconds: null,
  waitingTransfers: 0,
  blocks: [],
  strandsAt: null,
  layoutRows: null,
  activeVersion: null,
  recordedVersion: null,
  ...fields,
});

/** Builds the list. */
export async function buildRouteSteps(input: RouteStepInput): Promise<RouteSteps> {
  const { now, pair, chain, service } = input;
  const unread: string[] = [];
  const gasPrices = new Map<number, Promise<bigint | null>>();
  const gasPriceOf = (side: PairSide): Promise<bigint | null> => {
    if (!gasPrices.has(side.chainId)) gasPrices.set(side.chainId, chain.gasPrice(side).catch(() => null));
    return gasPrices.get(side.chainId) as Promise<bigint | null>;
  };

  /** The gas of the posting: simulated with the proof when there is one, else the fallback; and its cost now. */
  const posting = async (side: PairSide, call: { to: Address; data: Hex } | null, fallback: bigint | null): Promise<Posting> => {
    const simulated = call === null ? null : await chain.simulate(side, call);
    const gas = simulated ?? fallback;
    const price = await gasPriceOf(side);
    return {
      gas: gas === null ? null : gas.toString(),
      gasSource: simulated !== null ? "simulated" : fallback === null ? null : "fallback",
      gasPriceWei: price === null ? null : price.toString(),
      costWei: gas === null || price === null ? null : (gas * price).toString(),
    };
  };

  const jobOf = (kind: "registry-light-client-update" | "open-deposits" | "layout-rows" | "deliver", subject: string): RouteStep["constraints"]["job"] => {
    const latest = latestStepJob(input.storage, kind, subject);
    return latest?.status === "running" ? { jobId: latest.id, status: "running", startedAt: latest.startedAt } : null;
  };

  const steps: RouteStep[] = [];
  const pipelines = new Map<ProofDirection, Pipeline>();

  for (const direction of PROOF_DIRECTIONS) {
    const { destination } = sidesOf(pair, direction);
    let pipeline: Pipeline | null = null;
    try {
      pipeline = await input.pipelineOf(direction);
      pipelines.set(direction, pipeline);
    } catch {
      unread.push(`pipeline ${direction}`);
    }
    const gpu = await input.gpuOf(direction);
    if (pipeline !== null) {
      const step = await lightClientStep({ direction, pipeline, gpu, destination, keepAliveSeconds: input.keepAliveSeconds, now, service, posting });
      if (step !== null) steps.push(step);
    }

    let open: boolean | null = null;
    try {
      open = await chain.depositsOpen(destination);
    } catch {
      unread.push(`deposits on chain ${destination.chainId}`);
    }
    if (open === false) {
      const proof = service.proof("open-deposits", direction);
      const ready = proof !== null && proof.kind === "open-deposits" && now - proof.provedAt < 600_000;
      steps.push({
        id: stepIdOf("open-deposits", direction),
        kind: "open-deposits",
        subject: direction,
        direction,
        chainId: destination.chainId,
        target: destination.contracts.bridge,
        messageId: null,
        situation: situation({ blocks: ["sends"] }),
        constraints: {
          finality: null,
          gpu: null,
          job: jobOf("open-deposits", direction),
          proofReady: ready,
          posting: await posting(destination, ready ? { to: proof.bridge as Address, data: proof.calldata as Hex } : null, null),
          after: pipeline?.deposits?.remoteHasHead === false ? stepIdOf("light-client-update", opposite(direction)) : null,
        },
        fallback: { by: "runner", at: null },
      });
    }

    let covered: readonly IndexedMessage[] = [];
    try {
      covered = await input.coveredOf(direction);
    } catch {
      unread.push(`covered messages ${direction}`);
    }
    for (const message of covered.slice(0, COVERED_LIMIT)) {
      const messageId = message.messageId.toLowerCase();
      const proof = service.proof("deliver", messageId);
      const rows = proof !== null && proof.kind === "deliver" ? proof.evidence.prerequisites.length : null;
      const kind = rows !== null && rows > 0 ? "layout-rows" : "deliver";
      steps.push({
        id: stepIdOf(kind, messageId),
        kind,
        subject: messageId,
        direction,
        chainId: destination.chainId,
        target: destination.contracts.deliveryRouter ?? destination.contracts.bridge,
        messageId,
        situation: situation({ since: message.covered?.timestamp == null ? null : message.covered.timestamp * 1000, waitingTransfers: 1, layoutRows: rows }),
        constraints: {
          finality: null,
          gpu: null,
          job: jobOf("layout-rows", messageId) ?? jobOf("deliver", messageId),
          proofReady: proof !== null,
          posting: await posting(destination, null, kind === "deliver" ? DEFAULT_DELIVERY_GAS : null),
          after: null,
        },
        fallback: { by: "runner", at: null },
      });
    }
  }

  for (const side of pair.sides) {
    const registry = side.contracts.forkRegistry;
    if (registry === null) continue;
    const subject = String(side.chainId);
    const direction = directionFrom(pair, side);
    const gpu = await input.gpuOf(direction);
    try {
      const state = await chain.registryLightClient(side, registry);
      const headAt = slotTimeOf(state, state.head.slot);
      const period = periodMillisecondsOf(state);
      if (now - headAt >= period / 2) {
        const proof = service.proof("registry-light-client-update", subject);
        const ready = proof !== null && proof.kind === "registry-light-client-update" && proof.startSlot === state.head.slot ? proof : null;
        const call = ready === null ? null : { to: ready.lightClient as Address, data: encodeFunctionData({ abi: beaconLightClientAbi, functionName: "update", args: [ready.proof as Hex, ready.publicValues as Hex] }) };
        const decision = pipelines.get(direction)?.decision ?? null;
        steps.push({
          id: stepIdOf("registry-light-client-update", subject),
          kind: "registry-light-client-update",
          subject,
          direction: null,
          chainId: side.chainId,
          target: state.lightClient,
          messageId: null,
          situation: situation({ since: headAt, behindSeconds: Math.round((now - headAt) / 1000), strandsAt: headAt + FOLD_PERIODS * period }),
          constraints: {
            finality: finalityOf(decision),
            gpu,
            job: jobOf("registry-light-client-update", subject),
            proofReady: ready !== null,
            posting: await posting(side, call, UPDATE_GAS_FALLBACK),
            after: null,
          },
          fallback: { by: "backend", at: headAt + period },
        });
      }
    } catch {
      unread.push(`fork registry light client on chain ${side.chainId}`);
    }
    if (side.beaconUrl === null) continue;
    try {
      const facts = await chain.forkFacts(side, registry, now);
      const need = observationNeed(facts);
      if (need.needed) {
        const proof = service.proof("fork-observation", subject);
        const held = proof !== null && proof.kind === "fork-observation" && proof.observation.observedVersion === need.version && BigInt(proof.observation.observedAttestedSlot) > facts.registry.slot ? proof.observation : null;
        const proving = provingObservation(input.storage, side.chainId, now - input.proverTimeoutMilliseconds);
        steps.push({
          id: stepIdOf("fork-observation", subject),
          kind: "fork-observation",
          subject,
          direction: null,
          chainId: side.chainId,
          target: registry,
          messageId: null,
          situation: situation({ activeVersion: need.version, recordedVersion: facts.registry.observed ? facts.registry.version.toLowerCase() : null }),
          constraints: {
            finality: null,
            gpu,
            job: proving === null ? null : { jobId: `observation:${proving.id}`, status: "running", startedAt: proving.startedAt },
            proofReady: held !== null,
            posting: await posting(side, held === null ? null : { to: registry, data: observeCalldata(held) }, null),
            after: null,
          },
          fallback: { by: "backend", at: null },
        });
      }
    } catch {
      unread.push(`fork facts of chain ${side.chainId}`);
    }
  }

  return { now, steps, unread };
}

/** The newest finality the watcher handled for the source chain, and when the next one is expected. */
const finalityOf = (decision: Pipeline["decision"]): RouteStep["constraints"]["finality"] =>
  decision === null ? null : { finalizedSlot: decision.finalizedSlot, nextAt: decision.at + SLOTS_PER_EPOCH * decision.secondsPerSlot * 1000 };

/** The light client update of a direction, or null when it is not pending. */
async function lightClientStep(input: {
  readonly direction: ProofDirection;
  readonly pipeline: Pipeline;
  readonly gpu: GpuView;
  readonly destination: PairSide;
  readonly keepAliveSeconds: number;
  readonly now: number;
  readonly service: StepService;
  readonly posting: (side: PairSide, call: { to: Address; data: Hex } | null, fallback: bigint | null) => Promise<Posting>;
}): Promise<RouteStep | null> {
  const { direction, pipeline, now, destination } = input;
  const lastUpdateAt = pipeline.head?.lastUpdateAt ?? null;
  const behindSeconds = lastUpdateAt === null ? null : Math.round((now - lastUpdateAt) / 1000);
  const waitingTransfers = pipeline.batch?.count ?? 0;
  const proofWaits = pipeline.latestProof !== null && pipeline.latestProof.where !== "applied";
  const depositsWait = pipeline.deposits?.waiting === true;
  const old = behindSeconds !== null && behindSeconds >= LIGHT_CLIENT_STEP_AGE_SECONDS;
  if (waitingTransfers === 0 && !proofWaits && !depositsWait && pipeline.job === null && !old) return null;
  const proof: StepProof | null = proofWaits ? input.service.proof("light-client-update", direction) : null;
  const decoded = proof !== null && proof.kind === "light-client-update" ? tryDecodeProofMessage(proof.payload as Hex) : null;
  const call = decoded !== null && decoded.ok ? { to: destination.contracts.lightClient, data: encodeFunctionData({ abi: beaconLightClientAbi, functionName: "update", args: [decoded.message.proof, decoded.message.publicValues] }) } : null;
  const decision = pipeline.decision;
  return {
    id: stepIdOf("light-client-update", direction),
    kind: "light-client-update",
    subject: direction,
    direction,
    chainId: destination.chainId,
    target: destination.contracts.lightClient,
    messageId: null,
    situation: situation({
      since: lastUpdateAt,
      behindSeconds,
      waitingTransfers,
      blocks: [...(depositsWait ? (["sends"] as const) : []), ...(waitingTransfers > 0 ? (["deliveries"] as const) : [])],
      strandsAt: pipeline.deadline?.at ?? null,
    }),
    constraints: {
      finality: finalityOf(decision),
      gpu: input.gpu,
      job: pipeline.job === null ? null : { jobId: `job:${pipeline.job.jobId}`, status: pipeline.job.status, startedAt: pipeline.job.startedAt },
      proofReady: call !== null,
      posting: await input.posting(destination, call, UPDATE_GAS_FALLBACK),
      after: null,
    },
    fallback: { by: "backend", at: lastUpdateAt === null ? null : lastUpdateAt + input.keepAliveSeconds * 1000 },
  };
}
