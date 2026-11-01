import { getAddress, type Address, type PublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GateEvidenceError } from "@zk-bridge/shared";
import { createTrafficGate } from "../../src/traffic/gate.ts";

const GATE = getAddress(`0x${"16".repeat(20)}`);
const WALLET = getAddress(`0x${"70".repeat(20)}`);
const ROOT = `0x${"ab".repeat(32)}` as const;

/** A chain whose gate enforces and has not confirmed the epoch: the next step asks the beacon node. */
const enforcingChain = () => {
  const reads: Record<string, unknown> = {
    mode: 0,
    enforcing: true,
    isSealed: false,
    confirmedEpoch: [0n, false],
    genesisTime: 1_655_733_600n,
    secondsPerSlot: 12n,
    slotsPerEpoch: 32n,
    genesisValidatorsRoot: ROOT,
    beaconRoots: "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02",
  };
  return {
    getBlock: vi.fn(async () => ({ number: 9n, timestamp: 1_793_563_500n, parentBeaconBlockRoot: ROOT })),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => reads[functionName]),
    call: vi.fn(async () => ({ data: ROOT })),
    estimateGas: vi.fn(async () => 1n),
  } as unknown as PublicClient;
};

afterEach(() => vi.unstubAllGlobals());

describe("the gate of the traffic bot", () => {
  it("names the setting when an enforcing gate needs a proof and no beacon API is configured", async () => {
    const gate = createTrafficGate({ client: enforcingChain(), gate: GATE, chainId: 11155111, beaconUrl: null });
    const error = await gate.ensure(WALLET).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GateEvidenceError);
    expect((error as GateEvidenceError).message).toBe("no beacon API for chain 11155111: set traffic.gateBeaconUrls.11155111 or EXPLORER_BEACON_URL_11155111");
  });

  it("asks the configured beacon API for the header of the root that the chain holds", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const gate = createTrafficGate({ client: enforcingChain(), gate: GATE, chainId: 11155111, beaconUrl: "https://beacon.example" });
    await expect(gate.ensure(WALLET)).rejects.toThrow(`the beacon node answered 503 for the header ${ROOT}`);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(`https://beacon.example/eth/v1/beacon/headers/${ROOT}`);
  });

  it("asks nothing of the beacon API when the gate does not enforce", async () => {
    const client = enforcingChain();
    (client.readContract as ReturnType<typeof vi.fn>).mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === "enforcing" || functionName === "isSealed" ? false : functionName === "confirmedEpoch" ? [0n, false] : functionName === "mode" ? 1 : functionName === "beaconRoots" ? (GATE as Address) : 1n,
    );
    const gate = createTrafficGate({ client, gate: GATE, chainId: 943, beaconUrl: null });
    expect(await gate.ensure(WALLET)).toMatchObject({ kind: "not-needed", reason: "not-enforcing" });
  });
});
