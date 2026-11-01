import { formatUnits, type Address, type Hex } from "viem";
import { bridgedSymbolOf, defaultTip, encodeFeeDirector, GateEvidenceError, routerCallbackGas, type FeeDirector, type GateConfirmation, type ProtectedAddress, type ProofDirection } from "@zk-bridge/shared";
import { sendTerms, worstCaseCostWei, type TransactionPort } from "../chain/transactions.ts";
import type { Logger } from "../logging/logger.ts";
import { approvalData, messageIdOf, relayData, relayRefusalOf, type TrafficReader } from "./chain.ts";
import type { TrafficGate } from "./gate.ts";
import { pickTransfer, type Candidate, type Random, type TokenBounds } from "./plan.ts";
import type { TestToken } from "./tokens-file.ts";

/** One chain as the traffic bot uses it. */
export interface TrafficSide {
  readonly chainId: number;
  readonly name: string;
  readonly reader: TrafficReader;
  /** Signs and sends from the traffic wallet on this chain. */
  readonly port: TransactionPort;
  readonly contracts: {
    readonly mediator: Address;
    readonly bridge: Address;
    readonly tokenFactory: Address;
    readonly wrappedNative: Address;
    readonly deliveryRouter: Address | null;
  };
  /** The native coin that the wallet keeps on this chain. */
  readonly minimumNativeWei: bigint;
  /**
   * The deposit gate of this chain. Before a send from here, the bot confirms the epoch when the gate enforces and nobody
   * confirmed it yet. Null: never look (tests, or a chain without a gate).
   */
  readonly gate: TrafficGate | null;
}

/** Input of {@link createTraffic}. */
export interface TrafficInput {
  /** The first and the second side of the pair. */
  readonly sides: readonly [TrafficSide, TrafficSide];
  /** The native test tokens of both chains. */
  readonly tokens: readonly TestToken[];
  /** The settings by symbol, in base units. A token without an entry is not sent. */
  readonly bounds: ReadonlyMap<string, (decimals: number) => TokenBounds>;
  /** The tip in the share mode, scaled by 1e18: 1e15 is 0.1 percent. */
  readonly tipRate: bigint;
  /** The addresses a fee recipient must not be: the routers, mediators and bridges of the pair. */
  readonly protectedAddresses: readonly ProtectedAddress[];
  readonly random: Random;
  readonly logger: Logger;
  /** Waits, between two looks at the gate when the epoch has no header yet. Default: a timer. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * How many times an attempt waits for a header of the new epoch (a slot each) before it gives up. A header is missing in
 * the first slot of an epoch and after missed slots.
 */
export const GATE_WAITS = 3;

/** What one attempt did. */
export type TrafficOutcome =
  | {
      readonly kind: "sent";
      readonly direction: ProofDirection;
      readonly symbol: string;
      readonly token: Address;
      readonly amount: bigint;
      readonly transactionHash: Hex;
      readonly messageId: Hex | null;
    }
  | { readonly kind: "skipped"; readonly direction: ProofDirection; readonly reason: string };

/** An attempt that sent nothing more. */
type SkippedOutcome = Extract<TrafficOutcome, { readonly kind: "skipped" }>;

/** Input of one attempt. */
export interface AttemptInput {
  readonly direction: ProofDirection;
  /**
   * Called once, before the first transaction of the attempt leaves. The service records the slot here, so an attempt
   * whose receipt never arrives is not sent a second time.
   */
  readonly beforeFirstSend: () => Promise<void>;
}

/** The traffic bot of one pair. */
export interface Traffic {
  /** Picks a transfer for a direction and sends it, with an approval first when the mediator needs one. */
  attempt(input: AttemptInput): Promise<TrafficOutcome>;
  /** The test tokens and their bridged copies, as the runner's `tokenValuationsWei` needs them listed. */
  describeTokens(): Promise<readonly { readonly symbol: string; readonly chainId: number; readonly address: Address; readonly copyChainId: number; readonly copyAddress: Address }[]>;
}

/** The source and destination sides of a direction. */
function sidesOf(sides: readonly [TrafficSide, TrafficSide], direction: ProofDirection): { readonly source: TrafficSide; readonly destination: TrafficSide } {
  return direction === "first-to-second" ? { source: sides[0], destination: sides[1] } : { source: sides[1], destination: sides[0] };
}

/** Builds the traffic bot. */
export function createTraffic(input: TrafficInput): Traffic {
  const { sides, logger } = input;
  const wallet = sides[0].port.account;
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  /** The candidates of a direction: the native tokens of the source, and the copies on the source of the destination's tokens. */
  async function candidatesOf(source: TrafficSide, destination: TrafficSide): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    for (const token of input.tokens) {
      const bounds = input.bounds.get(token.symbol)?.(token.decimals);
      if (bounds === undefined) continue;
      if (token.chainId === source.chainId) {
        const balance = await source.reader.tokenBalance(token.address, wallet);
        const copy = await destination.reader.copyAddress({ tokenFactory: destination.contracts.tokenFactory, homeChainId: source.chainId, nativeToken: token.address });
        const homeRecord = await source.reader.nativeRecord(source.contracts.mediator, token.address);
        candidates.push({ symbol: token.symbol, kind: "native", decimals: token.decimals, sourceToken: token.address, destinationToken: copy, sourceBalance: balance, homeBalance: balance, homeRecord, bounds });
      } else if (token.chainId === destination.chainId) {
        const copy = await source.reader.copyAddress({ tokenFactory: source.contracts.tokenFactory, homeChainId: destination.chainId, nativeToken: token.address });
        const copyBalance = await source.reader.tokenBalance(copy, wallet);
        const homeBalance = await destination.reader.tokenBalance(token.address, wallet);
        const homeRecord = await destination.reader.nativeRecord(destination.contracts.mediator, token.address);
        candidates.push({ symbol: token.symbol, kind: "copy", decimals: token.decimals, sourceToken: copy, destinationToken: token.address, sourceBalance: copyBalance, homeBalance, homeRecord, bounds });
      }
    }
    return candidates;
  }

