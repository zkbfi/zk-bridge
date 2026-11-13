// GET /route/steps: every pending step of both directions, with its situation and constraints in numbers.
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, type Hex } from "viem";
import { encodeProofMessage, type ProofDirection } from "@zk-bridge/shared";
import type { Pipeline } from "../src/progress/pipeline.ts";
import type { IndexedMessage } from "../src/progress/indexer.ts";
import { buildRouteSteps, COVERED_LIMIT, LIGHT_CLIENT_STEP_AGE_SECONDS, type GpuView, type RouteStepInput } from "../src/steps/list.ts";
import type { StepService } from "../src/steps/service.ts";
import { insertStepJob } from "../src/steps/store.ts";
import { insertObservationAttempt } from "../src/seal/observations.ts";
import { openStorage } from "../src/storage.ts";
import { evidenceText, fakeChain, MESSAGE, observationPackage, registryAt, REGISTRY_PAIR, V1, V2 } from "./steps-support.ts";

const NOW = (1_000 + 8_192) * 10_000;
const GPU: GpuView = { warmMs: 60_000, coldMs: 240_000, workerWarm: false, budgetUsd: 5, spentUsd: 1.5, leftUsd: 3.5 };

const pipeline = (direction: ProofDirection, overrides: Partial<Pipeline> = {}): Pipeline => ({
  direction,
  now: NOW,
  rule: { minIntervalSeconds: 3600, lookaheadSeconds: 0, profitMargin: 1, proofCostUsd: "0.025000", priced: false, unpricedAtMaximumPays: true },
  batch: null,
  job: null,
  latestJob: null,
  latestProof: null,
  head: { slot: 100, finalizedSlot: 132, lastUpdateAt: NOW - 60_000, lagSeconds: 60 },
  decision: null,
  deposits: null,
  deadline: null,
  ...overrides,
});

const word = (byte: string): Hex => `0x${byte.repeat(32)}`;
const PUBLIC_VALUES = encodeAbiParameters(
  [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }],
  [word("aa"), word("01"), 100n, word("bb"), word("cc"), word("02"), 164n, word("dd"), 1n, word("ee"), word("ff")],
);
const PROOF_PAYLOAD = encodeProofMessage({ version: 1, pair: "eth-pls", direction: "second-to-first", programKey: word("11"), startSlot: 100n, startRoot: word("01"), newSlot: 164n, newRoot: word("02"), publicValues: PUBLIC_VALUES, proof: `0x${"ab".repeat(356)}` });

