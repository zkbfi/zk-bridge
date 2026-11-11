import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { padHex, type Hex } from "viem";
import { PROGRESSIVE_SHAPE } from "@zkb/core";
import { beaconForkGateAbi } from "../src/abis/index.js";
import {
  buildGateEvidence,
  createBeaconProofSource,
  describeRevert,
  ensureGateConfirmed,
  GATE_BLOCK_SECONDS,
  GATE_SAFETY_SECONDS,
  gateConfirmWindow,
  GateEvidenceError,
  isSealOnlyMode,
  readGateStatus,
  SHAPE_REQUEST_ORDER,
  SIMULATION_RETRY_MILLISECONDS,
  type BeaconProofSource,
  type GateChainClient,
  type GateStatus,
} from "../src/index.js";

/** One real Sepolia epoch, recorded read-only by `scripts/capture-gate-fixture.mjs`. */
const fixture = JSON.parse(readFileSync(new URL("../../../test/hardened/fixtures/gate_evidence_sepolia.json", import.meta.url), "utf8")) as {
  gate: Hex;
  account: Hex;
  block: { number: string; timestamp: string; parentBeaconBlockRoot: Hex };
  reads: Record<string, unknown> & { confirmedEpoch: { epoch: string; exists: boolean } };
  beaconRootCall: { to: Hex; data: Hex; blockNumber: string; answer: Hex };
  beaconResponses: { path: string; status: number; body: unknown }[];
  estimatedGas: string;
  expected: { epoch: string; forkVersion: Hex; shape: number; validUntil: string; timestamp: string; beaconRoot: Hex; encoded: Hex; calldata: Hex; header: Record<string, string> };
};

const BEACON = "https://beacon.example/key-abc123/";
const epoch = BigInt(fixture.expected.epoch);
const blockNumber = BigInt(fixture.block.number);

type Overrides = { mode?: number; enforcing?: boolean; sealed?: boolean; confirmed?: readonly [bigint, boolean]; parentBeaconBlockRoot?: Hex | undefined; answer?: Hex | undefined; estimate?: () => Promise<bigint> };

/** A chain client that answers with the recorded reads. */
const clientOf = (overrides: Overrides = {}) => {
  const reads: Record<string, unknown> = {
    mode: overrides.mode ?? fixture.reads.mode,
    enforcing: overrides.enforcing ?? fixture.reads.enforcing,
    isSealed: overrides.sealed ?? fixture.reads.isSealed,
    confirmedEpoch: overrides.confirmed ?? [BigInt(fixture.reads.confirmedEpoch.epoch), fixture.reads.confirmedEpoch.exists],
    genesisTime: BigInt(fixture.reads.genesisTime as string),
    secondsPerSlot: BigInt(fixture.reads.secondsPerSlot as string),
    slotsPerEpoch: BigInt(fixture.reads.slotsPerEpoch as string),
    genesisValidatorsRoot: fixture.reads.genesisValidatorsRoot,
    beaconRoots: fixture.reads.beaconRoots,
  };
  const parent = "parentBeaconBlockRoot" in overrides ? overrides.parentBeaconBlockRoot : fixture.block.parentBeaconBlockRoot;
  const client = {
    // The latest block is two ahead of the recorded one, so the evidence block (latest - 2) is the recorded block.
    getBlock: vi.fn(async (request?: { blockNumber?: bigint }) => ({ number: request?.blockNumber ?? blockNumber + 2n, timestamp: BigInt(fixture.block.timestamp), parentBeaconBlockRoot: parent })),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => reads[functionName]),
    call: vi.fn(async () => ({ data: "answer" in overrides ? overrides.answer : fixture.beaconRootCall.answer })),
    estimateGas: vi.fn(overrides.estimate ?? (async () => BigInt(fixture.estimatedGas))),
  };
  return client;
};
const asClient = (client: ReturnType<typeof clientOf>) => client as unknown as GateChainClient;

