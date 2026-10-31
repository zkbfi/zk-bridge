import type { Address } from "viem";
import type { ProofDirection } from "@zk-bridge/shared";
import { assess, formatHours, neededHandoffPeriods, worseExitCode, EXIT_READ_FAILED, VERDICT_EXIT_CODES, type Assessment, type LightClientFacts, type Policy, type SourceFacts, type SourceHistory } from "./plan.ts";

/** One light client of a pair: the destination of a proof direction. */
export type Target = {
  readonly direction: ProofDirection;
  /** Such as `sepolia -> pulsechain-testnet-v4`: the source chain, then the chain of the light client. */
  readonly label: string;
  readonly lightClient: Address;
  readonly destinationChainId: number;
};

/** The reads the planner needs. A test passes fakes. */
export type Reads = {
  readonly lightClient: (target: Target) => Promise<LightClientFacts>;
  readonly source: (target: Target) => Promise<SourceFacts>;
  readonly history: (target: Target, periods: readonly number[], slotsPerPeriod: number) => Promise<SourceHistory>;
};

/** The clock, the wait and the log line. */
export type Runtime = {
  /** Seconds since 1970. */
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly log: (line: string) => void;
};

/** One light client, read and judged. */
export type Inspection = { readonly facts: LightClientFacts; readonly assessment: Assessment };

/** Reads one light client and its source, asks the source for handoffs only when some are needed, and judges. */
export async function inspect(target: Target, reads: Reads, policy: Policy, nowSeconds: number): Promise<Inspection> {
  const [facts, source] = await Promise.all([reads.lightClient(target), reads.source(target)]);
  const periods = neededHandoffPeriods(facts, source, nowSeconds);
  const history: SourceHistory = periods.length === 0 ? { kind: "not-needed" } : await reads.history(target, periods, facts.slotsPerPeriod);
  return { facts, assessment: assess({ facts, source, history, policy, nowSeconds }) };
}

/** The lines that the status command prints for one light client. */
export function describeInspection(target: Target, inspection: Inspection): string[] {
  const { facts, assessment: a } = inspection;
  const known = a.periodsKnown.join(", ");
  const deadline = a.secondsUntilDeadline >= 0 ? `in ${formatHours(a.secondsUntilDeadline)}` : `${formatHours(-a.secondsUntilDeadline)} ago`;
  const verdict = a.verdict === "needs-stepping" ? `needs stepping (${a.handoffPeriods.length} ${a.handoffPeriods.length === 1 ? "step" : "steps"})` : a.verdict === "stranded" ? "STRANDED" : a.verdict.replace(/-/g, " ");
  return [
    `${target.label}  light client ${target.lightClient} on chain ${target.destinationChainId}  (${target.direction})`,
    `  head slot ${facts.headSlot} (period ${a.headPeriod}, ${formatHours(a.headAgeSeconds)} old); committees known: ${known}`,
    `  source: slot ${a.currentSlot} (period ${a.currentPeriod}), finalized period ${a.finalizedPeriod}; ${a.periodsBehind} ${a.periodsBehind === 1 ? "period" : "periods"} behind`,
    `  handoffs needed after period ${a.lastKnownPeriod} ends: ${deadline}${a.waitForFinality ? "; finality has not crossed the border yet" : ""}`,
    `  verdict: ${verdict}: ${a.reason}`,
  ];
}

/** What a proof attempt came to. */
export type ProofOutcome =
  /** A proof is under way or posted; the head should move. */
  | { readonly kind: "submitted"; readonly detail: string }
  /** The prover found nothing to prove. */
  | { readonly kind: "up-to-date"; readonly detail: string }
  /** The path refused for now (a backend limit, or a backend that sees a fresh head). A later run tries again. */
  | { readonly kind: "deferred"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string };

/** A way to make one proof that moves a light client to the newest finalized header, and get it on chain. */
export type ProofPath = {
  /** What `prove` would do, for the dry run. */
  readonly describe: (target: Target) => string;
  readonly prove: (target: Target, facts: LightClientFacts) => Promise<ProofOutcome>;
};

/** Settings of a march. */
export type MarchOptions = {
  /** Without it, nothing is requested or sent: the march prints its plan. */
  readonly execute: boolean;
  /** The most proofs for one light client in one run. */
  readonly maxProofs: number;
  /** How long to wait for the head to move after a proof was submitted. */
  readonly headTimeoutSeconds: number;
  /** How often to read the head while waiting. */
  readonly pollSeconds: number;
};

/** The end of a march for one light client. */
export type MarchResult = {
  readonly target: Target;
  readonly result: "fresh" | "planned" | "deferred" | "failed" | "not-landed" | "incomplete" | "stranded" | "read-failed";
  readonly detail: string;
  /** Whether the deadline is inside the margin, so waiting for the next run is a risk. */
  readonly urgent: boolean;
  /** The verdict when the march ended, when the light client could be read. */
  readonly verdict: Assessment["verdict"] | null;
};

/** The exit code when a march could not do what the light client needs: a failed or refused proof that is urgent, a head that did not move, or a proof budget used up. */
export const EXIT_ACTION_FAILED = 13;

