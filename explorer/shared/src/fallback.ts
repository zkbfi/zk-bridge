/**
 * The rule that picks the data source: the indexer first, the RPC source when the indexer fails, and the indexer again
 * when it is healthy. The controller holds no network code. The caller gives it the two ways to do a read and a probe
 * that checks the indexer, so the same rule serves the terminal and the web page.
 */

/** Why the RPC source is in use. */
export type FallbackReasonCode = "not-set" | "unreachable" | "error" | "behind";

/** A reason with a sentence for the screen. The sentence holds no secret. */
export type FallbackReason = {
  readonly code: FallbackReasonCode;
  readonly message: string;
};

/** Which source answers now. */
export type SourceStatus =
  | { readonly kind: "indexer"; readonly reason: null; readonly label: "indexer" }
  | { readonly kind: "rpc"; readonly reason: FallbackReason; readonly label: string };

/** The result of checking the indexer. */
export type ProbeResult = { readonly ok: true } | { readonly ok: false; readonly reason: FallbackReason };

/** The options of {@link createFallbackController}. */
export type FallbackOptions = {
  /** False when no indexer URL is set. The controller then uses the RPC source and never probes. */
  readonly indexerConfigured: boolean;
  /** Checks that the indexer answers and is not behind the chain head. */
  readonly probe: () => Promise<ProbeResult>;
  /** Turns the error of a failed indexer read into a reason. Default: {@link describeFailure}. */
  readonly describeError?: (error: unknown) => FallbackReason;
  /** How often the controller checks a healthy indexer for lag, in milliseconds. Default 30000. */
  readonly freshnessIntervalMilliseconds?: number;
  /** How often the controller checks a failed indexer to switch back, in milliseconds. Default 15000. */
  readonly recoveryIntervalMilliseconds?: number;
  /** The clock in milliseconds. Default `Date.now`. */
  readonly now?: () => number;
};

/** Chooses between the indexer and the RPC source for each read. */
export interface FallbackController {
  /**
   * Runs one read. With a healthy indexer it runs `viaIndexer`. When that fails, or when the RPC source is in use, it
   * runs `viaRpc`. A failure of `viaRpc` is not caught.
   */
  run<value>(operations: {
    readonly viaIndexer: () => Promise<value>;
    readonly viaRpc: () => Promise<value>;
    /**
     * The signal of the caller. When it has aborted, a failure of `viaIndexer` is the caller leaving, not a fault of the
     * indexer: the error goes up, the status stays and `viaRpc` does not run.
     */
    readonly signal?: AbortSignal;
  }): Promise<value>;
  status(): SourceStatus;
  /** Calls the listener each time the status changes. Returns the function that removes the listener. */
  subscribe(listener: (status: SourceStatus) => void): () => void;
  /** Checks the indexer now and switches if needed. Resolves when the check ends. */
  checkNow(): Promise<void>;
}

const INDEXER_STATUS: SourceStatus = { kind: "indexer", reason: null, label: "indexer" };

/**
 * The reason for a failed read of the indexer. A network failure or a time-out is `unreachable`. Any other failure is
 * `error`, and the message keeps its first 80 characters. The caller redacts secrets from the message.
 *
 * @param error What the read threw.
 */
export const describeFailure = (error: unknown): FallbackReason => {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "TypeError" || name === "AbortError" || name === "TimeoutError" || /fetch failed|network|ECONNREFUSED|ENOTFOUND/i.test(message)) {
    return { code: "unreachable", message: "indexer unreachable" };
  }
  return { code: "error", message: `indexer error: ${message.slice(0, 80)}` };
};

const rpcStatus = (reason: FallbackReason): SourceStatus => ({ kind: "rpc", reason, label: `RPC fallback: ${reason.message}` });

/**
 * Creates the controller. It starts on the indexer when one is set, else on the RPC source.
 *
 * A read of the indexer that fails switches to the RPC source at once, and that read runs again on the RPC source.
 * No timer runs: the controller checks the indexer lazily, at the start of a read, when the interval has passed. A check
 * of a healthy indexer finds lag. A check of a failed indexer finds recovery.
 *
 * @param options The probe, the intervals and the clock.
 */
export const createFallbackController = (options: FallbackOptions): FallbackController => {
  const now = options.now ?? Date.now;
  const describeError = options.describeError ?? describeFailure;
  const freshnessInterval = options.freshnessIntervalMilliseconds ?? 30_000;
  const recoveryInterval = options.recoveryIntervalMilliseconds ?? 15_000;
  const listeners = new Set<(status: SourceStatus) => void>();
  let current: SourceStatus = options.indexerConfigured
    ? INDEXER_STATUS
    : rpcStatus({ code: "not-set", message: "no indexer URL is set" });
  let lastCheckAt = now();
  let checking: Promise<void> | null = null;

  const change = (next: SourceStatus): void => {
    if (current.label === next.label) return;
    current = next;
    for (const listener of [...listeners]) listener(current);
  };

  const check = (): Promise<void> => {
    if (checking !== null) return checking;
    lastCheckAt = now();
    checking = options
      .probe()
      .catch((error: unknown): ProbeResult => ({ ok: false, reason: describeError(error) }))
      .then((result) => change(result.ok ? INDEXER_STATUS : rpcStatus(result.reason)))
      .finally(() => {
        checking = null;
      });
    return checking;
  };

  const checkWhenDue = (): void => {
    if (!options.indexerConfigured) return;
    const interval = current.kind === "indexer" ? freshnessInterval : recoveryInterval;
    if (now() - lastCheckAt >= interval) void check();
  };

  return {
    async run(operations) {
      checkWhenDue();
      if (current.kind === "rpc") return operations.viaRpc();
      try {
        return await operations.viaIndexer();
      } catch (error) {
        if (operations.signal?.aborted === true) throw error;
        change(rpcStatus(describeError(error)));
        return operations.viaRpc();
      }
    },
    status: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async checkNow() {
      if (options.indexerConfigured) await check();
    },
  };
};

/** The inputs of {@link judgeIndexerFreshness}. */
export type FreshnessInput = {
  /** The newest block time that the indexer holds for each chain, in unix seconds. Null when it holds none. */
  readonly indexerTips: readonly (number | null)[];
  /** The time of the newest block of each chain, in unix seconds. */
  readonly chainTips: readonly number[];
  /** The most seconds the indexer may lag. */
  readonly maximumLagSeconds: number;
};

/**
 * Decides whether the indexer is behind the chain head. The lag of a chain is the time of its newest block minus the
 * time of the newest block that the indexer holds. An indexer with no block for a chain is behind.
 *
 * @param input The tips of the indexer, the tips of the chains and the limit.
 */
export const judgeIndexerFreshness = (input: FreshnessInput): ProbeResult => {
  const lags = input.chainTips.map((chainTip, position) => {
    const indexerTip = input.indexerTips[position] ?? null;
    return indexerTip === null ? Number.POSITIVE_INFINITY : chainTip - indexerTip;
  });
  const worst = Math.max(0, ...lags);
  if (worst <= input.maximumLagSeconds) return { ok: true };
  const seconds = Number.isFinite(worst) ? `${Math.round(worst)} s` : "an unknown time";
  return { ok: false, reason: { code: "behind", message: `indexer ${seconds} behind the chain head` } };
};