  function skip(direction: ProofDirection, reason: string, fields: Record<string, unknown> = {}): SkippedOutcome {
    logger.warn("traffic_skipped", { direction, reason, ...fields });
    return { kind: "skipped", direction, reason };
  }

  /** The fee terms of the dapp's default tip, at the configured share, for the wallet as recipient. */
  function termsFor(destination: TrafficSide, router: Address, destinationToken: Address): Hex {
    const director: FeeDirector = { ...defaultTip(wallet), multiplier: input.tipRate };
    return encodeFeeDirector(director, {
      router,
      protectedAddresses: input.protectedAddresses,
      destinationToken,
      destinationWrappedNative: destination.contracts.wrappedNative,
    });
  }

  async function attempt(request: AttemptInput): Promise<TrafficOutcome> {
    const { direction } = request;
    const { source, destination } = sidesOf(sides, direction);
    const router = destination.contracts.deliveryRouter;
    if (router === null) return skip(direction, "no-delivery-router", { chain: destination.name });

    const pick = pickTransfer(await candidatesOf(source, destination), input.random);
    if (pick.kind === "skip") return skip(direction, pick.reason, { candidates: pick.candidates });
    const { candidate, amount } = pick;
    // A JSON field named `token` is redacted by the shared redactor (it reads as a credential), so the address goes as `tokenAddress`.
    const described = { symbol: candidate.kind === "copy" ? bridgedSymbolOf(candidate.symbol) : candidate.symbol, kind: candidate.kind, tokenAddress: candidate.sourceToken, amount, amountText: formatUnits(amount, candidate.decimals) };

    let native = await source.reader.nativeBalance(wallet);
    let announced = false;
    const announce = async (): Promise<void> => {
      if (announced) return;
      announced = true;
      await request.beforeFirstSend();
    };

    if ((await source.reader.allowance(candidate.sourceToken, wallet, source.contracts.mediator)) < amount) {
      const data = approvalData(source.contracts.mediator);
      const simulation = await source.port.simulate({ to: candidate.sourceToken, data });
      if (!simulation.ok) return skip(direction, "approval-simulation-reverted", { ...described, detail: simulation.reason });
      const terms = sendTerms(await source.port.feeQuote(), simulation.gas);
      const worst = worstCaseCostWei(terms);
      if (native < worst + source.minimumNativeWei) {
        return skip(direction, "native-below-reserve", { ...described, step: "approval", nativeWei: native, worstCaseWei: worst, reserveWei: source.minimumNativeWei });
      }
      await announce();
      const receipt = await source.port.send({ to: candidate.sourceToken, data, ...terms });
      if (!receipt.success) return skip(direction, "approval-reverted", { ...described, transactionHash: receipt.hash });
      logger.info("traffic_approved", { direction, ...described, transactionHash: receipt.hash });
      native -= receipt.gasUsed * receipt.effectiveGasPrice;
    }

    // The gate of the source chain: the first send of an epoch confirms it first (see "Gate evidence: confirm, then send"
    // in docs/hardened-build-contract.md). A gate that does not enforce, or a confirmed epoch, needs nothing.
    if (source.gate !== null) {
      const confirmed = await confirmGate(source, direction, described, native, announce);
      if (confirmed.kind === "skipped") return confirmed;
      native -= confirmed.spentWei;
    }

    // The first send of a native token deploys its copy on the destination. The send needs no gas number for that: the
    // executor of the delivery brings the gas. A send whose copy has no code yet deploys it. With `deployMessage` (no copy came home yet) the runner cannot price
    // the send: the indexer names no destination token for a deploy message. Both are logged, so the operator delivers it
    // by hand; the plan sends such a token only once.
    const deploysCopy = candidate.kind === "native" && !(await destination.reader.hasCode(candidate.destinationToken));
    const deployMessage = candidate.kind === "native" && !candidate.homeRecord.acknowledged;
    // The terms have no follow-up call, so the callback gas is the base that the router needs for its own work.
    const callbackGas = routerCallbackGas({});
    const data = relayData({ token: candidate.sourceToken, router, amount, terms: termsFor(destination, router, candidate.destinationToken), callbackGas });
    const simulation = await source.port.simulate({ to: source.contracts.mediator, data });
    if (!simulation.ok) {
      const refused = relayRefusalOf(simulation.reason);
      return skip(direction, refused.refusal, { ...described, error: refused.error, detail: simulation.reason });
    }
    const terms = sendTerms(await source.port.feeQuote(), simulation.gas);
    const worst = worstCaseCostWei(terms);
    if (native < worst + source.minimumNativeWei) {
      return skip(direction, "native-below-reserve", { ...described, step: "relay", nativeWei: native, worstCaseWei: worst, reserveWei: source.minimumNativeWei });
    }
    await announce();
    const receipt = await source.port.send({ to: source.contracts.mediator, data, ...terms });
    if (!receipt.success) return skip(direction, "relay-reverted", { ...described, transactionHash: receipt.hash });
    const messageId = messageIdOf(receipt.logs, source.contracts.bridge);
    logger.info("traffic_sent", {
      direction,
      ...described,
      transactionHash: receipt.hash,
      messageId,
      deploysCopy,
      deployMessage,
      callbackGas,
      gasUsed: receipt.gasUsed,
      gasCostWei: receipt.gasUsed * receipt.effectiveGasPrice,
      priority: pick.priority,
    });
    return { kind: "sent", direction, symbol: described.symbol, token: candidate.sourceToken, amount, transactionHash: receipt.hash, messageId };
  }