function setup(options: { pipelines?: Partial<Record<ProofDirection, Pipeline | Error>>; covered?: Partial<Record<ProofDirection, readonly IndexedMessage[] | Error>>; proofs?: Partial<Record<string, unknown>> } = {}) {
  const storage = openStorage(":memory:");
  const chain = fakeChain();
  chain.state.depositsOpen = true;
  chain.state.facts = { activeVersion: V1, registry: registryAt(V1, 50n) };
  chain.state.registry = { ...(chain.state.registry as object), head: { slot: NOW / 10_000 - 10, root: `0x${"77".repeat(32)}`, nextCommitteeHash: `0x${"00".repeat(32)}` } } as never;
  const proofs = options.proofs ?? {};
  const service = { proof: (kind: string, subject: string) => (proofs[`${kind}:${subject}`] as never) ?? null } as unknown as StepService;
  const input: RouteStepInput = {
    now: NOW,
    pair: REGISTRY_PAIR,
    storage,
    keepAliveSeconds: 43_200,
    proverTimeoutMilliseconds: 1_800_000,
    service,
    chain: chain.reads,
    pipelineOf: async (direction) => {
      const answer = options.pipelines?.[direction] ?? pipeline(direction);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    coveredOf: async (direction) => {
      const answer = options.covered?.[direction] ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    gpuOf: async () => GPU,
  };
  return { storage, chain, input, build: () => buildRouteSteps(input) };
}

const coveredMessage = (index: number): IndexedMessage => ({
  messageId: `0x${index.toString(16).padStart(64, "C")}`,
  status: "covered",
  direction: { sourceChainId: 1, destinationChainId: 369 },
  sent: { timestamp: 100 },
  covered: { headSlot: 5, timestamp: 200 },
  delivered: null,
});

describe("buildRouteSteps", () => {
  it("lists nothing when every light client is fresh, every bridge open and the registry current", async () => {
    expect(await setup().build()).toEqual({ now: NOW, steps: [], unread: [] });
  });

  it("lists a light client update with its numbers: age, waiting transfers, stranding, finality, GPU, posting and the keep-alive", async () => {
    const decision = { at: NOW - 10_000, finalizedSlot: 640, headSlot: 100, genesisTime: 0, secondsPerSlot: 12, due: false, why: "min-interval", detail: "waits" };
    const { build } = setup({
      pipelines: {
        "first-to-second": pipeline("first-to-second", {
          batch: { count: 3, oldestFinalAt: 1, trigger: "max-wait", eta: 2, fallbackAt: 3, feesUsd: null, costUsd: null, detail: "" },
          head: { slot: 100, finalizedSlot: 132, lastUpdateAt: NOW - 19 * 3_600_000, lagSeconds: 1 },
          decision,
          deposits: { open: false, remoteHasHead: true, waiting: true, proofDue: false },
          deadline: { at: NOW + 8 * 3_600_000, hoursLeft: 8, period: 3, headSlot: 100, headPeriod: 2 },
        }),
      },
    });
    const [step] = (await build()).steps;
    expect(step).toEqual({
      id: "light-client-update:first-to-second",
      kind: "light-client-update",
      subject: "first-to-second",
      direction: "first-to-second",
      chainId: 369,
      target: REGISTRY_PAIR.sides[1].contracts.lightClient,
      messageId: null,
      situation: { since: NOW - 19 * 3_600_000, behindSeconds: 19 * 3_600, waitingTransfers: 3, blocks: ["sends", "deliveries"], strandsAt: NOW + 8 * 3_600_000, layoutRows: null, activeVersion: null, recordedVersion: null },
      constraints: {
        finality: { finalizedSlot: 640, nextAt: NOW - 10_000 + 384_000 },
        gpu: GPU,
        job: null,
        proofReady: false,
        posting: { gas: "337000", gasSource: "fallback", gasPriceWei: "10", costWei: "3370000" },
        after: null,
      },
      fallback: { by: "backend", at: NOW - 19 * 3_600_000 + 43_200_000 },
    });
  });

  it("simulates the posting of a proof that waits, and names the job that runs", async () => {
    const { build, chain } = setup({
      pipelines: {
        "second-to-first": pipeline("second-to-first", {
          latestProof: { startSlot: 100, newSlot: 164, where: "stored", since: 1 },
          job: { jobId: "j7", status: "proving", step: "gpu-proving", startedAt: NOW - 5_000, elapsedMs: 5_000, detail: "" },
          head: null,
        }),
      },
      proofs: { "light-client-update:second-to-first": { kind: "light-client-update", payload: PROOF_PAYLOAD } },
    });
    chain.state.simulate = 290_000n;
    const step = (await build()).steps[0];
    expect(step).toMatchObject({ kind: "light-client-update", chainId: 1, situation: { since: null, behindSeconds: null, blocks: [] }, constraints: { job: { jobId: "job:j7", status: "proving" }, proofReady: true, posting: { gas: "290000", gasSource: "simulated" } }, fallback: { at: null } });
  });

  it("falls back to the runner's gas when the proof does not decode, and leaves out the cost without a gas price", async () => {
    const { build, chain } = setup({
      pipelines: { "first-to-second": pipeline("first-to-second", { latestProof: { startSlot: 100, newSlot: 164, where: "board", since: 1 } }) },
      proofs: { "light-client-update:first-to-second": { kind: "light-client-update", payload: "0x00" } },
    });
    chain.state.gasPrice = new Error("rpc down");
    const step = (await build()).steps[0];
    expect(step?.constraints.posting).toEqual({ gas: "337000", gasSource: "fallback", gasPriceWei: null, costWei: null });
    expect(step?.constraints.proofReady).toBe(false);
  });

  it("lists an old light client even when nothing waits, and not one whose proof landed", async () => {
    const old = setup({ pipelines: { "first-to-second": pipeline("first-to-second", { head: { slot: 1, finalizedSlot: 1, lastUpdateAt: NOW - LIGHT_CLIENT_STEP_AGE_SECONDS * 1000, lagSeconds: 0 } }) } });
    expect((await old.build()).steps.map((step) => step.id)).toEqual(["light-client-update:first-to-second"]);
    const landed = setup({ pipelines: { "first-to-second": pipeline("first-to-second", { latestProof: { startSlot: 1, newSlot: 2, where: "applied", since: 1 } }) } });
    expect((await landed.build()).steps).toEqual([]);
  });

  it("lists closed deposits on the destination, after the other light client's first update, and a ready opening proof", async () => {
    const { build, chain } = setup({
      pipelines: { "first-to-second": pipeline("first-to-second", { deposits: { open: false, remoteHasHead: false, waiting: false, proofDue: false } }) },
      proofs: { "open-deposits:second-to-first": { kind: "open-deposits", bridge: REGISTRY_PAIR.sides[0].contracts.bridge, calldata: "0xfeed", provedAt: NOW - 1_000 } },
    });
    chain.state.depositsOpen = false;
    const steps = (await build()).steps.filter((step) => step.kind === "open-deposits");
    expect(steps.map((step) => [step.subject, step.chainId, step.constraints.after, step.constraints.proofReady, step.constraints.posting.gasSource])).toEqual([
      ["first-to-second", 369, "light-client-update:second-to-first", false, null],
      ["second-to-first", 1, null, true, "simulated"],
    ]);
    expect(steps[0]).toMatchObject({ situation: { blocks: ["sends"] }, fallback: { by: "runner", at: null }, constraints: { job: null } });
  });

  it("does not offer an opening proof older than ten minutes, and names a running job", async () => {
    const { build, chain, storage } = setup({ proofs: { "open-deposits:first-to-second": { kind: "open-deposits", bridge: REGISTRY_PAIR.sides[1].contracts.bridge, calldata: "0xfeed", provedAt: NOW - 700_000 } } });
    chain.state.depositsOpen = false;
    insertStepJob(storage, { id: "step:o", kind: "open-deposits", subject: "first-to-second", at: NOW - 5, startSlot: null });
    const step = (await build()).steps.find((candidate) => candidate.subject === "first-to-second");
    expect(step?.constraints).toMatchObject({ proofReady: false, job: { jobId: "step:o", status: "running", startedAt: NOW - 5 } });
  });

  it("lists the covered messages as deliveries, with layout rows first when the evidence lists some", async () => {
    const messages = Array.from({ length: COVERED_LIMIT + 2 }, (_, index) => coveredMessage(index));
    const { build } = setup({
      covered: { "first-to-second": [{ ...messages[0], messageId: MESSAGE.toUpperCase().replace("0X", "0x") } as IndexedMessage, { ...messages[1], covered: null } as IndexedMessage, ...messages.slice(2)] },
      proofs: { [`deliver:${MESSAGE}`]: { kind: "deliver", evidence: JSON.parse(evidenceText(2)) } },
    });
    const steps = (await build()).steps;
    expect(steps).toHaveLength(COVERED_LIMIT);
    expect(steps[0]).toMatchObject({ id: `layout-rows:${MESSAGE}`, kind: "layout-rows", messageId: MESSAGE, chainId: 369, situation: { since: 200_000, waitingTransfers: 1, layoutRows: 2 }, constraints: { proofReady: true, posting: { gas: null, gasSource: null } } });
    expect(steps[1]).toMatchObject({ kind: "deliver", situation: { since: null, layoutRows: null }, constraints: { proofReady: false, posting: { gas: "600000", gasSource: "fallback" } } });
  });

  it("delivers without layout rows when the evidence lists none, and names unreadable parts", async () => {
    const { build, chain } = setup({
      pipelines: { "first-to-second": new Error("indexer down") },
      covered: { "second-to-first": new Error("indexer down"), "first-to-second": [{ ...coveredMessage(1), messageId: MESSAGE }] },
      proofs: { [`deliver:${MESSAGE}`]: { kind: "deliver", evidence: JSON.parse(evidenceText(0)) } },
    });
    chain.state.depositsOpen = new Error("rpc down");
    chain.state.registry = new Error("rpc down");
    chain.state.facts = new Error("beacon down");
    const answer = await build();
    expect(answer.steps.map((step) => step.kind)).toEqual(["deliver"]);
    expect(answer.unread).toEqual(["pipeline first-to-second", "deposits on chain 369", "deposits on chain 1", "covered messages second-to-first", "fork registry light client on chain 369", "fork facts of chain 369"]);
  });

  it("lists the registry's light client from half a period, with the fold limit, the backend's fallback and a ready proof", async () => {
    const { build, chain } = setup({
      pipelines: { "second-to-first": pipeline("second-to-first", { decision: { at: NOW, finalizedSlot: 9_000, headSlot: 1, genesisTime: 0, secondsPerSlot: 10, due: false, why: "x", detail: "" } }) },
      proofs: { "registry-light-client-update:369": { kind: "registry-light-client-update", startSlot: 1_000, lightClient: "0x5555555555555555555555555555555555555555", proof: "0x1234", publicValues: "0xabcd" } },
    });
    chain.state.registry = { ...(chain.state.registry as object), head: { slot: 1_000, root: `0x${"77".repeat(32)}`, nextCommitteeHash: `0x${"00".repeat(32)}` } } as never;
    const step = (await build()).steps.find((candidate) => candidate.kind === "registry-light-client-update");
    expect(step).toMatchObject({
      id: "registry-light-client-update:369",
      chainId: 369,
      direction: null,
      target: "0x5555555555555555555555555555555555555555",
      situation: { since: 10_000_000, behindSeconds: 81_920, strandsAt: 10_000_000 + 64 * 81_920_000 },
      constraints: { finality: { finalizedSlot: 9_000, nextAt: NOW + 320_000 }, gpu: GPU, proofReady: true, posting: { gasSource: "simulated" } },
      fallback: { by: "backend", at: 10_000_000 + 81_920_000 },
    });
  });

  it("does not offer a registry proof from another head", async () => {
    const { build, chain } = setup({ proofs: { "registry-light-client-update:369": { kind: "registry-light-client-update", startSlot: 999 } } });
    chain.state.registry = { ...(chain.state.registry as object), head: { slot: 1_000, root: `0x${"77".repeat(32)}`, nextCommitteeHash: `0x${"00".repeat(32)}` } } as never;
    const step = (await build()).steps.find((candidate) => candidate.kind === "registry-light-client-update");
    expect(step?.constraints).toMatchObject({ proofReady: false, finality: null, posting: { gas: "337000", gasSource: "fallback" } });
  });

  it("lists a fork observation while the chain runs a version the registry does not hold, with its held proof or its job", async () => {
    const ready = setup({ proofs: { "fork-observation:369": { kind: "fork-observation", observation: { ...observationPackage(), observedVersion: V2 } } } });
    ready.chain.state.facts = { activeVersion: V2, registry: registryAt(V1, 50n) };
    expect((await ready.build()).steps).toEqual([
      expect.objectContaining({ id: "fork-observation:369", target: "0x4444444444444444444444444444444444444444", situation: expect.objectContaining({ activeVersion: V2, recordedVersion: V1 }), constraints: expect.objectContaining({ proofReady: true, gpu: GPU, posting: expect.objectContaining({ gasSource: "simulated" }) }) }),
    ]);
    const proving = setup({ proofs: { "fork-observation:369": { kind: "fork-observation", observation: { ...observationPackage(), observedVersion: V1 } } } });
    proving.chain.state.facts = { activeVersion: V2, registry: registryAt("0x00000000", 0n) };
    insertObservationAttempt(proving.storage, { id: "o1", chainId: 369, version: V2, why: "first", at: NOW - 5 });
    expect((await proving.build()).steps[0]).toMatchObject({ situation: { recordedVersion: null }, constraints: { proofReady: false, job: { jobId: "observation:o1", startedAt: NOW - 5 }, posting: { gas: null } } });
  });

  it("reads no fork facts of a chain without a beacon node", async () => {
    const { build, input, chain } = setup();
    chain.state.facts = new Error("would fail");
    const pair = { ...input.pair, sides: [input.pair.sides[0], { ...input.pair.sides[1], beaconUrl: null }] as const };
    expect(await buildRouteSteps({ ...input, pair: pair as never })).toMatchObject({ unread: [] });
    void build;
  });
});
