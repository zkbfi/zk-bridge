/**
 * The reads behind the fork evidence of the deposit gate, and the one call that a sender needs before a send.
 *
 * On a chain whose `BeaconForkGate` enforces (Sepolia, Ethereum), a send in an epoch that nobody confirmed reverts with
 * `ForkNotConfirmed(epoch)`. The first sender of an epoch calls `confirm(evidence)` first; later senders just send. The
 * bridge calls the gate on a send only, never on a delivery. These functions build that evidence and the call:
 *
 * 1. {@link readGateStatus} reads the gate and the latest block, and says whether the epoch of the next block needs a
 *    confirmation.
 * 2. {@link buildGateEvidence} takes the parent beacon block root of the evidence block (two blocks behind the latest) (the root that EIP-4788 stores
 *    under the block's time), reads that header and a compact multiproof of its state from a beacon node, and builds the
 *    evidence. It checks the evidence with the contract's own rules (`checkConfirmEvidence` of `@zkb/core`) against the
 *    root that the beacon roots contract returns on chain, so a beacon node that lies cannot pass.
 * 3. {@link ensureGateConfirmed} does both, simulates the confirmation from the sender, and returns the call to send
 *    first, or says that none is needed. This is for a send straight to the token mediator (an ERC-20 relay).
 * 4. {@link ensureSendEvidence} is for a send through the delivery router, whose send entry points take `gateEvidence`
 *    and hand non-empty evidence to the gate before they send (decision D1): it returns the evidence to put in the send,
 *    or says that the send carries none. One transaction, no confirmation step.
 *
 * Browser and Node: `fetch` is the global one unless the caller passes its own, and the chain client is the caller's.
 * Messages never hold a URL, so a key in an endpoint never reaches a log.
 */
import { z } from "zod";
import { numberToHex, padHex, type Address, type Hex, type PublicClient } from "viem";
import {
  beaconHeaderRoot,
  checkConfirmEvidence,
  compactMultiproofDescriptor,
  confirmCalldata,
  encodeForkEvidence,
  forkEvidenceFromMultiproof,
  forkProofGindices,
  gateEpochAt,
  gateEpochEnd,
  normalizeAddress,
  PROGRESSIVE_SHAPE,
  type BeaconBlockHeader,
  type ForkCutoverVerdict,
  type ForkEvidence,
} from "@zkb/core";
import { beaconForkGateAbi } from "./abis/index.js";

/** Why the gate evidence could not be built or would not pass. */
export type GateEvidenceErrorCode =
  | "no-parent-beacon-root"
  | "beacon-root-mismatch"
  | "header-root-mismatch"
  | "header-ahead"
  | "beacon-request-failed"
  | "no-proof"
  | "evidence-refused"
  | "simulation-reverted";

/** An error of the gate evidence. `code` names the case; the message holds no URL. */
export class GateEvidenceError extends Error {
  readonly code: GateEvidenceErrorCode;

  constructor(code: GateEvidenceErrorCode, message: string) {
    super(message);
    this.name = "GateEvidenceError";
    this.code = code;
  }
}

/** The calls that the gate functions make on the chain. A viem `PublicClient` has them all. */
export type GateChainClient = Pick<PublicClient, "getBlock" | "readContract" | "call" | "estimateGas">;

/** The modes of a gate, by the index of `BeaconForkGate.GateMode`. */
export const GATE_MODES = ["enforcing", "detect-beacon-roots", "detect-beacon-roots-and-registry"] as const;

/** One of {@link GATE_MODES}. */
export type GateMode = (typeof GATE_MODES)[number];

/**
 * How many blocks behind the latest one the evidence block is. The evidence names the parent beacon block root of one
 * block, and the simulation must run on a node that has that block. Reading the latest block from one backend of a load
 * balancer and simulating on another one block behind makes the root unavailable (`BeaconRootUnavailable`). Two blocks
 * back, every backend that is at most two blocks behind has it. The cost: the header is older, so right after an epoch
 * starts the answer is `wait` for two more slots.
 */
export const EVIDENCE_BLOCK_LAG = 2n;

/** The block whose parent beacon block root the evidence proves. */
export interface EvidenceBlock {
  readonly number: bigint;
  readonly timestamp: bigint;
  readonly parentBeaconBlockRoot: Hex | null;
}

