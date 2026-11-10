// The fork cutover reads: the light client head, the verdict of a route, the fork state of a gate and registry, the seal offer.
import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { beaconHeaderRoot, hashPair, type BeaconBlockHeader } from "@zkb/core";
import {
  beaconForkGateAbi,
  createForkCutoverCheck,
  createGateCheck,
  offerSeal,
  readForkGateState,
  readForkObservation,
  readLightClientHead,
  SIMULATION_ACCOUNT,
  type BeaconProofSource,
  type GateChainClient,
} from "../src/index.js";

const GATE: Address = "0x1111111111111111111111111111111111111111";
const REGISTRY: Address = "0x2222222222222222222222222222222222222222";
const LIGHT_CLIENT: Address = "0x3333333333333333333333333333333333333333";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

const forkBody = (epoch: number) => ({ data: [{ current_version: "0x90000069", epoch: "0" }, { current_version: "0x90000070", epoch: String(epoch) }] });
const beaconFetch = (epoch: number, genesis = 1_000_000) =>
  vi.fn(async (url: string) => {
    const body = url.includes("fork_schedule") ? forkBody(epoch) : url.includes("genesis") ? { data: { genesis_time: String(genesis) } } : { data: { SECONDS_PER_SLOT: "12", SLOTS_PER_EPOCH: "32" } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

describe("readLightClientHead", () => {
  it("reads head() and is null when the read fails", async () => {
    expect(await readLightClientHead({ readContract: vi.fn(async () => 123n) } as never, LIGHT_CLIENT)).toBe(123n);
    expect(await readLightClientHead({ readContract: vi.fn(async () => Promise.reject(new Error("rpc"))) } as never, LIGHT_CLIENT)).toBeNull();
  });
});

describe("createForkCutoverCheck", () => {
  const forkTime = 1_000_000 + 50 * 384;
  const make = (head: bigint | null, now: number, epoch = 50, urls: readonly string[] = ["https://b"]) =>
    createForkCutoverCheck({
      routeOf: (chainId) => (chainId === 11155111 ? { destinationChainId: 943, lightClient: LIGHT_CLIENT } : null),
      clientFor: () => ({ readContract: vi.fn(async () => (head === null ? Promise.reject(new Error("x")) : head)) }) as never,
      beaconUrlsFor: () => urls,
      nowSeconds: () => now,
      fetch: beaconFetch(epoch),
    });
  it("pauses inside the window", async () => {
    const verdict = await make(1000n, forkTime - 60)(11155111);
    expect(verdict).toMatchObject({ kind: "paused", destinationChainId: 943 });
  });
  it("opens once the light client head is past the fork", async () => {
    expect((await make(1_601n, forkTime + 10)(11155111)).kind).toBe("open");
  });
  it("is unknown when the beacon node cannot be reached", async () => {
    expect(await make(1000n, forkTime, 50, [])(11155111)).toMatchObject({ kind: "unknown", reason: "beacon-unreachable" });
  });
  it("is open for a chain with no route", async () => {
    expect(await make(1000n, forkTime)(1)).toEqual({ kind: "open", next: null, pausesAt: null, secondsToPause: null });
  });
  it("uses the system clock and the global fetch by default", async () => {
    const check = createForkCutoverCheck({ routeOf: () => ({ destinationChainId: 943, lightClient: LIGHT_CLIENT }), clientFor: () => ({ readContract: async () => 10n }) as never, beaconUrlsFor: () => [] });
    expect((await check(1)).kind).toBe("unknown");
  });
});

describe("createGateCheck with a cutover", () => {
  const paused = { kind: "paused", destinationChainId: 943, fork: { version: "0x90000070", name: "Altair", epoch: 50, slot: 1600, time: 5 }, pausedSince: 1, lightClientHead: 1n, leadSeconds: 3600 } as const;
  it("answers paused and does not read the gate", async () => {
    const client = { getBlock: vi.fn(), readContract: vi.fn(), call: vi.fn(), estimateGas: vi.fn() };
    const check = createGateCheck({ clientFor: () => client as never, beaconUrlsFor: () => [], cutover: async () => paused });
    expect(await check({ chainId: 11155111, gate: GATE, account: GATE })).toEqual({ kind: "paused", verdict: paused });
    expect(client.readContract).not.toHaveBeenCalled();
  });
  it("goes on to the gate when the route is open or unknown", async () => {
    const client = { getBlock: vi.fn(async () => ({ number: 5n, timestamp: 1n })), readContract: vi.fn(async () => Promise.reject(new Error("gate read"))), call: vi.fn(), estimateGas: vi.fn() };
    const check = createGateCheck({ clientFor: () => client as never, beaconUrlsFor: () => [], cutover: async () => ({ kind: "unknown", reason: "beacon-unreachable", detail: "x" }) });
    await expect(check({ chainId: 11155111, gate: GATE, account: GATE })).rejects.toThrow("gate read");
  });
});

const gateReads = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  mode: 2,
  enforcing: true,
  isSealed: false,
  forkRegistry: REGISTRY,
  confirmedEpoch: [0n, false],
  genesisTime: 1_000_000n,
  secondsPerSlot: 12n,
  slotsPerEpoch: 32n,
  genesisValidatorsRoot: `0x${"ab".repeat(32)}`,
  beaconRoots: "0x000f3df6d732807ef1319fb7b8bb8522d0beac02",
  ...over,
});

describe("readForkGateState and readForkObservation", () => {
  const client = (reads: Record<string, unknown>) => ({ readContract: vi.fn(async ({ functionName }: { functionName: string }) => reads[functionName]) }) as never;
  it("reads mode, sealed, enforcing and the registry", async () => {
    expect(await readForkGateState({ client: client(gateReads()), gate: GATE })).toEqual({ gate: GATE, mode: "detect-beacon-roots-and-registry", enforcing: true, sealed: false, forkRegistry: REGISTRY });
    expect((await readForkGateState({ client: client(gateReads({ forkRegistry: ZERO, mode: 0 })), gate: GATE })).forkRegistry).toBeNull();
  });
  it("refuses an unknown mode", async () => {
    await expect(readForkGateState({ client: client(gateReads({ mode: 9 })), gate: GATE })).rejects.toThrow("unknown mode 9");
  });
  it("reads latestObserved with the shape verdict", async () => {
    const ok = await readForkObservation({ client: client({ latestObserved: ["0x90000075", 6, 123n] }), registry: REGISTRY });
    expect(ok).toEqual({ registry: REGISTRY, version: "0x90000075", shape: 6, slot: 123n, shapeAllowed: true, observed: true });
    const bad = await readForkObservation({ client: client({ latestObserved: ["0x90000076", 8, 5n] }), registry: REGISTRY });
    expect(bad).toMatchObject({ shapeAllowed: false });
    const none = await readForkObservation({ client: client({ latestObserved: ["0x00000000", 0, 0n] }), registry: REGISTRY });
    expect(none).toMatchObject({ observed: false });
  });
});

// A synthetic beacon state of depth 8 (a disallowed shape): the fork container at leaf 3, the genesis validators root at leaf 1.
const ZERO_CHUNK: Hex = `0x${"00".repeat(32)}`;
const leaf = (byte: string): Hex => `0x${byte.repeat(32)}`;
const VERSION_LEAF: Hex = `0x90000076${"00".repeat(28)}`;
const stateLeaves = new Map<bigint, Hex>([
  [257n, `0x${"ab".repeat(32)}`],
  [1036n, leaf("01")],
  [1037n, VERSION_LEAF],
  [1038n, leaf("02")],
]);
const nodeOf = (gindex: bigint): Hex => {
  const known = stateLeaves.get(gindex);
  if (known !== undefined) return known;
  // At and below the leaf level only the fork container (259, its halves 518 and 519) is a node with leaves under it.
  if (gindex >= 256n && ![259n, 518n, 519n].includes(gindex)) return ZERO_CHUNK;
  return hashPair(nodeOf(2n * gindex), nodeOf(2n * gindex + 1n));
};
/** The nodes that a compact multiproof descriptor names, in order, from the synthetic state. */
const leavesFor = (descriptor: Hex): Hex[] => {
  const bytes = Buffer.from(descriptor.slice(2), "hex");
  const bits = [...bytes].flatMap((byte) => Array.from({ length: 8 }, (_, bit) => (byte >> (7 - bit)) & 1));
  const out: Hex[] = [];
  let at = 0;
  const visit = (node: bigint): void => {
    const bit = bits[at++];
    if (bit === 1) {
      out.push(nodeOf(node));
      return;
    }
    visit(2n * node);
    visit(2n * node + 1n);
  };
  visit(1n);
  return out;
};
const header: BeaconBlockHeader = { slot: 16_000n, proposerIndex: 1n, parentRoot: leaf("07"), stateRoot: nodeOf(1n), bodyRoot: leaf("08") };
const beaconRoot = beaconHeaderRoot(header);

const sealClient = (opts: { estimate: (data: Hex) => boolean; reads?: Record<string, unknown>; parent?: Hex | null }) => {
  const reads = gateReads(opts.reads ?? {});
  return {
    getBlock: vi.fn(async (request?: { blockNumber?: bigint }) => ({ number: request?.blockNumber ?? 12n, timestamp: 1_700_000_000n, parentBeaconBlockRoot: opts.parent === undefined ? beaconRoot : opts.parent })),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => reads[functionName]),
    call: vi.fn(async () => ({ data: beaconRoot })),
    estimateGas: vi.fn(async ({ data }: { data: Hex }) => {
      if (!opts.estimate(data)) throw new Error("execution reverted");
      return 90_000n;
    }),
  };
};
const asGateClient = (client: ReturnType<typeof sealClient>) => client as unknown as GateChainClient;
const beaconWith = (depthsServed: readonly number[] = [8]): BeaconProofSource => ({
  header: vi.fn(async () => header),
  stateProof: vi.fn(async (_stateId, descriptor) => {
    // The descriptor of the depth that the builder asks for decides whether this node can serve it.
    const served = depthsServed.some((depth) => {
      try {
        leavesFor(descriptor);
        return depth === 8 || depth === 9 ? descriptor.length > 4 : false;
      } catch {
        return false;
      }
    });
    if (!served) throw new Error("no such proof");
    return { leaves: leavesFor(descriptor) };
  }),
});

