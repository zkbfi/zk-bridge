/**
 * One pending step of the route as a square panel: its title, its situation and constraints in numbers, and the guided
 * flow: "Make the proof" (the backend makes it, the job shows) then "Post it from your wallet" (the normal review dialog)
 * then "Done" with the transaction. When the step leaves the list, or the head moved past the proof, the card says that
 * someone else posted it and stops. A wallet is needed only to post.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { stepFlow, usesGpu, type RequestableStepKind, type RouteStep } from "@zk-bridge/shared";
import { TransactionDialog } from "../actions/TransactionDialog";
import { useServices } from "../app/services";
import { formatRoute } from "../app/route";
import { useClockSeconds } from "../fork/use-fork";
import type { WebStep } from "../tx/bridge-steps";
import { CopyValue } from "../ui/CopyValue";
import { useWallet } from "../wallet/wallet-port";
import { planStepPost } from "./plan-step";
import { constraintLines, requestRefusal, situationLines, spanClock, stepSubtitle, stepTitle, type RequestRefusal } from "./route-model";
import { useStepBackend, useStepJob } from "./route-port";
import "./route.css";

/** Props of {@link StepCard}. */
export type StepCardProps = {
  /** The step as last listed. */
  readonly step: RouteStep;
  /** The step as the newest list shows it, or null once it is no longer listed (somebody posted it). */
  readonly pending: RouteStep | null;
  /** Every pending step, to name the one that must land first. */
  readonly steps: readonly RouteStep[];
  /** `trail`: inside a drawer of a transfer's timeline, with no padding of its own. */
  readonly placement?: "section" | "trail";
};

/**
 * The card of one step.
 *
 * @param props The step, whether it is still listed, and where the card sits.
 */
