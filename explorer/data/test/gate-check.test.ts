// The gate check that the web page and the terminal share: the beacon endpoints tried in order, and the check over them.
import { describe, expect, it, vi } from "vitest";
import { createGateCheck, fallbackBeaconSource, GateEvidenceError, NO_BEACON_ENDPOINT_TEXT, type BeaconProofSource, type GateChainClient } from "../src/index.js";

const HEADER = { slot: 1n, proposerIndex: 2n, parentRoot: `0x${"11".repeat(32)}`, stateRoot: `0x${"22".repeat(32)}`, bodyRoot: `0x${"33".repeat(32)}` } as const;

const failing = (message: string): BeaconProofSource => ({
  header: async () => {
    throw new GateEvidenceError("beacon-request-failed", message);
  },
  stateProof: async () => {
    throw new Error(message);
  },
});

const working: BeaconProofSource = { header: async () => HEADER, stateProof: async () => ({ leaves: [`0x${"44".repeat(32)}`] }) };

describe("fallbackBeaconSource", () => {
  it("asks the endpoints in order and takes the first answer", async () => {
    const source = fallbackBeaconSource([failing("the beacon node answered 403 for the header"), working]);
    await expect(source.header(`0x${"00".repeat(32)}`)).resolves.toEqual(HEADER);
    await expect(source.stateProof("0x01", "0x02")).resolves.toEqual({ leaves: [`0x${"44".repeat(32)}`] });
  });

  it("names how many were tried and the last reason when none answers", async () => {
    const source = fallbackBeaconSource([failing("first"), failing("the beacon node answered 503 for a proof")]);
    await expect(source.stateProof("0x01", "0x02")).rejects.toThrow("no beacon endpoint answered (2 tried; last: the beacon node answered 503 for a proof)");
    const odd = fallbackBeaconSource([{ header: () => Promise.reject("plain"), stateProof: () => Promise.reject("plain") }]);
    await expect(odd.header("0x00")).rejects.toThrow("last: plain");
  });

  it("says that no endpoint is set when the list is empty, in the program's words when it gives them", async () => {
    await expect(fallbackBeaconSource([]).header("0x00")).rejects.toMatchObject({ code: "beacon-request-failed", message: NO_BEACON_ENDPOINT_TEXT });
    await expect(fallbackBeaconSource([], { noneText: "set one in Settings" }).header("0x00")).rejects.toMatchObject({ message: "set one in Settings" });
  });
});

/** A gate client that answers the gate's reads: a gate in a detection mode that has not detected. */
const openGateClient = (): GateChainClient & { readonly reads: string[] } => {
  const reads: string[] = [];
  const answers: Record<string, unknown> = {
    mode: 1,
    enforcing: false,
    isSealed: false,
    confirmedEpoch: [0n, false],
    genesisTime: 1_655_733_600n,
    secondsPerSlot: 12n,
    slotsPerEpoch: 32n,
    genesisValidatorsRoot: `0x${"d8".repeat(32)}`,
    beaconRoots: "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02",
  };
  return {
    reads,
    getBlock: (async () => ({ number: 100n, timestamp: 1_762_500_000n, parentBeaconBlockRoot: `0x${"aa".repeat(32)}` })) as unknown as GateChainClient["getBlock"],
    readContract: (async (parameters: { functionName: string }) => {
      reads.push(parameters.functionName);
      return answers[parameters.functionName];
    }) as unknown as GateChainClient["readContract"],
    call: vi.fn() as unknown as GateChainClient["call"],
    estimateGas: vi.fn() as unknown as GateChainClient["estimateGas"],
  };
};

const GATE = "0x1782a38a37ce9fb9f53b0585b23b833847007e20";
const ACCOUNT = "0x8D43a3DF4951652d04bA29098D292136Af004Bdd";

describe("createGateCheck", () => {
  it("reads the gate on the flow client of the chain, with the beacon endpoints in force at the check", async () => {
    const client = openGateClient();
    const urls = vi.fn(() => ["https://beacon.example"]);
    const fetch = vi.fn();
    const check = createGateCheck({ clientFor: () => client, beaconUrlsFor: urls, fetch: fetch as unknown as typeof globalThis.fetch });
    const answer = await check({ chainId: 11_155_111, gate: GATE, account: ACCOUNT });
    expect(answer).toMatchObject({ kind: "not-needed", reason: "not-enforcing" });
    expect(urls).toHaveBeenCalledWith(11_155_111);
    expect(client.reads).toContain("enforcing");
    // A gate that does not enforce never asks the beacon node.
    expect(fetch).not.toHaveBeenCalled();
    // The global fetch stands behind a check that names none; a gate that does not enforce never reaches it.
    const withGlobalFetch = createGateCheck({ clientFor: () => client, beaconUrlsFor: () => ["https://beacon.example"], noneText: "none here" });
    await expect(withGlobalFetch({ chainId: 1, gate: GATE, account: ACCOUNT })).resolves.toMatchObject({ kind: "not-needed" });
  });

  it("asks for the send's evidence when the send carries it, with the program's clock or the default one", async () => {
    const client = openGateClient();
    const now = vi.fn(() => 1_762_500_000_000);
    const check = createGateCheck({ clientFor: () => client, beaconUrlsFor: () => ["https://beacon.example"], now });
    await expect(check({ chainId: 1, gate: GATE, account: ACCOUNT, carriesEvidence: true })).resolves.toEqual({ kind: "not-needed", reason: "not-enforcing", epoch: expect.any(BigInt) });
    expect(now).toHaveBeenCalled();
    const defaultClock = createGateCheck({ clientFor: () => client, beaconUrlsFor: () => [] });
    await expect(defaultClock({ chainId: 1, gate: GATE, account: ACCOUNT, carriesEvidence: true })).resolves.toMatchObject({ kind: "not-needed", reason: "not-enforcing" });
    // A send straight to the mediator still asks for the confirmation step.
    await expect(defaultClock({ chainId: 1, gate: GATE, account: ACCOUNT, carriesEvidence: false })).resolves.toMatchObject({ kind: "not-needed", reason: "not-enforcing" });
  });

  it("tells a chain with no beacon endpoint in the program's words once the gate needs one", async () => {
    const client = openGateClient();
    const enforcing: GateChainClient = {
      ...client,
      readContract: (async (parameters: { functionName: string }) => {
        if (parameters.functionName === "enforcing") return true;
        return (client.readContract as unknown as (p: { functionName: string }) => Promise<unknown>)(parameters);
      }) as unknown as GateChainClient["readContract"],
      call: (async () => ({ data: `0x${"aa".repeat(32)}` })) as unknown as GateChainClient["call"],
    };
    const check = createGateCheck({ clientFor: () => enforcing, beaconUrlsFor: () => [], noneText: "set a beacon URL" });
    await expect(check({ chainId: 1, gate: GATE, account: ACCOUNT })).rejects.toMatchObject({ code: "beacon-request-failed", message: "set a beacon URL" });
  });
});