/** What a sender needs to know of a gate. The gate reads name `block`; the evidence names `evidenceBlock`. */
export interface GateStatus {
  readonly gate: Address;
  readonly mode: GateMode;
  /** Whether the gate applies its rules. A gate in a detection mode that has not detected admits every send. */
  readonly enforcing: boolean;
  readonly sealed: boolean;
  /** The last epoch that a proof confirmed, or null when none was. */
  readonly confirmedEpoch: bigint | null;
  readonly genesisTime: bigint;
  readonly secondsPerSlot: bigint;
  readonly slotsPerEpoch: bigint;
  readonly genesisValidatorsRoot: Hex;
  readonly beaconRoots: Address;
  /** The latest block, whose state every read names. */
  readonly block: EvidenceBlock;
  /** The block that the evidence and its simulation are pinned to: {@link EVIDENCE_BLOCK_LAG} blocks before `block` (or `block` on a young chain). */
  readonly evidenceBlock: EvidenceBlock;
  /** The epoch of the next block (one slot after the latest): the epoch that a send now lands in. */
  readonly epoch: bigint;
  /** Whether a send in `epoch` needs a confirmation first: the gate enforces, is not sealed, and has not confirmed `epoch`. */
  readonly needsConfirmation: boolean;
}

/**
 * Reads a gate at the latest block.
 *
 * @param input.client A client of the chain of the gate.
 * @param input.gate The `BeaconForkGate` address.
 */
export async function readGateStatus(input: { readonly client: GateChainClient; readonly gate: Address }): Promise<GateStatus> {
  const { client } = input;
  const gate = normalizeAddress(input.gate);
  const block = await client.getBlock({ blockTag: "latest" });
  const blockNumber = block.number as bigint;
  const evidenceNumber = blockNumber >= EVIDENCE_BLOCK_LAG ? blockNumber - EVIDENCE_BLOCK_LAG : blockNumber;
  const evidence = evidenceNumber === blockNumber ? block : await client.getBlock({ blockNumber: evidenceNumber });
  const read = (functionName: string): Promise<unknown> => client.readContract({ address: gate, abi: beaconForkGateAbi, functionName, blockNumber } as never);
  const [mode, enforcing, sealed, confirmed, genesisTime, secondsPerSlot, slotsPerEpoch, genesisValidatorsRoot, beaconRoots] = await Promise.all(
    ["mode", "enforcing", "isSealed", "confirmedEpoch", "genesisTime", "secondsPerSlot", "slotsPerEpoch", "genesisValidatorsRoot", "beaconRoots"].map(read),
  );
  const [confirmedValue, exists] = confirmed as readonly [bigint, boolean];
  const clock = { genesisTime: BigInt(genesisTime as bigint), secondsPerSlot: BigInt(secondsPerSlot as bigint), slotsPerEpoch: BigInt(slotsPerEpoch as bigint) };
  const epoch = gateEpochAt(block.timestamp + clock.secondsPerSlot, clock);
  const confirmedEpoch = exists ? BigInt(confirmedValue) : null;
  const modeName = GATE_MODES[Number(mode)];
  if (modeName === undefined) throw new Error(`the gate reports an unknown mode ${String(mode)}`);
  return {
    gate,
    mode: modeName,
    enforcing: enforcing as boolean,
    sealed: sealed as boolean,
    confirmedEpoch,
    ...clock,
    genesisValidatorsRoot: genesisValidatorsRoot as Hex,
    beaconRoots: normalizeAddress(beaconRoots as string),
    block: { number: blockNumber, timestamp: block.timestamp, parentBeaconBlockRoot: block.parentBeaconBlockRoot ?? null },
    evidenceBlock: { number: evidenceNumber, timestamp: evidence.timestamp, parentBeaconBlockRoot: evidence.parentBeaconBlockRoot ?? null },
    epoch,
    needsConfirmation: (enforcing as boolean) && !(sealed as boolean) && confirmedEpoch !== epoch,
  };
}

// ------------------------------------------------------------------ the beacon node