export const StepCard = ({ step, pending, steps, placement = "section" }: StepCardProps) => {
  const services = useServices();
  const { pair } = services;
  const wallet = useWallet();
  const backend = useStepBackend();
  const queryClient = useQueryClient();
  const nowMs = useClockSeconds(1_000) * 1_000;
  const [requested, setRequested] = useState<{ readonly jobId: string | null; readonly ready: boolean } | null>(null);
  const [refusal, setRefusal] = useState<RequestRefusal | null>(null);
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [postNote, setPostNote] = useState<string | null>(null);
  const [movedOn, setMovedOn] = useState<string | null>(null);
  const [review, setReview] = useState<readonly WebStep[] | null>(null);
  const [transaction, setTransaction] = useState<string | null>(null);

  const jobId = requested?.jobId ?? pending?.constraints.job?.jobId ?? null;
  const job = useStepJob(jobId);
  const proofReady = requested?.ready === true || job?.status === "done";
  const flow = stepFlow({ kind: step.kind, pending: movedOn === null ? pending : null, job, proofReady, transaction, refusal });
  const context = { pair, nowMs };
  const live = pending ?? step;

  const make = async (): Promise<void> => {
    setSending(true);
    // The button shows only for a step that is not a seal, and the backend makes the proof of every other kind.
    const answer = await backend.request({ pair: pair.id, kind: step.kind as RequestableStepKind, subject: step.subject });
    setSending(false);
    const refused = requestRefusal(answer, nowMs);
    setRefusal(refused);
    if (answer !== null && !("refused" in answer)) {
      setRequested({ jobId: answer.jobId, ready: answer.ready === true });
    } else if (answer !== null && "refused" in answer && answer.refused === "nothing-to-prove") {
      if (answer.why === "proof-pending") setRequested({ jobId: null, ready: true });
      void queryClient.invalidateQueries({ queryKey: ["route-steps"] });
    }
  };

  const post = async (): Promise<void> => {
    if (wallet.account === null) {
      await wallet.connect();
      return;
    }
    setChecking(true);
    setPostNote(null);
    const plan = await planStepPost({ step, pair, account: wallet.account, backend, forks: services.forks, readLightClientHead: services.readLightClientHead });
    setChecking(false);
    if (plan.kind === "ready") setReview(plan.steps);
    else if (plan.kind === "blocked") setPostNote(plan.reason);
    else setMovedOn(plan.reason);
  };

  const retryLeft = flow.phase === "make" && flow.retryAt !== null && flow.retryAt > nowMs ? (flow.retryAt - nowMs) / 1000 : null;

  return (
    <section className="zb-rs" data-placement={placement} data-testid={`route-step-${step.id}`} data-phase={flow.phase}>
      <h4 className="zb-rs-h">{stepTitle(step)}</h4>
      <p className="zb-small zb-rs-sub">{stepSubtitle(step, pair)}</p>
      {step.messageId === null ? null : (
        <p className="zb-small">
          <CopyValue value={step.messageId} label="Copy message ID" className="zb-break">{step.messageId}</CopyValue> <a href={formatRoute({ name: "message", messageId: step.messageId as `0x${string}` })}>Open the transfer</a>
        </p>
      )}
      {flow.phase === "posted-elsewhere" || flow.phase === "done" ? null : (
        <>
          <div className="zb-rs-group" data-testid="route-situation">
            {situationLines(live, context).map((line) => (
              <p key={line} className="zb-rs-line">{line}</p>
            ))}
          </div>
          <div className="zb-rs-group" data-testid="route-constraints">
            {constraintLines(live, context, steps).map((line) => (
              <p key={line.key} className="zb-small zb-rs-line" data-testid={`route-constraint-${line.key}`}>{line.text}</p>
            ))}
          </div>
        </>
      )}
      <div className="zb-xactions zb-rs-flow">
        {flow.phase === "make" || flow.phase === "failed" ? (
          <>
            <button type="button" className="zb-pill" data-testid="route-make" disabled={sending || retryLeft !== null} onClick={() => void make()}>
              {flow.phase === "failed" ? "Make the proof again" : "Make the proof"}
            </button>
            <p className="zb-small" data-testid="route-flow-note">
              {flow.phase === "failed" ? `The proof could not be made: ${flow.error}.` : (flow.note ?? (usesGpu(step.kind) ? "The backend makes the proof on its GPU. Nothing is sent from your wallet yet." : "The backend builds the proof in a few seconds. Nothing is sent from your wallet yet."))}
              {retryLeft === null ? "" : ` The button comes back in ${spanClock(retryLeft * 1000)}.`}
            </p>
          </>
        ) : null}
        {flow.phase === "proving" ? (
          <p className="zb-small" role="status" data-testid="route-progress">
            Making the proof: {spanClock(nowMs - flow.startedAt)} elapsed{flow.etaAt === null ? "" : flow.etaAt > nowMs ? `, about ${spanClock(flow.etaAt - nowMs)} to go` : ", it should land any moment"}.
          </p>
        ) : null}
        {flow.phase === "post" ? (
          <>
            <button type="button" className="zb-pill" data-testid="route-post" disabled={checking} onClick={() => void post()}>
              {wallet.account === null ? "Connect a wallet to post it" : "Post it from your wallet"}
            </button>
            <p className="zb-small">{step.kind === "seal" || step.kind === "fork-observation" ? "The call is simulated first; the review shows it before anything is sent." : "The proof is made. The review shows the call before anything is sent."}</p>
          </>
        ) : null}
        {flow.phase === "done" ? (
          <p className="zb-small" data-testid="route-done">
            Done. Your transaction: <CopyValue value={flow.transaction} label="Copy the transaction hash">{flow.transaction}</CopyValue>
          </p>
        ) : null}
        {flow.phase === "posted-elsewhere" ? (
          <p className="zb-small" data-testid="route-elsewhere">
            Someone else posted this step: the backend, the runner or another visitor. Nothing is left to do here.{movedOn === null ? "" : ` ${movedOn}`}
          </p>
        ) : null}
      </div>
      {postNote === null ? null : <p className="zb-small zb-rs-warn" data-testid="route-post-note">{postNote}</p>}
      {review === null ? null : (
        <TransactionDialog
          steps={review}
          onClose={() => setReview(null)}
          onFinished={(hash) => {
            setTransaction(hash);
            void queryClient.invalidateQueries({ queryKey: ["route-steps"] });
          }}
        />
      )}
    </section>
  );
};
