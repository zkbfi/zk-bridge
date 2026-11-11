/**
 * The confirm-before-send sequence of the web page, as a small state machine with no dependency on React.
 *
 * The rule: a transaction reaches the wallet only through {@link TransactionSequence.confirm}, and `confirm` works only
 * in the `review` phase, which the sequence enters after it prepared the transaction and the dialog showed it. The page
 * never holds a key. The wallet signs.
 *
 * The deposit gate: right before the estimate of a send on a chain with a gate, the sequence asks the gate check (no
 * cache: an epoch lasts 6.4 minutes on Ethereum and Sepolia, and someone else may confirm meanwhile). A send of the native
 * coin goes through the delivery router and carries its own gate evidence: the sequence puts the evidence that the check
 * returns (or none) into the send, so it stays one transaction. For a token relay straight to the mediator, when the epoch
 * needs a confirmation, the sequence inserts the step `confirm(evidence)` before the send, with the gas of its simulation
 * plus the usual margin. When the beacon header of the epoch is not on chain yet, or too little of the epoch is left, it
 * waits and asks again. When the send's estimate still reverts with `ForkNotConfirmed` or `HeaderNotInCurrentEpoch` (the
 * epoch rolled over), it asks once more.
 */
import type { Address, Hash, Hex } from "viem";
import { isGateEpochPassed, revertText, type GateCheck, type GateCheckAnswer } from "@zk-bridge/shared";
import { carriesGateEvidence, decideGateStep, gateErrorText, GATE_WAIT_LIMIT, passesGate, withGateEvidence, withKnownGas, type GateDecision, type GateWait } from "@terminal/tx/gate-step";
import { prepareTransaction, type PrepareClient, type PreparedTransaction } from "@terminal/tx/prepare";
import type { WebStep } from "./bridge-steps";

export { GATE_WAIT_LIMIT, type GateWait };

/** What the page tells when no beacon endpoint answered the gate check. */
const BEACON_HINT = "Check Settings, Beacon endpoints, then try again.";

/** The chain access of one chain. */
export interface SequenceChainClient extends PrepareClient {
  waitForTransactionReceipt(parameters: { hash: Hash }): Promise<{ readonly status: "success" | "reverted"; readonly gasUsed: bigint; readonly blockNumber: bigint }>;
}

/** What the sequence needs from the page. */
export interface SequenceDependencies {
  /** The connected account. */
  readonly account: Address;
  /** The chain client for a chain identifier. */
  readonly clientFor: (chainId: number) => SequenceChainClient;
  /** Asks the wallet to sign and send. The wallet switches chain first when it must. It rejects when the user declines. */
  readonly sendTransaction: (input: {
    readonly chainId: number;
    readonly to: Address;
    readonly data: Hex;
    readonly value: bigint;
    readonly gas: bigint;
  }) => Promise<Hash>;
  /** The deposit gate check. Absent: no check (a page with no chain access, such as the sample page). */
  readonly checkGate?: GateCheck;
  /** Waits before the gate is asked again. Default: a timer. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** The clock in milliseconds, which the time left in the epoch is read from. Default: `Date.now`. */
  readonly now?: () => number;
}

/** The phases, in order. `waiting`: the gate check waits for the beacon header of the epoch, then asks again. */
export type SequencePhase = "idle" | "preparing" | "waiting" | "review" | "wallet" | "confirming" | "error" | "finished" | "cancelled";

/** What happened to a step. */
export type SequenceOutcome = {
  readonly title: string;
  readonly status: "success" | "reverted";
  readonly transactionHash: Hash;
  /** Set for the confirmation of an epoch on the gate. A reverted one does not stop the sequence: a retry checks the gate again. */
  readonly gateConfirm?: true;
};

/** The whole state. The sequence replaces the object on every change. */
export type SequenceState = {
  readonly phase: SequencePhase;
  readonly steps: readonly WebStep[];
  readonly stepIndex: number;
  /** The transaction under review. Null outside the phases that need it. */
  readonly prepared: PreparedTransaction | null;
  /** The hash of the transaction that the wallet sent, while the page waits for the receipt. */
  readonly submittedHash: Hash | null;
  readonly outcomes: readonly SequenceOutcome[];
  readonly error: string | null;
  /** Set in the `waiting` phase. */
  readonly gateWait?: GateWait | null;
};

