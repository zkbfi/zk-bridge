import { describe, expect, it, vi } from "vitest";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { ObservationOffer, SealOffer } from "@zk-bridge/shared";
import { planStepPost, type PostInput, type PostPlan } from "../../src/route/plan-step";
import type { StepBackend } from "../../src/route/route-port";
import { stepOf } from "./fixtures";
import { EVIDENCE_MESSAGE, HEAD, evidenceOf, lightClientProof, openingProof, registryProof } from "./proofs";

const REGISTRY = "0x00000000000000000000000000000000000000f1" as const;
const sealReady: SealOffer = { kind: "ready", via: "registry", call: { to: "0x00000000000000000000000000000000000000f2", data: "0xabcd" }, evidence: "0x", gas: 90_000n } as unknown as SealOffer;
const observeReady = { kind: "ready", call: { to: REGISTRY, data: "0xabcd" }, gas: 280_000n, observation: { observedVersion: "0x90000076", observedAttestedSlot: 900, shape: 8, shapeAllowed: false, startHeadSlot: 100, proof: "0x12", publicValues: "0x34" } } as unknown as ObservationOffer;

const names = (plan: PostPlan): string[] => (plan as Extract<PostPlan, { kind: "ready" }>).steps.map((step) => step.plan.functionName);

const input = (step: PostInput["step"], over: Partial<{ proof: unknown; head: bigint | "fail"; seal: SealOffer; observe: ObservationOffer }> = {}): PostInput => ({
  step,
  pair: FIXTURE_PAIR,
  account: FIXTURE_ACCOUNT,
  backend: { request: vi.fn(), proof: async () => (over.proof === undefined ? null : over.proof) } as unknown as StepBackend,
  forks: { facts: async () => null, chainState: async () => ({ gate: null, observation: null }), sealOffer: async () => over.seal ?? sealReady, observeOffer: async () => over.observe ?? observeReady },
  readLightClientHead: async () => {
    if (over.head === "fail") throw new Error("down");
    return over.head ?? HEAD;
  },
});