describe("offerSeal", () => {
  it("is sealed when the gate is sealed", async () => {
    const client = sealClient({ estimate: () => true, reads: { isSealed: true } });
    expect(await offerSeal({ client: asGateClient(client), gate: GATE, account: SIMULATION_ACCOUNT })).toEqual({ kind: "sealed" });
  });

  it("is ready with empty evidence when the registry path simulates", async () => {
    const client = sealClient({ estimate: (data) => decodeFunctionData({ abi: beaconForkGateAbi, data }).args?.[0] === "0x" });
    const offer = await offerSeal({ client: asGateClient(client), gate: GATE, account: SIMULATION_ACCOUNT });
    expect(offer).toMatchObject({ kind: "ready", via: "registry", gas: 90_000n });
    expect(offer.kind === "ready" && offer.call.to).toBe(GATE);
  });

  it("without a beacon, says what was tried", async () => {
    const withRegistry = sealClient({ estimate: () => false });
    expect(await offerSeal({ client: asGateClient(withRegistry), gate: GATE, account: SIMULATION_ACCOUNT })).toEqual({ kind: "unavailable", reason: "the registry shows no shape outside the allowed set" });
    const none = sealClient({ estimate: () => false, reads: { forkRegistry: ZERO, mode: 0 } });
    expect((await offerSeal({ client: asGateClient(none), gate: GATE, account: SIMULATION_ACCOUNT })).kind).toBe("unavailable");
  });

  it("builds evidence of a disallowed depth from the beacon state and simulates it", async () => {
    const client = sealClient({ estimate: (data) => decodeFunctionData({ abi: beaconForkGateAbi, data }).args?.[0] !== "0x", reads: { forkRegistry: ZERO, mode: 0 } });
    const offer = await offerSeal({ client: asGateClient(client), gate: GATE, account: SIMULATION_ACCOUNT, beacon: beaconWith() });
    expect(offer).toMatchObject({ kind: "ready", via: "beacon" });
    // Simulated at the evidence block, two behind the latest.
    expect(client.estimateGas).toHaveBeenLastCalledWith(expect.objectContaining({ blockNumber: 10n }));
  });

  it("tries the next depth when a proof cannot be served, and reports when none simulates", async () => {
    const client = sealClient({ estimate: () => false, reads: { forkRegistry: ZERO, mode: 0 } });
    const beacon = beaconWith();
    const offer = await offerSeal({ client: asGateClient(client), gate: GATE, account: SIMULATION_ACCOUNT, beacon });
    expect(offer).toEqual({ kind: "unavailable", reason: "the beacon state has no disallowed shape" });
    const none = beaconWith([]);
    expect(await offerSeal({ client: asGateClient(client), gate: GATE, account: SIMULATION_ACCOUNT, beacon: none })).toEqual({ kind: "unavailable", reason: "the beacon state has no disallowed shape" });
  });

  it("reports a beacon header that cannot be built, after the registry attempt", async () => {
    const client = sealClient({ estimate: () => false, parent: null });
    const offer = await offerSeal({ client: asGateClient(client), gate: GATE, account: SIMULATION_ACCOUNT, beacon: beaconWith() });
    expect(offer.kind === "unavailable" && offer.reason).toContain("the registry shows no shape outside the allowed set; the beacon evidence could not be built (block 10 names no parent beacon block root");
  });
});
