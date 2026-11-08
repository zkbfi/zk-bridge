import { getAddress, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { GateEvidenceError, type BeaconProofSource, type GateChainClient, type GateConfirmation } from "@zk-bridge/shared";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { buildConfirmView } from "../../src/tx/confirm-model";
import { createGateCheck, fallbackBeaconSource, gateErrorText, passesGate, planGateConfirm } from "../../src/tx/gate-check";
import { encodeFunctionData, parseAbi } from "viem";

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

  it("says that no endpoint is set when the list is empty", async () => {
    await expect(fallbackBeaconSource([]).header("0x00")).rejects.toMatchObject({ code: "beacon-request-failed", message: "no beacon endpoint is set for this chain (Settings, Beacon endpoints)" });
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

describe("createGateCheck", () => {
  it("reads the gate on the flow client of the chain, with the beacon endpoints in force at the check", async () => {
    const client = openGateClient();
    const urls = vi.fn(() => ["https://beacon.example"]);
    const fetch = vi.fn();
    const check = createGateCheck({ clientFor: () => client, beaconUrlsFor: urls, fetch: fetch as unknown as typeof globalThis.fetch });
    const answer = await check({ chainId: 11_155_111, gate: "0x1782a38a37ce9fb9f53b0585b23b833847007e20", account: "0x8D43a3DF4951652d04bA29098D292136Af004Bdd" });
    expect(answer).toMatchObject({ kind: "not-needed", reason: "not-enforcing" });
    expect(urls).toHaveBeenCalledWith(11_155_111);
    expect(client.reads).toContain("enforcing");
    // A gate that does not enforce never asks the beacon node.
    expect(fetch).not.toHaveBeenCalled();
    const withGlobalFetch = createGateCheck({ clientFor: () => client, beaconUrlsFor: () => [] });
    await expect(withGlobalFetch({ chainId: 1, gate: "0x1782a38a37ce9fb9f53b0585b23b833847007e20", account: "0x8D43a3DF4951652d04bA29098D292136Af004Bdd" })).resolves.toMatchObject({ kind: "not-needed" });
  });
});

describe("the confirmation step", () => {
  const evidence: Hex = `0x${"ab".repeat(40)}`;
  const gate = FIXTURE_PAIR.first.contracts.gate as Address;
  const answer = {
    kind: "confirm",
    call: { to: gate, data: encodeFunctionData({ abi: parseAbi(["function confirm(bytes evidence)"]), functionName: "confirm", args: [evidence] }) },
    gas: 150_000n,
    epoch: 360_335n,
    forkVersion: "0x90000075",
    shape: 6,
    validUntil: 1_762_502_400n,
    evidence: { encoded: evidence, header: { slot: 11_530_720n } },
  } as unknown as Extract<GateConfirmation, { kind: "confirm" }>;

  it("is confirm(bytes) on the gate with no value, and says the epoch and the deadline in numbers", () => {
    const plan = planGateConfirm(FIXTURE_PAIR.first, answer);
    expect(plan).toMatchObject({ title: "Confirm this epoch on the gate (epoch 360335)", to: getAddress(gate), functionSignature: "confirm(bytes)", value: 0n });
    expect(plan.notes).toEqual([
      "The Ethereum deposit gate admits sends in epoch 360335 once one transaction confirms it. This transaction confirms it. Your send follows as the next step.",
      "The evidence proves fork version 0x90000075 with the beacon header of slot 11530720. The gate checks it against the beacon root on chain.",
      "It must be mined before 08:00:00 UTC, the end of epoch 360335. It sends no ETH.",
    ]);
  });

  it("passes the confirm dialog's check of the bytes", () => {
    const plan = planGateConfirm(FIXTURE_PAIR.first, answer);
    const view = buildConfirmView({ plan, disclosure: { feesApplyTo: "this-transaction", destinationNativeSymbol: null, destinationChainId: null, amountToken: null, delivery: null } });
    expect(view.blockedReason).toBeNull();
    expect(view.noRouterNotice).toBeNull();
    expect(view.arguments[0]).toMatchObject({ name: "evidence", meaning: "40 bytes" });
    expect(view.notes).toHaveLength(3);
  });
});

describe("passesGate and gateErrorText", () => {
  it("counts the sends on a chain with a gate only", () => {
    const plan = planGateConfirm(FIXTURE_PAIR.first, { call: { to: FIXTURE_PAIR.first.contracts.gate as Address, data: "0x" }, epoch: 1n, forkVersion: "0x00", validUntil: 0n, evidence: { encoded: "0x", header: { slot: 0n } } } as never);
    expect(passesGate(plan)).toBe(false);
    expect(passesGate({ ...plan, functionName: "relayTokens" })).toBe(true);
    expect(passesGate({ ...plan, functionName: "relayTokens", chain: { ...plan.chain, contracts: { ...plan.chain.contracts, gate: null } } })).toBe(false);
  });

  it("writes a thrown value that is not an Error as text", () => {
    expect(gateErrorText("odd", "Sepolia")).toBe("Could not confirm the Sepolia deposit gate: odd.");
  });
});