/** What the evidence builder reads from a beacon node. The proofs are checked, so the node need not be trusted. */
export interface BeaconProofSource {
  /** The header of a block, by its root. */
  header(blockRoot: Hex): Promise<BeaconBlockHeader>;
  /**
   * A compact multiproof of a state.
   *
   * @param stateId A state root or a slot.
   * @param descriptor The descriptor of the leaves (`compactMultiproofDescriptor`).
   */
  stateProof(stateId: string, descriptor: Hex): Promise<{ readonly leaves: readonly Hex[] }>;
}

const root32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/) as unknown as z.ZodType<Hex>;
const decimal = z.string().regex(/^[0-9]+$/).transform((text) => BigInt(text));

const headerResponseSchema = z.object({
  data: z.object({
    header: z.object({
      message: z.object({ slot: decimal, proposer_index: decimal, parent_root: root32, state_root: root32, body_root: root32 }),
    }),
  }),
});

const proofResponseSchema = z.object({ data: z.object({ leaves: z.array(root32).min(1) }) });

/** The longest that one beacon request waits, in milliseconds. */
const BEACON_TIMEOUT_MILLISECONDS = 20_000;

/**
 * A beacon node over HTTP. The state proofs use the compact multiproof endpoint of Lodestar
 * (`/eth/v0/beacon/proof/state/{state_id}?format=<descriptor>`); the public Lodestar nodes serve it. A node without it
 * fails with `beacon-request-failed`.
 *
 * @param input.url The base URL of the beacon API. It may hold a key: no message repeats it.
 * @param input.fetch The `fetch` to use. Default: the global one.
 */
export function createBeaconProofSource(input: { readonly url: string; readonly fetch?: typeof fetch; readonly timeoutMilliseconds?: number }): BeaconProofSource {
  const base = input.url.replace(/\/+$/, "");
  const doFetch = input.fetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
  const timeout = input.timeoutMilliseconds ?? BEACON_TIMEOUT_MILLISECONDS;
  const getJson = async (path: string, what: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      throw new GateEvidenceError("beacon-request-failed", `the beacon node did not answer for ${what}: ${(error as Error).name}`);
    }
    if (!response.ok) throw new GateEvidenceError("beacon-request-failed", `the beacon node answered ${response.status} for ${what}`);
    return response.json();
  };
  return {
    async header(blockRoot) {
      const parsed = headerResponseSchema.safeParse(await getJson(`/eth/v1/beacon/headers/${blockRoot}`, `the header ${blockRoot}`));
      if (!parsed.success) throw new GateEvidenceError("beacon-request-failed", `the beacon node sent a header of another form for ${blockRoot}`);
      const message = parsed.data.data.header.message;
      return { slot: message.slot, proposerIndex: message.proposer_index, parentRoot: message.parent_root, stateRoot: message.state_root, bodyRoot: message.body_root };
    },
    async stateProof(stateId, descriptor) {
      const parsed = proofResponseSchema.safeParse(await getJson(`/eth/v0/beacon/proof/state/${stateId}?format=${descriptor}`, `a proof of the state ${stateId}`));
      if (!parsed.success) throw new GateEvidenceError("beacon-request-failed", `the beacon node sent a proof of another form for the state ${stateId}`);
      return { leaves: parsed.data.data.leaves };
    },
  };
}

/** The message of {@link fallbackBeaconSource} when it has no endpoint. */
export const NO_BEACON_ENDPOINT_TEXT = "no beacon endpoint is set for this chain";

/**
 * A beacon source over several endpoints, tried in order. A request that one endpoint fails goes to the next. When every
 * endpoint fails, the error says how many were tried and the last reason. Messages hold no URL.
 *
 * @param sources The endpoints' sources, in order.
 * @param options.noneText The message when `sources` is empty, so a program can name where its endpoints are set.
 * Default: {@link NO_BEACON_ENDPOINT_TEXT}.
 */
export function fallbackBeaconSource(sources: readonly BeaconProofSource[], options: { readonly noneText?: string } = {}): BeaconProofSource {
  const first = async <T>(ask: (source: BeaconProofSource) => Promise<T>): Promise<T> => {
    if (sources.length === 0) throw new GateEvidenceError("beacon-request-failed", options.noneText ?? NO_BEACON_ENDPOINT_TEXT);
    let last: unknown = null;
    for (const source of sources) {
      try {
        return await ask(source);
      } catch (error) {
        last = error;
      }
    }
    const reason = last instanceof Error ? last.message : String(last);
    throw new GateEvidenceError("beacon-request-failed", `no beacon endpoint answered (${sources.length} tried; last: ${reason})`);
  };
  return {
    header: (blockRoot) => first((source) => source.header(blockRoot)),
    stateProof: (stateId, descriptor) => first((source) => source.stateProof(stateId, descriptor)),
  };
}