describe("planStepPost", () => {
  it("plans a seal from the offer, and says when the call would not go through or the gate is sealed", async () => {
    const plan = await planStepPost(input(stepOf("seal")));
    expect(plan).toMatchObject({ kind: "ready" });
    expect(names(plan)[0]).toBe("seal");
    expect(await planStepPost(input(stepOf("seal"), { seal: { kind: "unavailable", reason: "it reverts" } }))).toEqual({ kind: "blocked", reason: "The seal call would not go through now: it reverts." });
    expect(await planStepPost(input(stepOf("seal"), { seal: { kind: "sealed" } }))).toEqual({ kind: "blocked", reason: "The gate is sealed already." });
  });

  it("plans a fork observation from the offer on the registry of the chain, or the step's target", async () => {
    const withRegistry = { ...FIXTURE_PAIR, second: { ...FIXTURE_PAIR.second, contracts: { ...FIXTURE_PAIR.second.contracts, forkRegistry: REGISTRY } } };
    expect(await planStepPost({ ...input(stepOf("fork-observation")), pair: withRegistry })).toMatchObject({ kind: "ready" });
    expect(await planStepPost(input(stepOf("fork-observation", { target: REGISTRY })))).toMatchObject({ kind: "ready" });
    expect(await planStepPost(input(stepOf("fork-observation")))).toEqual({ kind: "blocked", reason: "PulseChain has no fork registry in this deployment." });
    expect(await planStepPost(input(stepOf("fork-observation", { target: REGISTRY }), { observe: { kind: "unavailable", reason: "no newer slot" } }))).toEqual({ kind: "blocked", reason: "The observation would not go through now: no newer slot." });
  });

  it("says when the backend holds no proof, or one of another kind", async () => {
    const none = { kind: "blocked", reason: "The backend holds no finished proof for this step now. Make the proof again." };
    expect(await planStepPost(input(stepOf("light-client-update")))).toEqual(none);
    expect(await planStepPost(input(stepOf("light-client-update"), { proof: registryProof() }))).toEqual(none);
    expect(await planStepPost(input(stepOf("open-deposits"), { proof: { kind: "fork-observation" } }))).toEqual(none);
  });

  it("plans a light client update when the head is where the proof starts", async () => {
    const plan = await planStepPost(input(stepOf("light-client-update"), { proof: lightClientProof() }));
    expect(plan).toMatchObject({ kind: "ready" });
    expect((plan as Extract<PostPlan, { kind: "ready" }>).steps).toHaveLength(1);
  });

  it("treats a head that moved as posted by someone else, and says when the head cannot be read or the proof is not a proof", async () => {
    const past = await planStepPost(input(stepOf("light-client-update"), { proof: lightClientProof(), head: HEAD + 64n }));
    expect(past).toEqual({ kind: "posted-elsewhere", reason: `The light client already holds slot ${HEAD + 64n}. This proof reaches only slot ${HEAD + 64n}.` });
    expect(await planStepPost(input(stepOf("light-client-update"), { proof: lightClientProof(), head: HEAD - 1n }))).toMatchObject({ kind: "posted-elsewhere" });
    expect(await planStepPost(input(stepOf("light-client-update"), { proof: lightClientProof(), head: "fail" }))).toEqual({ kind: "blocked", reason: "The page could not read the head of the light client. Check the RPC setting for the chain in Connections." });
    const garbled = { ...lightClientProof(), payload: "0x1234" };
    expect(await planStepPost(input(stepOf("light-client-update"), { proof: garbled }))).toMatchObject({ kind: "blocked", reason: expect.stringContaining("The proof could not be read") });
  });

  it("plans the update of the registry light client and the opening of deposits, and refuses a bad opening", async () => {
    const registry = await planStepPost(input(stepOf("registry-light-client-update"), { proof: registryProof() }));
    expect(names(registry)[0]).toBe("update");
    const open = await planStepPost(input(stepOf("open-deposits"), { proof: openingProof() }));
    expect(names(open)[0]).toBe("openDeposits");
    expect(await planStepPost(input(stepOf("open-deposits"), { proof: openingProof("0x12345678") }))).toMatchObject({ kind: "blocked", reason: expect.stringContaining("The transaction could not be planned: The opening proof calldata is not a call to openDeposits") });
  });

  it("plans the layout rows and the delivery from the evidence, one transaction each side", async () => {
    const proof = (kind: "layout-rows" | "deliver") => ({ kind, subject: EVIDENCE_MESSAGE, evidence: evidenceOf() });
    const rows = await planStepPost(input(stepOf("layout-rows", { messageId: EVIDENCE_MESSAGE }), { proof: proof("layout-rows") }));
    expect(names(rows)).toEqual(["addBlockHashLayout"]);
    const deliver = await planStepPost(input(stepOf("deliver", { messageId: EVIDENCE_MESSAGE }), { proof: proof("deliver") }));
    expect(names(deliver)).toEqual(["executeMessage"]);
    const other = await planStepPost(input(stepOf("deliver"), { proof: proof("deliver") }));
    expect(other).toEqual({ kind: "blocked", reason: "The evidence is for a different message." });
    const noRows = await planStepPost(input(stepOf("layout-rows", { messageId: EVIDENCE_MESSAGE }), { proof: { kind: "layout-rows", subject: EVIDENCE_MESSAGE, evidence: evidenceOf({ prerequisites: [] }) } }));
    expect(noRows).toEqual({ kind: "blocked", reason: "The evidence holds no call for this step." });
    const bySubject = await planStepPost(input(stepOf("deliver", { messageId: null, subject: EVIDENCE_MESSAGE }), { proof: proof("deliver") }));
    expect(bySubject).toMatchObject({ kind: "ready" });
  });
});