/** A `fetch` that answers the recorded paths and 404 for any other. */
const recordedFetch = (change: (path: string, body: unknown) => unknown = (_, body) => body) =>
  vi.fn(async (url: string) => {
    const path = url.slice(BEACON.length - 1);
    const recorded = fixture.beaconResponses.find((response) => response.path === path);
    if (recorded === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(change(path, recorded.body)), { status: 200 });
  });

const beaconOf = (fetchImpl: ReturnType<typeof recordedFetch> = recordedFetch()) => createBeaconProofSource({ url: BEACON, fetch: fetchImpl as unknown as typeof fetch });

const failure = async (promise: Promise<unknown>): Promise<GateEvidenceError> => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(GateEvidenceError);
  return error as GateEvidenceError;
};

afterEach(() => vi.unstubAllGlobals());

describe("readGateStatus", () => {
  it("reads the gate at the latest block and says that the epoch of the next block needs a confirmation", async () => {
    const client = clientOf();
    const status = await readGateStatus({ client: asClient(client), gate: fixture.gate });
    expect(status).toMatchObject({
      gate: fixture.gate,
      mode: "enforcing",
      enforcing: true,
      sealed: false,
      confirmedEpoch: null,
      secondsPerSlot: 12n,
      slotsPerEpoch: 32n,
      beaconRoots: "0x000f3df6d732807ef1319fb7b8bb8522d0beac02",
      block: { number: blockNumber + 2n, parentBeaconBlockRoot: fixture.block.parentBeaconBlockRoot },
      epoch,
      needsConfirmation: true,
    });
    expect(client.readContract).toHaveBeenCalledWith({ address: fixture.gate, abi: beaconForkGateAbi, functionName: "confirmedEpoch", blockNumber: blockNumber + 2n });
  });

  it("needs no confirmation in a confirmed epoch, on a gate that does not enforce, or on a sealed gate", async () => {
    expect((await readGateStatus({ client: asClient(clientOf({ confirmed: [epoch, true] })), gate: fixture.gate })).needsConfirmation).toBe(false);
    expect((await readGateStatus({ client: asClient(clientOf({ confirmed: [epoch - 1n, true] })), gate: fixture.gate })).confirmedEpoch).toBe(epoch - 1n);
    const detecting = await readGateStatus({ client: asClient(clientOf({ mode: 2, enforcing: false })), gate: fixture.gate });
    expect(detecting).toMatchObject({ mode: "detect-beacon-roots-and-registry", needsConfirmation: false });
    expect((await readGateStatus({ client: asClient(clientOf({ sealed: true })), gate: fixture.gate })).needsConfirmation).toBe(false);
  });

  it("names the two seal-only modes, which never need a confirmation: a send is admitted unless the gate is sealed", async () => {
    const sealOnly = await readGateStatus({ client: asClient(clientOf({ mode: 3, enforcing: true, confirmed: [0n, false] })), gate: fixture.gate });
    expect(sealOnly).toMatchObject({ mode: "seal-only", enforcing: true, confirmedEpoch: null, needsConfirmation: false });
    const withRegistry = await readGateStatus({ client: asClient(clientOf({ mode: 4, enforcing: true, confirmed: [0n, false] })), gate: fixture.gate });
    expect(withRegistry).toMatchObject({ mode: "seal-only-with-registry", needsConfirmation: false });
    expect(isSealOnlyMode("seal-only")).toBe(true);
    expect(isSealOnlyMode("seal-only-with-registry")).toBe(true);
    expect(isSealOnlyMode("enforcing")).toBe(false);
    await expect(readGateStatus({ client: asClient(clientOf({ mode: 5 })), gate: fixture.gate })).rejects.toThrow("unknown mode 5");
  });

  it("pins the evidence to the block two behind the latest, and to the latest itself on a young chain", async () => {
    const status = await readGateStatus({ client: asClient(clientOf()), gate: fixture.gate });
    expect(status.block.number).toBe(blockNumber + 2n);
    expect(status.evidenceBlock.number).toBe(blockNumber);
    const young = clientOf();
    young.getBlock.mockResolvedValue({ number: 1n, timestamp: BigInt(fixture.block.timestamp), parentBeaconBlockRoot: fixture.block.parentBeaconBlockRoot });
    expect((await readGateStatus({ client: asClient(young), gate: fixture.gate })).evidenceBlock.number).toBe(1n);
    expect(young.getBlock).toHaveBeenCalledTimes(1);
  });

  it("names a block without a parent beacon root, and refuses an unknown mode", async () => {
    expect((await readGateStatus({ client: asClient(clientOf({ parentBeaconBlockRoot: undefined })), gate: fixture.gate })).block.parentBeaconBlockRoot).toBeNull();
    await expect(readGateStatus({ client: asClient(clientOf({ mode: 7 })), gate: fixture.gate })).rejects.toThrow(/unknown mode 7/);
  });
});