// ------------------------------------------------------------------ the evidence

/** The shapes in the order the builder asks for them: the progressive state first (Gloas), then the plain depths. */
export const SHAPE_REQUEST_ORDER: readonly number[] = [PROGRESSIVE_SHAPE, 6, 5, 7];

/** Evidence that is ready to send, checked with the contract's rules. */
export interface ReadyGateEvidence {
  readonly kind: "ready";
  /** The gate. */
  readonly to: Address;
  /** The calldata of `confirm(evidence)`. */
  readonly data: Hex;
  /** The epoch that the confirmation confirms. It must land in a block of this epoch. */
  readonly epoch: bigint;
  /** `fork.current_version` of the state, 4 bytes. */
  readonly forkVersion: Hex;
  /** The shape that the evidence proves (a plain depth, or 255 for the progressive state). */
  readonly shape: number;
  /** The time key of the beacon roots contract, and the root it holds there: the root of `header`. */
  readonly timestamp: bigint;
  readonly beaconRoot: Hex;
  readonly header: BeaconBlockHeader;
  /** The first second of the next epoch: a confirmation in a block at or after this time reverts `HeaderNotInCurrentEpoch`. */
  readonly validUntil: bigint;
  readonly evidence: ForkEvidence;
  /** `abi.encode(evidence)`. */
  readonly encoded: Hex;
}

/** No header of the epoch is on chain yet (the first slot of an epoch, or missed slots): try again after a slot. */
export interface WaitForGateHeader {
  readonly kind: "wait";
  readonly epoch: bigint;
  /** The epoch of the newest header that the beacon roots contract holds. */
  readonly headerEpoch: bigint;
  readonly retryAfterSeconds: number;
}

/**
 * The beacon header that the evidence block of a gate status proves: the root that the beacon roots contract holds for the
 * block's time, checked against the block's own parent beacon block root, and the header of that root from the beacon node
 * (checked to hash to it).
 *
 * @throws GateEvidenceError when the chain has no EIP-4788, the roots disagree, or the node sends another header.
 */
export async function readEvidenceHeader(input: { readonly client: GateChainClient; readonly beacon: BeaconProofSource; readonly status: GateStatus }): Promise<{
  readonly block: EvidenceBlock;
  readonly beaconRoot: Hex;
  readonly header: BeaconBlockHeader;
}> {
  const { status } = input;
  const block = status.evidenceBlock;
  if (block.parentBeaconBlockRoot === null) throw new GateEvidenceError("no-parent-beacon-root", `block ${block.number} names no parent beacon block root: the chain has no EIP-4788`);
  // What the gate will read: the beacon roots contract, keyed by the time of the block.
  const answer = await input.client.call({ to: status.beaconRoots, data: padHex(numberToHex(block.timestamp), { size: 32 }), blockNumber: block.number });
  const beaconRoot = answer.data ?? "0x";
  if (beaconRoot.toLowerCase() !== block.parentBeaconBlockRoot.toLowerCase()) {
    throw new GateEvidenceError("beacon-root-mismatch", `the beacon roots contract holds ${beaconRoot} for the time ${block.timestamp}, the block names ${block.parentBeaconBlockRoot}`);
  }
  const header = await input.beacon.header(beaconRoot);
  if (beaconHeaderRoot(header) !== beaconRoot.toLowerCase()) throw new GateEvidenceError("header-root-mismatch", `the beacon node sent a header that does not hash to ${beaconRoot}`);
  return { block, beaconRoot, header };
}

/**
 * Builds the evidence that confirms the epoch of the next block.
 *
 * @param input.client A client of the chain of the gate.
 * @param input.gate The gate.
 * @param input.beacon The beacon node of that chain.
 * @param input.status A status read just before, to save the reads. Default: a new read.
 * @throws GateEvidenceError when the chain or the beacon node gives no evidence that the contract would accept.
 */
