/**
 * The confirm-before-send sequence of the web page, as a small state machine with no dependency on React.
 *
 * The rule: a transaction reaches the wallet only through {@link TransactionSequence.confirm}, and `confirm` works only
 * in the `review` phase, which the sequence enters after it prepared the transaction and the dialog showed it. The page
 * never holds a key. The wallet signs.
 */
import type { Address, Hash, Hex } from "viem";
import { prepareTransaction, type PrepareClient, type PreparedTransaction } from "@terminal/tx/prepare";
import type { WebStep } from "./bridge-steps";

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
}

/** The phases, in order. */
export type SequencePhase = "idle" | "preparing" | "review" | "wallet" | "confirming" | "error" | "finished" | "cancelled";

/** What happened to a step. */
export type SequenceOutcome = {
  readonly title: string;
  readonly status: "success" | "reverted";
  readonly transactionHash: Hash;
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
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Creates the sequence for one account.
 *
 * @param dependencies The account, the chain clients and the wallet.
 */
export const createTransactionSequence = (dependencies: SequenceDependencies): TransactionSequence => {
  let state: SequenceState = IDLE_SEQUENCE;
  const listeners = new Set<() => void>();
  // A cancel or a new start makes an older result stale. The counter lets the sequence drop it.
  let generation = 0;

  const publish = (changes: Partial<SequenceState>): void => {
    state = { ...state, ...changes };
    listeners.forEach((listener) => listener());
  };

  const prepareCurrent = async (): Promise<void> => {
    const step = state.steps[state.stepIndex];
    if (step === undefined) return publish({ phase: "finished", prepared: null, submittedHash: null });
    publish({ phase: "preparing", prepared: null, submittedHash: null, error: null });
    const mine = generation;
    try {
      const prepared = await prepareTransaction(dependencies.clientFor(step.plan.chain.chainId), dependencies.account, step.plan);
      if (mine !== generation) return;
      publish({ phase: "review", prepared });
    } catch (error) {
      if (mine !== generation) return;
      publish({ phase: "error", error: `Could not prepare the transaction: ${messageOf(error)}` });
    }
  };

  // No staleness check here. From `confirm` until the result, the phase is "wallet" or "confirming", and in those phases
  // neither `start` nor `cancel` changes the generation, so no other call can make this result stale.
  const sendPrepared = async (prepared: PreparedTransaction): Promise<void> => {
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
      const outcome: SequenceOutcome = { title: prepared.plan.title, status: receipt.status, transactionHash: hash };
      if (receipt.status === "reverted") {
        return publish({ phase: "error", outcomes: [...state.outcomes, outcome], error: `The transaction ${hash} reverted.` });
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
      if (state.phase !== "error" || state.outcomes.some((outcome) => outcome.status === "reverted")) return;
      void prepareCurrent();
    },
    cancel() {
      // Once the wallet holds the transaction the page cannot take it back, so cancel works only before and after.
      if (state.phase !== "preparing" && state.phase !== "review" && state.phase !== "error") return;
      generation += 1;
      publish({ phase: "cancelled", prepared: null, submittedHash: null });
    },
  };
};