describe("buildGateEvidence", () => {
  it("builds the recorded evidence from the recorded answers, with one proof request", async () => {
    const fetchImpl = recordedFetch();
    const client = clientOf();
    const result = await buildGateEvidence({ client: asClient(client), gate: fixture.gate, beacon: beaconOf(fetchImpl) });
    expect(result).toMatchObject({
      kind: "ready",
      to: fixture.gate,
      data: fixture.expected.calldata,
      encoded: fixture.expected.encoded,
      epoch,
      forkVersion: "0x90000076",
      shape: PROGRESSIVE_SHAPE,
      timestamp: BigInt(fixture.expected.timestamp),
      beaconRoot: fixture.expected.beaconRoot,
      validUntil: BigInt(fixture.expected.validUntil),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(SHAPE_REQUEST_ORDER[0]).toBe(PROGRESSIVE_SHAPE);
    // The gate reads the beacon roots contract with the time of the block, at that block.
    expect(client.call).toHaveBeenCalledWith({ to: "0x000f3df6d732807ef1319fb7b8bb8522d0beac02", data: fixture.beaconRootCall.data, blockNumber });
  });

  it("takes a status that the caller read", async () => {
    const client = clientOf();
    const status = await readGateStatus({ client: asClient(client), gate: fixture.gate });
    client.getBlock.mockClear();
    const result = await buildGateEvidence({ client: asClient(client), gate: fixture.gate, beacon: beaconOf(), status });
    expect(result.kind).toBe("ready");
    expect(client.getBlock).not.toHaveBeenCalled();
  });

  it("waits when the newest header is from the epoch before (the first slot of an epoch)", async () => {
    const status = await readGateStatus({ client: asClient(clientOf()), gate: fixture.gate });
    const later: GateStatus = { ...status, epoch: epoch + 1n };
    expect(await buildGateEvidence({ client: asClient(clientOf()), gate: fixture.gate, beacon: beaconOf(), status: later })).toEqual({ kind: "wait", epoch: epoch + 1n, headerEpoch: epoch, retryAfterSeconds: 12 });
    expect((await failure(buildGateEvidence({ client: asClient(clientOf()), gate: fixture.gate, beacon: beaconOf(), status: { ...status, epoch: epoch - 1n } }))).code).toBe("header-ahead");
  });

  it("refuses a chain without EIP-4788 and a root that the contract does not hold", async () => {
    expect((await failure(buildGateEvidence({ client: asClient(clientOf({ parentBeaconBlockRoot: undefined })), gate: fixture.gate, beacon: beaconOf() }))).code).toBe("no-parent-beacon-root");
    expect((await failure(buildGateEvidence({ client: asClient(clientOf({ answer: padHex("0x1", { size: 32 }) })), gate: fixture.gate, beacon: beaconOf() }))).code).toBe("beacon-root-mismatch");
    expect((await failure(buildGateEvidence({ client: asClient(clientOf({ answer: undefined })), gate: fixture.gate, beacon: beaconOf() }))).code).toBe("beacon-root-mismatch");
  });

  it("refuses a beacon node that lies about the header", async () => {
    const lying = recordedFetch((path, body) => {
      if (!path.startsWith("/eth/v1/beacon/headers/")) return body;
      const copy = structuredClone(body) as { data: { header: { message: { proposer_index: string } } } };
      copy.data.header.message.proposer_index = "1";
      return copy;
    });
    expect((await failure(buildGateEvidence({ client: asClient(clientOf()), gate: fixture.gate, beacon: beaconOf(lying) }))).code).toBe("header-root-mismatch");
  });

  it("tries every shape and names each failure when no proof comes", async () => {
    const beacon: BeaconProofSource = { header: beaconOf().header, stateProof: vi.fn(async () => Promise.reject(new GateEvidenceError("beacon-request-failed", "the beacon node answered 500"))) };
    const error = await failure(buildGateEvidence({ client: asClient(clientOf()), gate: fixture.gate, beacon }));
    expect(error.code).toBe("no-proof");
    expect(beacon.stateProof).toHaveBeenCalledTimes(4);
    expect(error.message).toContain("shape 255: the beacon node answered 500; shape 6");
  });

  it("refuses evidence that the gate would refuse: a gate of another beacon chain", async () => {
    const status = await readGateStatus({ client: asClient(clientOf()), gate: fixture.gate });
    const error = await failure(buildGateEvidence({ client: asClient(clientOf()), gate: fixture.gate, beacon: beaconOf(), status: { ...status, genesisValidatorsRoot: padHex("0x1", { size: 32 }) } }));
    expect(error.code).toBe("evidence-refused");
    expect(error.message).toContain("GenesisValidatorsRootBranchInvalid");
  });
});

describe("the beacon proof source", () => {
  it("fails without the URL in the message when the node does not answer, answers an error, or answers another form", async () => {
    const thrown = createBeaconProofSource({ url: BEACON, fetch: vi.fn(async () => Promise.reject(new TypeError("fetch failed https://beacon.example/key-abc123"))) as unknown as typeof fetch });
    const failed = await failure(thrown.header(fixture.block.parentBeaconBlockRoot));
    expect(failed.message).toBe(`the beacon node did not answer for the header ${fixture.block.parentBeaconBlockRoot}: TypeError`);
    const status = await failure(beaconOf(vi.fn(async () => new Response("{}", { status: 500 }))).stateProof("0x01", "0x231f80"));
    expect(status.message).toBe("the beacon node answered 500 for a proof of the state 0x01");
    const odd = beaconOf(vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })));
    expect((await failure(odd.header(fixture.block.parentBeaconBlockRoot))).message).toContain("a header of another form");
    expect((await failure(odd.stateProof("0x01", "0x231f80"))).message).toContain("a proof of another form");
    for (const error of [failed, status]) expect(error.message).not.toContain("key-abc123");
  });

  it("uses the global fetch by default, with a time limit", async () => {
    const global = recordedFetch();
    vi.stubGlobal("fetch", global);
    const source = createBeaconProofSource({ url: BEACON.replace(/\/$/, ""), timeoutMilliseconds: 5 });
    const header = await source.header(fixture.block.parentBeaconBlockRoot);
    expect(header.slot).toBe(BigInt(fixture.expected.header.slot!));
    expect(global.mock.calls[0]![0]).toBe(`https://beacon.example/key-abc123/eth/v1/beacon/headers/${fixture.block.parentBeaconBlockRoot}`);
    expect((global.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("ensureGateConfirmed", () => {
  const ensure = (client: ReturnType<typeof clientOf>, fetchImpl = recordedFetch()) => ensureGateConfirmed({ client: asClient(client), gate: fixture.gate, beacon: beaconOf(fetchImpl), account: fixture.account });

  it("does nothing on a confirmed epoch, a gate that does not enforce, or a sealed gate", async () => {
    const fetchImpl = recordedFetch();
    expect(await ensure(clientOf({ confirmed: [epoch, true] }), fetchImpl)).toEqual({ kind: "not-needed", reason: "confirmed", epoch });
    expect(await ensure(clientOf({ mode: 1, enforcing: false }), fetchImpl)).toEqual({ kind: "not-needed", reason: "not-enforcing", epoch });
    expect(await ensure(clientOf({ sealed: true }), fetchImpl)).toEqual({ kind: "sealed", epoch });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does nothing on a seal-only gate, and reads no beacon node", async () => {
    const fetchImpl = recordedFetch();
    const client = clientOf({ mode: 3, enforcing: true, confirmed: [0n, false] });
    expect(await ensure(client, fetchImpl)).toEqual({ kind: "not-needed", reason: "seal-only", epoch });
    expect(await ensure(clientOf({ mode: 4, enforcing: true, sealed: true }), fetchImpl)).toEqual({ kind: "sealed", epoch });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.estimateGas).not.toHaveBeenCalled();
  });

  it("returns the confirmation to send first, simulated from the sender", async () => {
    const client = clientOf();
    const result = await ensure(client);
    expect(result).toMatchObject({ kind: "confirm", call: { to: fixture.gate, data: fixture.expected.calldata }, gas: 79_050n, epoch, forkVersion: "0x90000076", shape: 255, validUntil: BigInt(fixture.expected.validUntil) });
    expect(client.estimateGas).toHaveBeenCalledWith({ account: fixture.account, to: fixture.gate, data: fixture.expected.calldata, blockNumber });
  });

  const unavailable = () =>
    Object.assign(new Error("reverted"), { shortMessage: "Execution reverted.", cause: { data: "0xbad725f70000000000000000000000000000000000000000000000000000000069058c58" } });

  it("simulates at the evidence block, not at the latest", async () => {
    const client = clientOf();
    await ensure(client);
    expect(client.getBlock).toHaveBeenCalledWith({ blockNumber });
    expect((client.estimateGas.mock.calls as unknown[][])[0]![0]).toMatchObject({ blockNumber });
    expect(client.call).toHaveBeenCalledWith(expect.objectContaining({ blockNumber }));
  });

  it("passes with a node one block behind the latest, where the old unpinned simulation failed", async () => {
    const head = blockNumber + 1n;
    // A backend that lags: it has the root of a block only if it has the block.
    const estimate = vi.fn(async (request?: unknown) => {
      const at = (request as { blockNumber?: bigint }).blockNumber ?? head;
      return at <= head && at <= blockNumber ? 79_050n : Promise.reject(unavailable());
    });
    expect(await ensure(clientOf({ estimate }))).toMatchObject({ kind: "confirm", gas: 79_050n });
  });

  it("asks again after a moment when a lagging node has no beacon root yet", async () => {
    const estimate = vi.fn().mockRejectedValueOnce(unavailable()).mockResolvedValueOnce(81_000n);
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const result = await ensureGateConfirmed({ client: asClient(clientOf({ estimate })), gate: fixture.gate, beacon: beaconOf(), account: fixture.account, sleep });
    expect(result).toMatchObject({ kind: "confirm", gas: 81_000n });
    expect(estimate).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[SIMULATION_RETRY_MILLISECONDS]]);
  });

  it("gives up after the one retry, and names the block", async () => {
    const estimate = vi.fn(async () => Promise.reject(unavailable()));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const error = await failure(ensureGateConfirmed({ client: asClient(clientOf({ estimate })), gate: fixture.gate, beacon: beaconOf(), account: fixture.account, sleep }));
    expect(error.code).toBe("simulation-reverted");
    expect(error.message).toContain(`simulated at block ${blockNumber}`);
    expect(error.message).toContain("revert data 0xbad725f7");
    expect(estimate).toHaveBeenCalledTimes(2);
  });

  it("does not retry another revert, and waits on a real timer by default", async () => {
    const estimate = vi.fn(async () => Promise.reject(new Error("boom")));
    const error = await failure(ensure(clientOf({ estimate })));
    expect(error.code).toBe("simulation-reverted");
    expect(estimate).toHaveBeenCalledTimes(1);
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    try {
      const flaky = vi.fn().mockRejectedValueOnce(unavailable()).mockResolvedValueOnce(5n);
      expect(await ensure(clientOf({ estimate: flaky }))).toMatchObject({ kind: "confirm", gas: 5n });
      expect(timers).toHaveBeenCalledWith(expect.any(Function), SIMULATION_RETRY_MILLISECONDS);
    } finally {
      timers.mockRestore();
    }
  });

  it("passes on a wait", async () => {
    const client = clientOf();
    // The next block lies in the next epoch: the newest header is one epoch behind.
    client.getBlock.mockResolvedValue({ number: blockNumber, timestamp: BigInt(fixture.expected.validUntil) - 12n, parentBeaconBlockRoot: fixture.block.parentBeaconBlockRoot });
    expect(await ensure(client)).toMatchObject({ kind: "wait", epoch: epoch + 1n, headerEpoch: epoch });
    expect(client.estimateGas).not.toHaveBeenCalled();
  });

  it("refuses to return a confirmation whose simulation reverts", async () => {
    const revert = Object.assign(new Error("Execution reverted.\nURL: https://rpc.example/secret-key"), {
      shortMessage: "Execution reverted with reason: custom error 0x3c1c6fca.\nDetails: x",
      cause: { cause: { data: "0x3c1c6fca0000000000000000000000000000000000000000000000000000000000057a14" } },
    });
    const error = await failure(ensure(clientOf({ estimate: async () => Promise.reject(revert) })));
    expect(error.code).toBe("simulation-reverted");
    expect(error.message).toBe(`confirm would revert (simulated at block ${blockNumber}): Execution reverted with reason: custom error 0x3c1c6fca. (revert data 0x3c1c6fca)`);
    expect(error.message).not.toContain("secret-key");
  });
});

describe("describeRevert", () => {
  it("names an error without a short message by its name, and anything else plainly", () => {
    expect(describeRevert(new RangeError("https://rpc.example/secret-key"))).toBe("RangeError");
    expect(describeRevert("text")).toBe("an error");
    expect(describeRevert(null)).toBe("an error");
    expect(describeRevert({ shortMessage: 7, data: "0x12", cause: { shortMessage: "inner", data: 5 } })).toBe("inner");
  });
});

describe("gateConfirmWindow", () => {
  const end = 1_793_563_872n;
  const at = (secondsBeforeEnd: number): number => (Number(end) - secondsBeforeEnd) * 1000;

  it("lets a confirmation go ahead when the safety window remains", () => {
    expect(gateConfirmWindow(end, at(200))).toEqual({ secondsLeft: 200, late: false, waitSeconds: 0 });
    expect(gateConfirmWindow(end, at(GATE_SAFETY_SECONDS))).toMatchObject({ late: false });
  });

  it("is late below the window, and waits for the end of the epoch plus a block", () => {
    expect(gateConfirmWindow(end, at(GATE_SAFETY_SECONDS - 1))).toEqual({ secondsLeft: 59, late: true, waitSeconds: 59 + GATE_BLOCK_SECONDS });
    expect(gateConfirmWindow(end, at(10.5))).toMatchObject({ secondsLeft: 10, late: true });
  });

  it("waits only a block when the epoch has ended already", () => {
    expect(gateConfirmWindow(end, at(-30))).toEqual({ secondsLeft: -30, late: true, waitSeconds: GATE_BLOCK_SECONDS });
  });
});