/** The exit code of one march result. */
export function marchExitCode(result: MarchResult): number {
  switch (result.result) {
    case "fresh":
      return 0;
    case "planned":
      return VERDICT_EXIT_CODES[result.verdict as Assessment["verdict"]];
    case "deferred":
      return result.urgent ? EXIT_ACTION_FAILED : 0;
    case "stranded":
      return VERDICT_EXIT_CODES.stranded;
    case "read-failed":
      return EXIT_READ_FAILED;
    default:
      return EXIT_ACTION_FAILED;
  }
}

/** The exit code of a run and the alert lines for every result that is not fine. */
export function summarize(results: readonly MarchResult[]): { readonly exitCode: number; readonly alerts: readonly string[] } {
  let exitCode = 0;
  const alerts: string[] = [];
  for (const result of results) {
    const code = marchExitCode(result);
    exitCode = worseExitCode(exitCode, code);
    if (code !== 0 && result.result !== "planned") alerts.push(`ALERT light-client ${result.target.label}: ${result.result}: ${result.detail}`);
  }
  return { exitCode, alerts };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Moves one light client until it is fresh: judge it, make one proof through `path`, wait until the head moved, and
 * judge again. Every decision comes from the chain as it is now, so a second run, or a run after a crash, picks up
 * where the chain stands. One proof folds every handoff the light client needs (up to 64), so the loop runs again only
 * for a longer catch-up or when the source moved on while the proof ran.
 */
export async function marchOne(input: {
  readonly target: Target;
  readonly reads: Reads;
  readonly path: ProofPath;
  readonly policy: Policy;
  readonly options: MarchOptions;
  readonly runtime: Runtime;
}): Promise<MarchResult> {
  const { target, reads, path, policy, options, runtime } = input;
  const end = (result: MarchResult["result"], detail: string, inspection: Inspection | null): MarchResult => {
    const urgent = inspection !== null && inspection.assessment.secondsUntilDeadline < policy.marginSeconds;
    runtime.log(`march: ${target.label}: ${result}: ${detail}`);
    return { target, result, detail, urgent, verdict: inspection?.assessment.verdict ?? null };
  };

  for (let proof = 0; ; proof += 1) {
    let inspection: Inspection;
    try {
      inspection = await inspect(target, reads, policy, runtime.now());
    } catch (error) {
      return end("read-failed", errorText(error), null);
    }
    const { assessment, facts } = inspection;
    runtime.log(`march: ${target.label}: head ${facts.headSlot} (period ${assessment.headPeriod}), verdict ${assessment.verdict}: ${assessment.reason}`);
    if (assessment.verdict === "fresh") return end("fresh", assessment.reason, inspection);
    if (assessment.verdict === "stranded") return end("stranded", assessment.reason, inspection);
    if (assessment.waitForFinality) return end("deferred", "finality has not crossed the period border yet; the next run proves", inspection);
    if (proof >= options.maxProofs) return end("incomplete", `still ${assessment.verdict} after ${options.maxProofs} proofs`, inspection);
    const plan = assessment.steps.map((step) => (step.kind === "handoff" ? `handoff ${step.period} (proves ${step.proves})` : `latest in ${step.period}`)).join(", then ");
    if (!options.execute) return end("planned", `would ${path.describe(target)}: ${assessment.proofs} ${assessment.proofs === 1 ? "proof" : "proofs"}: ${plan}`, inspection);

    runtime.log(`march: ${target.label}: proving: ${plan}`);
    let outcome: ProofOutcome;
    try {
      outcome = await path.prove(target, facts);
    } catch (error) {
      outcome = { kind: "failed", detail: errorText(error) };
    }
    if (outcome.kind === "failed") return end("failed", outcome.detail, inspection);
    if (outcome.kind === "deferred") return end("deferred", outcome.detail, inspection);
    if (outcome.kind === "up-to-date") return end("deferred", `the prover found nothing to prove: ${outcome.detail}`, inspection);
    runtime.log(`march: ${target.label}: ${outcome.detail}; waiting for the head to pass ${facts.headSlot}`);
    const moved = await waitForHead({ target, reads, runtime, after: facts.headSlot, options });
    if (moved === null) return end("not-landed", `the head stayed at ${facts.headSlot} for ${options.headTimeoutSeconds} s after the proof`, inspection);
    runtime.log(`march: ${target.label}: head moved ${facts.headSlot} -> ${moved}`);
  }
}

/** Reads the head until it passes `after`. Null on timeout. A failed read counts as no move. */
async function waitForHead(input: { target: Target; reads: Reads; runtime: Runtime; after: number; options: MarchOptions }): Promise<number | null> {
  const { target, reads, runtime, after, options } = input;
  const deadline = runtime.now() + options.headTimeoutSeconds;
  while (runtime.now() < deadline) {
    await runtime.sleep(options.pollSeconds * 1000);
    const head = await reads.lightClient(target).then(
      (facts) => facts.headSlot,
      () => after,
    );
    if (head > after) return head;
  }
  return null;
}
