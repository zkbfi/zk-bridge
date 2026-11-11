/**
 * The words of the Route section (docs/superpowers/specs/2026-11-11-route-actions-design.md): for each pending step of the
 * route, its situation and its constraints in numbers, and what a refused request means. Pure: a time is a number of
 * milliseconds that the caller passes in, and nothing here reads the network.
 */
import { STEP_TITLES, usesGpu, type RouteStep, type StepRequestAnswer } from "@zk-bridge/shared";
import type { PairConfig } from "@terminal/model/types";
import { shortAmountText } from "../bridge/number";
import { waitText } from "../bridge/proof-request";
import { durationText } from "../explore/explore-model";

/** What the words need to know about the page. */
export type RouteContext = { readonly pair: PairConfig; readonly nowMs: number };

const chainOf = (pair: PairConfig, chainId: number) => (pair.first.chainId === chainId ? pair.first : pair.second);

/** The chain name of a chain id of the pair. */
export const routeChainName = (pair: PairConfig, chainId: number): string => chainOf(pair, chainId).name;

/** The source and the destination chain of a direction. */
export const directionChains = (pair: PairConfig, direction: "first-to-second" | "second-to-first") =>
  direction === "first-to-second" ? { source: pair.first, destination: pair.second } : { source: pair.second, destination: pair.first };

/** "14:32 UTC". */
export const clockText = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** "in 12 min" for a time ahead, "12 min ago" for one behind. */
export const relativeText = (ms: number, nowMs: number): string => {
  const seconds = Math.round((ms - nowMs) / 1000);
  return seconds >= 0 ? `in ${durationText(seconds)}` : `${durationText(-seconds)} ago`;
};

const chainName = (step: RouteStep, pair: PairConfig): string => routeChainName(pair, step.chainId);

/** The heading of a step: its title. */
export const stepTitle = (step: RouteStep): string => STEP_TITLES[step.kind];

/** What the step is about, in chain names: the route, the chain or the transfer. */
export const stepSubtitle = (step: RouteStep, pair: PairConfig): string => {
  const name = chainName(step, pair);
  switch (step.kind) {
    case "light-client-update": {
      const { source, destination } = directionChains(pair, step.direction ?? "first-to-second");
      return `${source.name} to ${destination.name}: posts to the ${destination.name} light client`;
    }
    case "open-deposits": {
      const { source, destination } = directionChains(pair, step.direction ?? "first-to-second");
      return `${source.name} to ${destination.name}: opens deposits on the ${destination.name} bridge`;
    }
    case "registry-light-client-update":
      return `${name} fork registry`;
    case "fork-observation":
      return `${name} fork registry`;
    case "seal":
      return `${name} deposit gate`;
    default:
      return `Transfer ${step.messageId ?? step.subject}, delivered on ${name}`;
  }
};

const countText = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The situation of a step in numbers, one sentence each. */
export const situationLines = (step: RouteStep, context: RouteContext): readonly string[] => {
  const { pair, nowMs } = context;
  const { situation } = step;
  const name = chainName(step, pair);
  const lines: string[] = [];
  const waiting = situation.waitingTransfers === 0 ? null : `${countText(situation.waitingTransfers, "transfer")} wait${situation.waitingTransfers === 1 ? "s" : ""} for it`;
  const strands = (verb: string): string | null => (situation.strandsAt === null ? null : `${verb} ${relativeText(situation.strandsAt, nowMs)} (${clockText(situation.strandsAt)})`);
  const join = (head: string, ...rest: readonly (string | null)[]): string => `${[head, ...rest.filter((part): part is string => part !== null)].join("; ")}.`;
  switch (step.kind) {
    case "light-client-update": {
      const { source, destination } = directionChains(pair, step.direction ?? "first-to-second");
      const behind = situation.behindSeconds === null ? `${source.name}'s light client on ${destination.name} has no head read` : `${source.name}'s light client on ${destination.name} is ${durationText(situation.behindSeconds)} behind`;
      lines.push(join(behind, waiting, strands("it strands")));
      break;
    }
    case "registry-light-client-update": {
      const behind = situation.behindSeconds === null ? `The fork registry's light client on ${name} has no head read` : `The fork registry's light client on ${name} is ${durationText(situation.behindSeconds)} behind`;
      lines.push(join(behind, strands("it reaches its 64-period limit")));
      break;
    }
    case "fork-observation":
      lines.push(join(`${name} runs fork version ${situation.activeVersion ?? "unknown"}; the fork registry holds ${situation.recordedVersion ?? "none"}`, waiting));
      break;
    case "open-deposits":
      lines.push(join(`Deposits on ${name} are closed${situation.since === null ? "" : ` since ${clockText(situation.since)}`}`, waiting));
      break;
    case "layout-rows":
      lines.push(join(`${countText(situation.layoutRows ?? 0, "layout row")} must be posted on ${name} before this transfer can be delivered`));
      break;
    case "deliver":
      lines.push(join(`This transfer is covered on ${name} and waits for its delivery`, situation.layoutRows === null || situation.layoutRows === 0 ? null : `${countText(situation.layoutRows, "layout row")} first`));
      break;
    case "seal":
      lines.push(join(`The ${name} deposit gate can be sealed now; once sealed it admits no send, and withdrawals still work`));
      break;
  }
  if (situation.blocks.length > 0) lines.push(`It holds up ${situation.blocks.map((block) => (block === "sends" ? "new sends" : "deliveries")).join(" and ")}.`);
  return lines;
};