  /** Confirms the gate of the source when the epoch needs it: the confirmation goes as its own transaction, before the send. */
  async function confirmGate(
    source: TrafficSide,
    direction: ProofDirection,
    described: Record<string, unknown>,
    native: bigint,
    announce: () => Promise<void>,
  ): Promise<{ readonly kind: "ready"; readonly spentWei: bigint } | SkippedOutcome> {
    const gate = source.gate as TrafficGate;
    let confirmation: GateConfirmation;
    for (let waited = 0; ; waited += 1) {
      try {
        confirmation = await gate.ensure(wallet);
      } catch (error) {
        const code = error instanceof GateEvidenceError ? error.code : null;
        return skip(direction, "gate-evidence-failed", { ...described, chain: source.name, code, detail: (error as Error).message });
      }
      if (confirmation.kind !== "wait" || waited >= GATE_WAITS) break;
      await sleep(confirmation.retryAfterSeconds * 1000);
    }
    if (confirmation.kind === "not-needed") return { kind: "ready", spentWei: 0n };
    const skipped = (reason: string, fields: Record<string, unknown>) => skip(direction, reason, { ...described, chain: source.name, ...fields });
    if (confirmation.kind === "sealed") return skipped("gate-sealed", { epoch: confirmation.epoch });
    if (confirmation.kind === "wait") return skipped("gate-epoch-has-no-header", { epoch: confirmation.epoch, headerEpoch: confirmation.headerEpoch });
    const terms = sendTerms(await source.port.feeQuote(), confirmation.gas);
    const worst = worstCaseCostWei(terms);
    if (native < worst + source.minimumNativeWei) {
      return skipped("native-below-reserve", { step: "gate-confirm", nativeWei: native, worstCaseWei: worst, reserveWei: source.minimumNativeWei });
    }
    await announce();
    const receipt = await source.port.send({ ...confirmation.call, ...terms });
    if (!receipt.success) return skipped("gate-confirm-reverted", { epoch: confirmation.epoch, transactionHash: receipt.hash });
    logger.info("gate_confirmed", {
      direction,
      chain: source.name,
      gate: confirmation.call.to,
      epoch: confirmation.epoch,
      forkVersion: confirmation.forkVersion,
      transactionHash: receipt.hash,
      gasUsed: receipt.gasUsed,
      gasCostWei: receipt.gasUsed * receipt.effectiveGasPrice,
      validUntil: new Date(Number(confirmation.validUntil) * 1000).toISOString(),
    });
    return { kind: "ready", spentWei: receipt.gasUsed * receipt.effectiveGasPrice };
  }

  async function describeTokens() {
    const listed = [];
    for (const token of input.tokens) {
      if (!input.bounds.has(token.symbol)) continue;
      const [home, other] = token.chainId === sides[0].chainId ? [sides[0], sides[1]] : [sides[1], sides[0]];
      if (home.chainId !== token.chainId) continue;
      const copyAddress = await other.reader.copyAddress({ tokenFactory: other.contracts.tokenFactory, homeChainId: home.chainId, nativeToken: token.address });
      listed.push({ symbol: token.symbol, chainId: token.chainId, address: token.address, copyChainId: other.chainId, copyAddress });
    }
    return listed;
  }

  return { attempt, describeTokens };
}
