import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { createForkPort, fixtureForkPort } from "../../src/fork/fork-port";

const GATE = FIXTURE_PAIR.first.contracts.gate!;
const REGISTRY = "0x2222222222222222222222222222222222222222";

afterEach(() => vi.unstubAllGlobals());

const reads = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  head: 3000n,
  mode: 2,
  enforcing: true,
  isSealed: false,
  forkRegistry: REGISTRY,
  latestObserved: ["0x90000075", 6, 12n],
  ...over,
});

const connectionOf = (answers: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const client = {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      const answer = answers[functionName];
      if (answer instanceof Error) throw answer;
      return answer;
    }),
    getBlock: vi.fn(async () => ({ number: 5n, timestamp: 1n, parentBeaconBlockRoot: null })),
    call: vi.fn(),
    estimateGas: vi.fn(async () => {
      throw new Error("reverted");
    }),
    ...extra,
  };
  return { connection: { resolved: () => ({ beaconUrls: { [FIXTURE_PAIR.first.chainId]: { value: "https://beacon.example", source: "user" as const } } }), chainAccess: { flowClient: () => client } } as never, client };
};

const beaconFetch = vi.fn(async (url: string) => {
  const body = url.includes("fork_schedule")
    ? { data: [{ current_version: "0x90000070", epoch: "50" }] }
    : url.includes("genesis")
      ? { data: { genesis_time: "1000000" } }
      : { data: { SECONDS_PER_SLOT: "12", SLOTS_PER_EPOCH: "32" } };
  return new Response(JSON.stringify(body), { status: 200 });
});

describe("the sample page's fork port", () => {
  it("reads nothing", async () => {
    expect(await fixtureForkPort.facts(1)).toBeNull();
    expect(await fixtureForkPort.chainState(1)).toEqual({ gate: null, observation: null });
    expect(await fixtureForkPort.sealOffer(1, "0x0000000000000000000000000000000000000001")).toMatchObject({ kind: "unavailable" });
  });
});

describe("createForkPort", () => {
  it("reads the facts of a route: the beacon schedule of the source and the head of the light client on the destination", async () => {
    vi.stubGlobal("fetch", beaconFetch);
    const { connection } = connectionOf(reads());
    const facts = await createForkPort({ pair: FIXTURE_PAIR, connection }).facts(FIXTURE_PAIR.first.chainId);
    expect(facts).toMatchObject({ destinationChainId: FIXTURE_PAIR.second.chainId, lightClientHead: 3000n, source: { kind: "known" } });
    expect(await createForkPort({ pair: FIXTURE_PAIR, connection }).facts(5)).toBeNull();
  });

  it("reads the gate and the registry of a chain, the registry from the gate when the deployment names none", async () => {
    const { connection } = connectionOf(reads());
    const state = await createForkPort({ pair: FIXTURE_PAIR, connection }).chainState(FIXTURE_PAIR.first.chainId);
    expect(state.gate).toMatchObject({ mode: "detect-beacon-roots-and-registry", sealed: false });
    expect(state.observation).toMatchObject({ shape: 6, slot: 12n });
  });

  it("uses the registry of the deployment, and gives null for what cannot be read", async () => {
    const named = { ...FIXTURE_PAIR, second: { ...FIXTURE_PAIR.second, contracts: { ...FIXTURE_PAIR.second.contracts, forkRegistry: REGISTRY as `0x${string}` } } };
    const { connection, client } = connectionOf(reads({ forkRegistry: new Error("no such function"), isSealed: new Error("down"), latestObserved: new Error("down") }));
    const state = await createForkPort({ pair: named, connection }).chainState(FIXTURE_PAIR.second.chainId);
    expect(state).toEqual({ gate: null, observation: null });
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "latestObserved", address: REGISTRY }));
  });

  it("reads no gate of a chain that has none", async () => {
    const bare = { ...FIXTURE_PAIR, first: { ...FIXTURE_PAIR.first, contracts: { ...FIXTURE_PAIR.first.contracts, gate: null } } };
    const { connection } = connectionOf(reads());
    expect(await createForkPort({ pair: bare, connection }).chainState(FIXTURE_PAIR.first.chainId)).toEqual({ gate: null, observation: null });
    expect(await createForkPort({ pair: bare, connection }).sealOffer(FIXTURE_PAIR.first.chainId, "0x0000000000000000000000000000000000000001")).toEqual({ kind: "unavailable", reason: "Ethereum has no deposit gate" });
  });

  it("simulates the seal call on the gate of the chain", async () => {
    vi.stubGlobal("fetch", beaconFetch);
    const { connection, client } = connectionOf(reads(), { estimateGas: vi.fn(async () => 90_000n) });
    const offer = await createForkPort({ pair: FIXTURE_PAIR, connection }).sealOffer(FIXTURE_PAIR.first.chainId, "0x0000000000000000000000000000000000000001");
    expect(offer).toMatchObject({ kind: "ready", via: "registry", gas: 90_000n });
    expect(client.estimateGas).toHaveBeenCalledWith(expect.objectContaining({ to: GATE.toLowerCase() }));
  });
});