const GAS_PRICE_UNIT = 1_000_000_000n;

const gweiText = (wei: bigint): string => (wei < GAS_PRICE_UNIT / 100n ? `${wei.toString()} wei` : `${shortAmountText(wei, 9)} gwei`);

/** One constraint: its key (for a test id) and its sentence. */
export type ConstraintLine = { readonly key: "finality" | "gpu" | "budget" | "job" | "posting" | "after" | "fallback"; readonly text: string };

/**
 * The constraints of a step in numbers: when the proof can be made, what the GPU takes and has left, the job to join,
 * the gas and cost of posting, the step that lands first, and who posts it when nobody does.
 *
 * @param step The step.
 * @param context The page.
 * @param steps Every pending step, to name the one that must land first.
 */
export const constraintLines = (step: RouteStep, context: RouteContext, steps: readonly RouteStep[]): readonly ConstraintLine[] => {
  const { pair, nowMs } = context;
  const { constraints, fallback } = step;
  const lines: ConstraintLine[] = [];
  if (constraints.finality !== null) {
    const next = constraints.finality.nextAt;
    lines.push({
      key: "finality",
      text:
        next > nowMs
          ? `The next block becomes final at ${clockText(next)} (${relativeText(next, nowMs)}); the newest final slot is ${constraints.finality.finalizedSlot}.`
          : `The newest final slot is ${constraints.finality.finalizedSlot}; the next block becomes final about now (${clockText(next)}).`,
    });
  }
  const { gpu } = constraints;
  if (usesGpu(step.kind)) {
    if (gpu === null) {
      lines.push({ key: "gpu", text: "The proof runs on the GPU; the backend has no timing for it yet." });
    } else {
      const warm = gpu.warmMs === null ? null : `about ${waitText(gpu.warmMs / 1000)} on a warm worker`;
      const cold = gpu.coldMs === null ? null : `about ${waitText(gpu.coldMs / 1000)} if a worker has to start`;
      const timing = [warm, cold].filter((part): part is string => part !== null).join("; ");
      lines.push({ key: "gpu", text: `${timing === "" ? "The proof runs on the GPU" : `The proof takes ${timing}`}. ${gpu.workerWarm ? "A worker is warm now." : "No worker is warm now."}` });
      lines.push({ key: "budget", text: `$${gpu.leftUsd.toFixed(2)} of the $${gpu.budgetUsd.toFixed(2)} GPU budget for this direction is left today.` });
    }
  } else {
    lines.push({ key: "gpu", text: "The proof is built in a few seconds from chain data; it uses no GPU." });
  }
  if (constraints.job !== null) lines.push({ key: "job", text: `A proof for this finality is being made (started ${relativeText(constraints.job.startedAt, nowMs)}): you join it.` });
  const { posting } = constraints;
  const symbol = chainOf(pair, step.chainId).nativeSymbol;
  if (posting.gas === null) {
    lines.push({ key: "posting", text: "The gas of the posting transaction is known once the proof exists." });
  } else {
    const gas = Number(posting.gas).toLocaleString("en-US");
    const source = posting.gasSource === "simulated" ? "simulated with the proof" : "the figure the backend's own posting uses";
    const cost = posting.costWei === null || posting.gasPriceWei === null ? "" : `, about ${shortAmountText(BigInt(posting.costWei), 18)} ${symbol} at ${gweiText(BigInt(posting.gasPriceWei))}`;
    lines.push({ key: "posting", text: `Posting uses ${gas} gas (${source})${cost}.` });
  }
  if (constraints.after !== null) {
    const first = steps.find((entry) => entry.id === constraints.after);
    lines.push({ key: "after", text: `It lands after: ${first === undefined ? constraints.after : `${stepTitle(first)}, ${stepSubtitle(first, pair)}`}.` });
  }
  if (fallback !== null) {
    const who = fallback.by === "runner" ? "the runner" : "the backend";
    lines.push({ key: "fallback", text: fallback.at === null ? `If nobody posts it, ${who} posts it as soon as it can.` : `If nobody posts it, ${who} posts it at ${clockText(fallback.at)} (${relativeText(fallback.at, nowMs)}).` });
  }
  return lines;
};

