// Fork observations: the prover package, its public view, when an observation is worth a proof, and the observe offer.
import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, type Address, type Hex } from "viem";
import {
  activeForkVersion,
  forkObservationPackageSchema,
  forkRegistryAbi,
  latestForkObservationSchema,
  observationNeed,
  observeCalldata,
  offerObservation,
  publicForkObservation,
  type ForkObservation,
  type LatestForkObservation,
} from "../src/index.js";

const REGISTRY: Address = "0x4444444444444444444444444444444444444444";
const ACCOUNT: Address = "0x000000000000000000000000000000000000dEaD";

const proverPackage = {
  schemaVersion: 1,
  route: "pulsechain_testnet_to_sepolia",
  chainId: 943,
  registry: REGISTRY,
  lightClient: "0x5555555555555555555555555555555555555555",
  programKey: `0x${"66".repeat(32)}`,
  startHeadSlot: 100,
  observedVersion: "0x9000006A",
  shape: 8,
  observedAttestedSlot: 900,
  foldSteps: 3,
  publicValues: `0x${"00".repeat(256)}`,
  proof: "0x1234",
  observeCalldata: "0xabcd",
  backend: "remote",
  createdAt: "2026-11-11T00:00:00Z",
} as const;

const registryAt = (version: Hex, shape: number, slot: bigint): ForkObservation => ({ registry: REGISTRY, version, shape, slot, shapeAllowed: shape >= 5 && shape <= 7, observed: BigInt(version) !== 0n });

describe("forkObservationPackageSchema and publicForkObservation", () => {
  it("reads the prover's line and keeps only the public fields, the version in lower case", () => {
    const parsed = forkObservationPackageSchema.parse(proverPackage);
    const view = publicForkObservation({ package: parsed, provedAt: 5, postedTransaction: null });
    expect(view).toMatchObject({ chainId: 943, observedVersion: "0x9000006a", shape: 8, shapeAllowed: false, observedAttestedSlot: 900, provedAt: 5, postedTransaction: null });
    expect(view).not.toHaveProperty("backend");
    expect(view).not.toHaveProperty("route");
    expect(latestForkObservationSchema.parse(view)).toEqual(view);
    expect(publicForkObservation({ package: { ...parsed, shape: 5 }, provedAt: 5, postedTransaction: `0x${"77".repeat(32)}` }).shapeAllowed).toBe(true);
  });
  it("refuses a line of another shape", () => {
    expect(forkObservationPackageSchema.safeParse({ ...proverPackage, publicValues: "0x00" }).success).toBe(false);
    expect(forkObservationPackageSchema.safeParse({ ...proverPackage, extra: 1 }).success).toBe(false);
    expect(forkObservationPackageSchema.safeParse({ ...proverPackage, foldSteps: 65 }).success).toBe(false);
  });
});

describe("activeForkVersion", () => {
  const clock = { genesisTime: 1_000, secondsPerSlot: 10, slotsPerEpoch: 32 };
  const forks = [
    { version: "0x00000369", epoch: 0, name: "phase0" },
    { version: "0x0000036A", epoch: 10, name: "capella" },
  ];
  it("is the scheduled fork with the highest epoch that has begun", () => {
    expect(activeForkVersion(forks, clock, 1_000 + 9 * 320)).toBe("0x00000369");
    expect(activeForkVersion(forks, clock, 1_000 + 10 * 320)).toBe("0x0000036a");
    expect(activeForkVersion([...forks].reverse(), clock, 1_000 + 11 * 320)).toBe("0x0000036a");
  });
  it("is null before genesis and with no fork", () => {
    expect(activeForkVersion(forks, clock, 999)).toBeNull();
    expect(activeForkVersion([], clock, 5_000)).toBeNull();
  });
});

describe("observationNeed", () => {
  it("asks for a first observation and for a new version, not for a recorded one", () => {
    expect(observationNeed({ activeVersion: "0x0000036a", registry: registryAt("0x00000000", 0, 0n) })).toEqual({ needed: true, why: "first", version: "0x0000036a" });
    expect(observationNeed({ activeVersion: "0x0000036B", registry: registryAt("0x0000036a", 5, 9n) })).toEqual({ needed: true, why: "new-version", version: "0x0000036b" });
    expect(observationNeed({ activeVersion: "0x0000036A", registry: registryAt("0x0000036a", 5, 9n) })).toMatchObject({ needed: false, why: "recorded" });
    expect(observationNeed({ activeVersion: null, registry: registryAt("0x00000000", 0, 0n) })).toMatchObject({ needed: false, why: "no-fork" });
  });
});

describe("offerObservation", () => {
  const view: LatestForkObservation = publicForkObservation({ package: forkObservationPackageSchema.parse(proverPackage), provedAt: 1, postedTransaction: null });
  const client = (slot: bigint, gas: bigint | null) => ({
    readContract: vi.fn(async () => ["0x0000036a", 5, slot] as const),
    estimateGas: vi.fn(async () => (gas === null ? Promise.reject(new Error("revert")) : gas)),
  });
  it("offers observe(proof, publicValues) when it simulates and adds a newer slot", async () => {
    const reader = client(800n, 300_000n);
    const offer = await offerObservation({ client: reader as never, registry: REGISTRY, observation: view, account: ACCOUNT });
    expect(offer).toMatchObject({ kind: "ready", gas: 300_000n, call: { to: REGISTRY } });
    const call = decodeFunctionData({ abi: forkRegistryAbi, data: (offer as { call: { data: Hex } }).call.data });
    expect(call).toMatchObject({ functionName: "observe", args: ["0x1234", view.publicValues] });
    expect(observeCalldata(view)).toBe((offer as { call: { data: Hex } }).call.data);
  });
  it("offers nothing without a proof, for another registry, for an older slot, or when the simulation reverts", async () => {
    expect(await offerObservation({ client: client(0n, 1n) as never, registry: REGISTRY, observation: null, account: ACCOUNT })).toMatchObject({ kind: "unavailable", reason: expect.stringContaining("no observation proof") });
    expect(await offerObservation({ client: client(0n, 1n) as never, registry: "0x9999999999999999999999999999999999999999", observation: view, account: ACCOUNT })).toMatchObject({ reason: expect.stringContaining("another registry") });
    expect(await offerObservation({ client: client(900n, 1n) as never, registry: REGISTRY, observation: view, account: ACCOUNT })).toMatchObject({ reason: expect.stringContaining("already holds an observation at slot 900") });
    expect(await offerObservation({ client: client(1n, null) as never, registry: REGISTRY, observation: view, account: ACCOUNT })).toMatchObject({ reason: expect.stringContaining("refuses the proof now") });
  });
});