export async function buildGateEvidence(input: {
  readonly client: GateChainClient;
  readonly gate: Address;
  readonly beacon: BeaconProofSource;
  readonly status?: GateStatus;
}): Promise<ReadyGateEvidence | WaitForGateHeader> {
  const status = input.status ?? (await readGateStatus(input));
  const { block, beaconRoot, header } = await readEvidenceHeader({ client: input.client, beacon: input.beacon, status });
  const headerEpoch = header.slot / status.slotsPerEpoch;
  if (headerEpoch < status.epoch) return { kind: "wait", epoch: status.epoch, headerEpoch, retryAfterSeconds: Number(status.secondsPerSlot) };
  if (headerEpoch > status.epoch) throw new GateEvidenceError("header-ahead", `the header of slot ${header.slot} is in epoch ${headerEpoch}, after the epoch ${status.epoch} of the next block`);

  const failures: string[] = [];
  for (const shape of SHAPE_REQUEST_ORDER) {
    const descriptor = compactMultiproofDescriptor(forkProofGindices(shape));
    let evidence: ForkEvidence;
    try {
      const { leaves } = await input.beacon.stateProof(header.stateRoot, descriptor);
      evidence = forkEvidenceFromMultiproof({ timestamp: block.timestamp, header, shape, descriptor, leaves });
    } catch (error) {
      failures.push(`shape ${shape}: ${(error as Error).message}`);
      continue;
    }
    const check = checkConfirmEvidence({ evidence, beaconRoot, epoch: status.epoch, slotsPerEpoch: status.slotsPerEpoch, genesisValidatorsRoot: status.genesisValidatorsRoot });
    if (!check.ok) {
      failures.push(`shape ${shape}: the gate would refuse it with ${check.error} (${check.detail})`);
      continue;
    }
    return {
      kind: "ready",
      to: status.gate,
      data: confirmCalldata(evidence),
      epoch: status.epoch,
      forkVersion: evidence.version,
      shape: check.shape,
      timestamp: block.timestamp,
      beaconRoot,
      header,
      validUntil: gateEpochEnd(status.epoch, status),
      evidence,
      encoded: encodeForkEvidence(evidence),
    };
  }
  const refused = failures.some((failure) => failure.includes("would refuse"));
  throw new GateEvidenceError(refused ? "evidence-refused" : "no-proof", `no evidence for the state ${header.stateRoot}: ${failures.join("; ")}`);
}

/**
 * A revert for a log: the short message of a viem error (which holds no URL, unlike its full message) and the revert data
 * found along its causes, as `revert data 0x...`.
 */
export function describeRevert(error: unknown): string {
  const { text: found, data } = walkRevert(error);
  let text = found;
  if (text === "") text = error instanceof Error ? error.name : "an error";
  return `${text.split("\n")[0]!.slice(0, 200)}${data === null ? "" : ` (revert data ${data.slice(0, 10)})`}`;
}

/** The first short message and the first revert data along the causes of an error. */
function walkRevert(error: unknown): { readonly text: string; readonly data: string | null } {
  let text = "";
  let data: string | null = null;
  for (let cause = error as { shortMessage?: unknown; name?: unknown; data?: unknown; cause?: unknown } | undefined, depth = 0; cause !== undefined && cause !== null && depth < 8; cause = cause.cause as typeof cause, depth += 1) {
    if (text === "" && typeof cause.shortMessage === "string") text = cause.shortMessage;
    if (data === null && typeof cause.data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(cause.data)) data = cause.data;
  }
  return { text, data };
}

/** The selector of `BeaconRootUnavailable(uint256)`: the beacon roots contract has no root for the evidence's time on the node that simulated. */
export const BEACON_ROOT_UNAVAILABLE_SELECTOR = "0xbad725f7";

/** How long {@link ensureGateConfirmed} waits before it simulates again after `BeaconRootUnavailable`, in milliseconds. */
export const SIMULATION_RETRY_MILLISECONDS = 2_000;