/** What a refused or failed request says, and until when the button stays off. Null for an accepted request. */
export type RequestRefusal = { readonly note: string; readonly retryAt: number | null };

/**
 * The words of a request's answer.
 *
 * @param answer The backend's answer, or null when it did not answer.
 * @param nowMs The time now.
 */
export const requestRefusal = (answer: StepRequestAnswer | null, nowMs: number): RequestRefusal | null => {
  const later = (seconds: number): number => nowMs + Math.max(1, seconds) * 1000;
  if (answer === null) return { note: "The backend did not take the request. Try again in 1 min.", retryAt: later(60) };
  if (!("refused" in answer)) return null;
  switch (answer.refused) {
    case "nothing-to-prove":
      return { note: answer.why === "proof-pending" ? "A proof is made already and waits to land." : "This step is not pending any more.", retryAt: null };
    case "cannot-check":
      return { note: `The backend could not read the chains. Try again in ${waitText(answer.retryAfterSeconds)}.`, retryAt: later(answer.retryAfterSeconds) };
    case "not-served":
      return { note: "This backend does not make this proof.", retryAt: null };
    default: {
      const wait = waitText(answer.retryAfterSeconds);
      const retryAt = later(answer.retryAfterSeconds);
      if (answer.why === "same-finality") return { note: `A proof for the newest finality is already made or running. The next finality comes in about ${wait}.`, retryAt };
      if (answer.why === "gpu-budget") return { note: `The 24-hour GPU budget of this direction is used up. It frees in about ${wait}.`, retryAt };
      if (answer.detail !== undefined) return { note: `${answer.detail.charAt(0).toUpperCase()}${answer.detail.slice(1)}. Try again in ${wait}.`, retryAt };
      return { note: `Too many requests from this address. Try again in ${wait}.`, retryAt };
    }
  }
};

/**
 * The one-line notice of the Bridge screen for the steps that hold up sends or deliveries.
 *
 * @param blockers The steps of `routeBlockersOf`.
 * @param context The page.
 */
export const blockerNotice = (blockers: readonly RouteStep[], context: RouteContext): string | null => {
  const first = blockers[0];
  if (first === undefined) return null;
  const { pair, nowMs } = context;
  const name = chainName(first, pair);
  const more = blockers.length > 1 ? ` ${blockers.length - 1} more step${blockers.length === 2 ? " waits" : "s wait"} too.` : "";
  switch (first.kind) {
    case "open-deposits":
      return `Deposits on ${name} are closed until someone posts the opening proof.${more}`;
    case "seal":
      return `The ${name} deposit gate can be sealed, which stops every send through it.${more}`;
    default: {
      const { source, destination } = directionChains(pair, first.direction ?? "first-to-second");
      const left = first.situation.strandsAt === null ? "" : ` in ${durationText(Math.max(0, (first.situation.strandsAt - nowMs) / 1000))}`;
      return `The ${destination.name} light client for ${source.name} strands${left} unless someone posts an update.${more}`;
    }
  }
};

/** "mm:ss" of an elapsed or remaining span, for a job in progress. */
export const spanClock = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