/** A sequence of transactions under confirmation. */
export interface TransactionSequence {
  getState(): SequenceState;
  subscribe(listener: () => void): () => void;
  /** Starts a sequence. It prepares the first step and stops at the review. */
  start(steps: readonly WebStep[]): void;
  /** Hands the transaction under review to the wallet. */
  confirm(): void;
  /** Prepares the current step again after an error. */
  retry(): void;
  /** Abandons the sequence. Steps that are mined stay mined. */
  cancel(): void;
}

/** The state before anything starts. */
export const IDLE_SEQUENCE: SequenceState = {
  phase: "idle",
  steps: [],
  stepIndex: 0,
  prepared: null,
  submittedHash: null,
  outcomes: [],
  error: null,
  gateWait: null,
};

/** Whether the state allows a retry: an error, and no reverted transaction other than a gate confirmation. */
export const canRetry = (state: SequenceState): boolean =>
  state.phase === "error" && !state.outcomes.some((outcome) => outcome.status === "reverted" && outcome.gateConfirm !== true);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const confirmStepOf = (decision: Extract<GateDecision, { kind: "confirm" }>): WebStep => ({
  plan: decision.plan,
  disclosure: { feesApplyTo: "this-transaction", deliveryCall: null, destinationNativeSymbol: null, destinationChainId: null, amountToken: null, delivery: null },
  gateConfirm: decision.mark,
});

/** How far a preparation went: whether the gate was asked again after a `ForkNotConfirmed`, and how many waits in a row. */
type Attempt = { readonly redone: boolean; readonly waits: number };

const FIRST_ATTEMPT: Attempt = { redone: false, waits: 0 };

/**
 * Creates the sequence for one account.
 *
 * @param dependencies The account, the chain clients, the wallet and the gate check.
 */