/** The answer of {@link ensureGateConfirmed}. */
export type GateConfirmation =
  /** The send needs no confirmation: the gate does not enforce, or the epoch is confirmed already. */
  | { readonly kind: "not-needed"; readonly reason: "not-enforcing" | "confirmed"; readonly epoch: bigint }
  /** The gate is sealed for good: no send passes, with or without evidence. */
  | { readonly kind: "sealed"; readonly epoch: bigint }
  | WaitForGateHeader
  /** Send `call` first, from the same sender, in a block before `validUntil`; then send. */
  | {
      readonly kind: "confirm";
      readonly call: { readonly to: Address; readonly data: Hex };
      /** The gas of the simulation from the sender. */
      readonly gas: bigint;
      readonly epoch: bigint;
      readonly forkVersion: Hex;
      readonly shape: number;
      readonly validUntil: bigint;
      readonly evidence: ReadyGateEvidence;
    };

/**
 * The least time that must remain in an epoch for a confirmation to go ahead in it: three blocks to send and mine it, the
 * confirmation's expected inclusion time and a margin for the send that follows. A confirmation that is mined in the next
 * epoch confirms nothing for the send, which then reverts with `ForkNotConfirmed`. Seconds (12 s blocks on Sepolia and Ethereum).
 */
export const GATE_SAFETY_SECONDS = 60;

/** The block time that the wait for the next epoch adds, so the first block of the new epoch (and its beacon root) is on chain. */
export const GATE_BLOCK_SECONDS = 12;

/**
 * Whether a confirmation has time left in its epoch.
 *
 * @param validUntil The `validUntil` of the confirmation: the end of the epoch of the next block, unix seconds.
 * @param nowMilliseconds The clock now.
 * @returns `secondsLeft` in the epoch (negative when it has ended), `late` when less than {@link GATE_SAFETY_SECONDS}
 * remain, and `waitSeconds` until the next epoch has started and has a block (zero when not late).
 */
export function gateConfirmWindow(validUntil: bigint, nowMilliseconds: number): { readonly secondsLeft: number; readonly late: boolean; readonly waitSeconds: number } {
  const secondsLeft = Math.floor(Number(validUntil) - nowMilliseconds / 1000);
  const late = secondsLeft < GATE_SAFETY_SECONDS;
  return { secondsLeft, late, waitSeconds: late ? Math.max(secondsLeft, 0) + GATE_BLOCK_SECONDS : 0 };
}

/**
 * What a sender must do on a gate before a send in the epoch of the next block. It reads the gate; when the epoch needs a
 * confirmation it builds the evidence, checks it natively and simulates `confirm` from the sender. It sends nothing.
 *
 * Send the returned call as its own transaction, then the send. A Multicall3 bundle is not offered: inside it the send's
 * `msg.sender` is the multicall contract, and the token mediator pulls the tokens from `msg.sender`. A wallet batch that
 * keeps the sender (EIP-5792 `wallet_sendCalls` on an account with code) can take `[call, send]` together.
 *
 * @param input.account The sender. The simulation runs from it.
 * @throws GateEvidenceError when no evidence can be built, or `simulation-reverted` when the confirmation would revert.
 */
export async function ensureGateConfirmed(input: {
  readonly client: GateChainClient;
  readonly gate: Address;
  readonly beacon: BeaconProofSource;
  readonly account: Address;
  /** Waits between the two simulations. Default: a timer. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): Promise<GateConfirmation> {
  const status = await readGateStatus(input);
  if (status.sealed) return { kind: "sealed", epoch: status.epoch };
  if (!status.enforcing) return { kind: "not-needed", reason: "not-enforcing", epoch: status.epoch };
  if (!status.needsConfirmation) return { kind: "not-needed", reason: "confirmed", epoch: status.epoch };
  const evidence = await buildGateEvidence({ ...input, status });
  if (evidence.kind === "wait") return evidence;
  const call = { to: evidence.to, data: evidence.data };
  // Pinned to the evidence block, whose state holds the root of its time. A node that serves "latest" one block behind
  // would miss it. If this node still lacks the root, it is catching up: wait a moment and ask once more.
  const simulate = (): Promise<bigint> => input.client.estimateGas({ account: input.account, ...call, blockNumber: status.evidenceBlock.number });
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let gas: bigint;
  try {
    try {
      gas = await simulate();
    } catch (error) {
      if (walkRevert(error).data?.slice(0, 10).toLowerCase() !== BEACON_ROOT_UNAVAILABLE_SELECTOR) throw error;
      await sleep(SIMULATION_RETRY_MILLISECONDS);
      gas = await simulate();
    }
  } catch (error) {
    throw new GateEvidenceError("simulation-reverted", `confirm would revert (simulated at block ${status.evidenceBlock.number}): ${describeRevert(error)}`);
  }
  return { kind: "confirm", call, gas, epoch: evidence.epoch, forkVersion: evidence.forkVersion, shape: evidence.shape, validUntil: evidence.validUntil, evidence };
}

/**
 * What a send through the delivery router carries for the gate. The router's `wrapAndRelayTokens(receiver, gateEvidence)`
 * and `relayTokensAndCall(receiver, data, callbackGas, gateEvidence)` give non-empty evidence to the gate (`admit`) before
 * they send: in a confirmed epoch the gate ignores it, otherwise it confirms the epoch with it. Empty evidence costs
 * nothing and passes only in a confirmed epoch.
 */
export type SendEvidence =
  /** Send with empty evidence: the gate does not enforce, or the epoch is confirmed with time to spare. */
  | { readonly kind: "not-needed"; readonly reason: "not-enforcing" | "confirmed"; readonly epoch: bigint }
  /** The gate is sealed for good: no send passes, with or without evidence. */
  | { readonly kind: "sealed"; readonly epoch: bigint }
  /** No header of the epoch is on chain yet: ask again after `retryAfterSeconds`. */
  | WaitForGateHeader
  /**
   * Less than {@link GATE_SAFETY_SECONDS} are left in the epoch: a send signed now may land in the next epoch, where
   * neither empty evidence nor evidence of this epoch passes. Wait `waitSeconds` (the end of the epoch and one block),
   * then ask again: the evidence of the next epoch can be built then.
   */
  | { readonly kind: "late"; readonly epoch: bigint; readonly secondsLeft: number; readonly waitSeconds: number }
  /** Put `gateEvidence` in the send. It must land in a block before `validUntil`. */
  | {
      readonly kind: "evidence";
      /** `abi.encode(ForkEvidence)`: the `gateEvidence` argument of the router's send. */
      readonly gateEvidence: Hex;
      readonly epoch: bigint;
      readonly forkVersion: Hex;
      readonly shape: number;
      readonly validUntil: bigint;
      readonly evidence: ReadyGateEvidence;
    };

/** What {@link sendEvidenceRule} decides from a gate status and the clock, before any evidence is built. */
export type SendEvidenceRule =
  | { readonly kind: "sealed" }
  | { readonly kind: "empty"; readonly reason: "not-enforcing" | "confirmed" }
  | { readonly kind: "late"; readonly secondsLeft: number; readonly waitSeconds: number }
  | { readonly kind: "attach" };

/**
 * Whether a send through the router carries evidence, from a gate status and the clock. The one rule of the dapp, the
 * terminal and every other sender (decision D1): evidence when the epoch of the next block is unconfirmed, empty when it
 * is confirmed, and a wait when it ends within {@link GATE_SAFETY_SECONDS}, whether confirmed or not. A send signed in the
 * last seconds of an epoch may land in the next one, where empty evidence reverts with `ForkNotConfirmed` and evidence of
 * the ending epoch reverts with `HeaderNotInCurrentEpoch`; the evidence that does pass there is that of the next epoch,
 * which exists once its first block is on chain.
 *
 * @param status The gate, read just before.
 * @param nowMilliseconds The clock now.
 */
export function sendEvidenceRule(status: GateStatus, nowMilliseconds: number): SendEvidenceRule {
  if (status.sealed) return { kind: "sealed" };
  if (!status.enforcing) return { kind: "empty", reason: "not-enforcing" };
  const window = gateConfirmWindow(gateEpochEnd(status.epoch, status), nowMilliseconds);
  if (window.late) return { kind: "late", secondsLeft: window.secondsLeft, waitSeconds: window.waitSeconds };
  return status.needsConfirmation ? { kind: "attach" } : { kind: "empty", reason: "confirmed" };
}

/**
 * The gate evidence of a send through the delivery router in the epoch of the next block ({@link sendEvidenceRule}). When
 * the send carries evidence it builds it and checks it natively with the contract's rules. It sends and simulates
 * nothing: the estimate of the send itself runs the gate.
 *
 * @param input.now The clock in milliseconds. Default: `Date.now`.
 * @throws GateEvidenceError when no evidence can be built.
 */
export async function ensureSendEvidence(input: {
  readonly client: GateChainClient;
  readonly gate: Address;
  readonly beacon: BeaconProofSource;
  readonly now?: () => number;
}): Promise<SendEvidence> {
  const status = await readGateStatus(input);
  const rule = sendEvidenceRule(status, (input.now ?? Date.now)());
  const epoch = status.epoch;
  switch (rule.kind) {
    case "sealed":
      return { kind: "sealed", epoch };
    case "empty":
      return { kind: "not-needed", reason: rule.reason, epoch };
    case "late":
      return { kind: "late", epoch, secondsLeft: rule.secondsLeft, waitSeconds: rule.waitSeconds };
    case "attach": {
      const evidence = await buildGateEvidence({ ...input, status });
      if (evidence.kind === "wait") return evidence;
      return { kind: "evidence", gateEvidence: evidence.encoded, epoch, forkVersion: evidence.forkVersion, shape: evidence.shape, validUntil: evidence.validUntil, evidence };
    }
  }
}

/** The route is paused before a fork (`decideForkCutover`): nothing is sent, and the gate is not asked. */
export type GatePaused = { readonly kind: "paused"; readonly verdict: Extract<ForkCutoverVerdict, { readonly kind: "paused" }> };

/**
 * What {@link GateCheck} answers: what {@link ensureGateConfirmed} answers (a send straight to the mediator), what
 * {@link ensureSendEvidence} answers (a send through the router), or that the route is paused before a fork.
 */
export type GateCheckAnswer = GateConfirmation | SendEvidence | GatePaused;

/**
 * The question a sender asks before a send on a chain with a gate, after the fork cutover: {@link ensureSendEvidence} when
 * the send carries gate evidence (`carriesEvidence`, a send through the delivery router), else {@link ensureGateConfirmed}
 * for that chain and account.
 */
export type GateCheck = (input: { readonly chainId: number; readonly gate: Address; readonly account: Address; readonly carriesEvidence?: boolean }) => Promise<GateCheckAnswer>;

/**
 * The gate check of a program that sends (the web page, the terminal): {@link ensureSendEvidence} for a send that carries
 * gate evidence, else {@link ensureGateConfirmed}, on the flow client of the chain (so the gate reads, the simulation and
 * the send hit one node), over the beacon endpoints in force at each check,
 * tried in order with {@link fallbackBeaconSource}. It sends nothing.
 *
 * @param input.clientFor The flow client of a chain. It must read contracts, read blocks, call and estimate gas.
 * @param input.beaconUrlsFor The beacon endpoints of a chain in force now, in order. Read at each check, so a change of
 * the settings counts at once.
 * @param input.noneText The message when a chain has no beacon endpoint. Default: {@link NO_BEACON_ENDPOINT_TEXT}.
 * @param input.fetch The `fetch` to use. Default: the global one.
 */
export function createGateCheck(input: {
  readonly clientFor: (chainId: number) => GateChainClient;
  readonly beaconUrlsFor: (chainId: number) => readonly string[];
  readonly noneText?: string;
  readonly fetch?: typeof fetch;
  /**
   * The fork cutover check (`createForkCutoverCheck`). When it says a send from the chain is paused before a fork, the gate
   * check answers `paused` and does not read the gate. Absent: no cutover.
   */
  readonly cutover?: (chainId: number) => Promise<ForkCutoverVerdict>;
  /** The clock in milliseconds, for the time left in an epoch. Default: `Date.now`. */
  readonly now?: () => number;
}): GateCheck {
  return async ({ chainId, gate, account, carriesEvidence }) => {
    if (input.cutover !== undefined) {
      const verdict = await input.cutover(chainId);
      if (verdict.kind === "paused") return { kind: "paused", verdict };
    }
    const sources = input.beaconUrlsFor(chainId).map((url) => createBeaconProofSource({ url, ...(input.fetch === undefined ? {} : { fetch: input.fetch }) }));
    const beacon = fallbackBeaconSource(sources, input.noneText === undefined ? {} : { noneText: input.noneText });
    const client = input.clientFor(chainId);
    if (carriesEvidence === true) return ensureSendEvidence({ client, gate, beacon, ...(input.now === undefined ? {} : { now: input.now }) });
    return ensureGateConfirmed({ client, gate, beacon, account });
  };
}