export const createTransactionSequence = (dependencies: SequenceDependencies): TransactionSequence => {
  let state: SequenceState = IDLE_SEQUENCE;
  const listeners = new Set<() => void>();
  // A cancel or a new start makes an older result stale. The counter lets the sequence drop it.
  let generation = 0;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const publish = (changes: Partial<SequenceState>): void => {
    state = { ...state, ...changes };
    listeners.forEach((listener) => listener());
  };

  /**
   * Asks the gate before a send. Returns the send decision when the send may be prepared now; null when the sequence went
   * on in another way (a confirmation step inserted and prepared, a wait, an error, or a stale answer).
   */
  const settleGate = async (step: WebStep, mine: number, attempt: Attempt, checkGate: GateCheck): Promise<Extract<GateDecision, { kind: "send" }> | null> => {
    const chain = step.plan.chain;
    let answer: GateCheckAnswer;
    try {
      answer = await checkGate({ chainId: chain.chainId, gate: chain.contracts.gate as Address, account: dependencies.account, ...(carriesGateEvidence(step.plan) ? { carriesEvidence: true } : {}) });
    } catch (error) {
      if (mine === generation) publish({ phase: "error", error: gateErrorText(error, chain.name, BEACON_HINT) });
      return null;
    }
    if (mine !== generation) return null;
    const decision = decideGateStep(answer, { chain, nowMilliseconds: now(), waits: attempt.waits });
    switch (decision.kind) {
      case "send":
        return decision;
      case "refuse":
        publish({ phase: "error", error: decision.message });
        return null;
      case "wait":
        publish({ phase: "waiting", gateWait: decision.wait });
        await sleep(decision.wait.seconds * 1000);
        if (mine === generation) await prepareCurrent({ ...attempt, waits: attempt.waits + 1 });
        return null;
      case "confirm":
        publish({ steps: [...state.steps.slice(0, state.stepIndex), confirmStepOf(decision), ...state.steps.slice(state.stepIndex)] });
        await prepareCurrent(attempt);
        return null;
    }
  };

  /** The step with the gate evidence of the decision, for a send that carries it; the step itself otherwise. */
  const withEvidenceOf = (step: WebStep, decision: Extract<GateDecision, { kind: "send" }>): WebStep => {
    if (!carriesGateEvidence(step.plan)) return step;
    const carried: WebStep = { ...step, plan: withGateEvidence(step.plan, decision.gateEvidence) };
    publish({ steps: state.steps.map((existing, index) => (index === state.stepIndex ? carried : existing)) });
    return carried;
  };

  const prepareCurrent = async (attempt: Attempt = FIRST_ATTEMPT): Promise<void> => {
    const step = state.steps[state.stepIndex];
    if (step === undefined) return publish({ phase: "finished", prepared: null, submittedHash: null, gateWait: null });
    publish({ phase: "preparing", prepared: null, submittedHash: null, error: null, gateWait: null });
    const mine = generation;
    const client = dependencies.clientFor(step.plan.chain.chainId);
    const { checkGate } = dependencies;
    const gated = checkGate !== undefined && step.gateConfirm === undefined && passesGate(step.plan);
    try {
      let ready = step;
      if (gated) {
        const decision = await settleGate(step, mine, attempt, checkGate);
        if (decision === null) return;
        ready = withEvidenceOf(step, decision);
      }
      const prepared = await prepareTransaction(ready.gateConfirm === undefined ? client : withKnownGas(client, ready.gateConfirm.gas), dependencies.account, ready.plan);
      if (mine !== generation) return;
      publish({ phase: "review", prepared });
    } catch (error) {
      if (mine !== generation) return;
      // The epoch rolled over between the check and the estimate, or the node had not seen the confirmation: ask once more.
      if (gated && !attempt.redone && isGateEpochPassed(error)) return prepareCurrent({ redone: true, waits: 0 });
      publish({ phase: "error", error: `Could not prepare the transaction: ${revertText(error, { chainName: step.plan.chain.name }) ?? messageOf(error)}` });
    }
  };

  // No staleness check here. From `confirm` until the result, the phase is "wallet" or "confirming", and in those phases
  // neither `start` nor `cancel` changes the generation, so no other call can make this result stale.
  const sendPrepared = async (prepared: PreparedTransaction): Promise<void> => {
    const confirmation = state.steps[state.stepIndex]?.gateConfirm;
    try {
      const hash = await dependencies.sendTransaction({
        chainId: prepared.plan.chain.chainId,
        to: prepared.plan.to,
        data: prepared.plan.data,
        value: prepared.plan.value,
        gas: prepared.gasLimit,
      });
      publish({ phase: "confirming", submittedHash: hash });
      const receipt = await dependencies.clientFor(prepared.plan.chain.chainId).waitForTransactionReceipt({ hash });
      const outcome: SequenceOutcome = { title: prepared.plan.title, status: receipt.status, transactionHash: hash, ...(confirmation === undefined ? {} : { gateConfirm: true as const }) };
      if (receipt.status === "reverted") {
        const error =
          confirmation === undefined
            ? `The transaction ${hash} reverted.`
            : `The confirmation of epoch ${confirmation.epoch} reverted in ${hash}. Nothing else was sent. Try again to check the gate and confirm the current epoch.`;
        return publish({ phase: "error", outcomes: [...state.outcomes, outcome], error });
      }
      publish({ outcomes: [...state.outcomes, outcome], stepIndex: state.stepIndex + 1 });
      await prepareCurrent();
    } catch (error) {
      publish({ phase: "error", submittedHash: null, error: `Not sent: ${messageOf(error)}` });
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(steps) {
      if (state.phase !== "idle" && state.phase !== "finished" && state.phase !== "cancelled") return;
      generation += 1;
      state = { ...IDLE_SEQUENCE, steps, phase: "preparing" };
      listeners.forEach((listener) => listener());
      void prepareCurrent();
    },
    confirm() {
      const { prepared } = state;
      if (state.phase !== "review" || prepared === null) return;
      publish({ phase: "wallet" });
      void sendPrepared(prepared);
    },
    retry() {
      if (!canRetry(state)) return;
      // A confirmation is never prepared twice: its evidence names one epoch. A reverted one stays in the list as mined;
      // one that was not sent leaves it. Either way the send comes next, and its preparation asks the gate again.
      if (state.steps[state.stepIndex]?.gateConfirm !== undefined) {
        if (state.outcomes.length > state.stepIndex) publish({ stepIndex: state.stepIndex + 1 });
        else publish({ steps: state.steps.filter((_, index) => index !== state.stepIndex) });
      }
      void prepareCurrent();
    },
    cancel() {
      // Once the wallet holds the transaction the page cannot take it back, so cancel works only before and after.
      if (state.phase !== "preparing" && state.phase !== "waiting" && state.phase !== "review" && state.phase !== "error") return;
      generation += 1;
      publish({ phase: "cancelled", prepared: null, submittedHash: null, gateWait: null });
    },
  };
};
