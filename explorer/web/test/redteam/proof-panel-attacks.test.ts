/**
 * Red team (2026-10-29): a malicious archive, msgboard indexer or msgboard node feeds the proof panel of the message
 * page. These tests show what the page refuses and what reaches the review dialog.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, encodeFunctionData, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ORACLE_PROOF_BYTES, PROOF_BYTES, encodeProofMessage, proofCategory, readProvenMessage, type ProofMessage, type ResolvedSetting } from "@zk-bridge/shared";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { messageBridgeAbi } from "@terminal/tx/abis";
import { chosenDeliverySteps, planDelivery, readEvidence, readLatestProof, type DeliveryStep, type PanelEndpoints, type PanelTransport } from "../../src/views/proof-panel-model";

const word = (digit: string): Hex => `0x${digit.repeat(64)}`;
const vectorDir = join(__dirname, "../../../../light-client/tests/fixtures/message");
const vector = (name: string): Hex => (JSON.parse(readFileSync(join(vectorDir, `${name}.json`), "utf8")) as { calldata: Hex }).calldata;
const bridge = FIXTURE_PAIR.second.contracts.messageBridge;
const lightClient = FIXTURE_PAIR.second.contracts.lightClient;

const EXECUTE = vector("electra_accept_second_message_in_same_receipt");
const PROVEN = readProvenMessage(EXECUTE);
const EXPECTED = { messageId: PROVEN.messageId, sourceTransactionHash: PROVEN.sourceTransactionHash };

const evidence = (changes: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  route: "ethereum_to_pulsechain",
  sourceTransactionHash: PROVEN.sourceTransactionHash,
  logIndex: 2,
  message: { messageId: PROVEN.messageId, sender: PROVEN.sender, executor: PROVEN.executor, gasLimit: Number(PROVEN.gasLimit), sourceSlot: 14_099_000 },
  destination: { chainId: 369, bridge, lightClient },
  anchor: { slot: 14_100_000, root: word("e") },
  deliveryStatus: "notDelivered",
  alreadyDelivered: false,
  execute: { to: bridge, data: EXECUTE },
  prerequisites: [],
  ...changes,
});
const reading = (body: object) => ({ kind: "found" as const, text: JSON.stringify(body) });

const setting = (value: string): ResolvedSetting => ({ value, source: "user" });
const endpoints = (set: Partial<Record<keyof PanelEndpoints, string>>): PanelEndpoints => ({
  backendUrl: set.backendUrl === undefined ? null : setting(set.backendUrl),
  msgboardIndexerUrl: set.msgboardIndexerUrl === undefined ? null : setting(set.msgboardIndexerUrl),
  archiveUrl: set.archiveUrl === undefined ? null : setting(set.archiveUrl),
  msgboardUrl: set.msgboardUrl === undefined ? null : setting(set.msgboardUrl),
});

const outputParameters = [
  { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" },
  { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" },
] as const;
const proof = (overrides: Partial<ProofMessage> = {}): ProofMessage => {
  const startSlot = overrides.startSlot ?? 100n;
  const newSlot = overrides.newSlot ?? 200n;
  return {
    version: 1, pair: "eth-pls", direction: "first-to-second", programKey: word("9"), startSlot, startRoot: word("a"), newSlot, newRoot: word("b"),
    publicValues: encodeAbiParameters(outputParameters, [word("1"), word("a"), startSlot, word("3"), word("4"), word("b"), newSlot, word("5"), 1n, word("6"), word("7")]),
    proof: `0x${"ab".repeat(PROOF_BYTES)}`,
    ...overrides,
  };
};

describe("evidence on the message page (fix 3473404)", () => {
  it("ATTACK archive sends valid evidence of another message than the one viewed: BLOCKED", () => {
    const plan = planDelivery(reading(evidence()), FIXTURE_PAIR, { messageId: word("7"), sourceTransactionHash: null });
    expect(plan).toEqual({ kind: "unavailable", reason: "The evidence is for a different message." });
  });

  it("ATTACK archive relabels evidence of message B with the id of the viewed message A: BLOCKED", () => {
    const other = vector("electra_accept_dynamic_fee_receipt");
    const plan = planDelivery(reading(evidence({ execute: { to: bridge, data: other } })), FIXTURE_PAIR, EXPECTED);
    expect(plan.kind).toBe("unavailable");
    if (plan.kind === "unavailable") expect(plan.reason).toMatch(/cannot be used/);
  });

  it("ATTACK archive changes the source transaction hash label: BLOCKED", () => {
    const plan = planDelivery(reading(evidence({ sourceTransactionHash: word("c") })), FIXTURE_PAIR, EXPECTED);
    expect(plan.kind).toBe("unavailable");
  });

  it("ATTACK message id with path characters never reaches the archive URL: BLOCKED", async () => {
    const urls: string[] = [];
    const transport: PanelTransport = { fetchJson: async (url) => (urls.push(url), { status: 200, body: evidence() }), postJson: async () => ({ status: 200, body: {} }) };
    const answer = await readEvidence({ endpoints: endpoints({ archiveUrl: "https://archive.test" }), messageId: "../../admin?x=", transport });
    expect(answer.kind).toBe("none");
    expect(urls).toEqual([]);
  });

  it("ATTACK SUCCEEDS archive adds a prerequisite that sends a new message from the user's wallet", () => {
    const send = encodeFunctionData({ abi: messageBridgeAbi, functionName: "requireToPassMessage", args: ["0x000000000000000000000000000000000000beef", "0xdeadbeef", 500_000n] });
    const plan = planDelivery(
      reading(evidence({ prerequisites: [{ function: "requireToPassMessage", reason: "no validated block hash row covers the source slot", to: bridge, data: send }] })),
      FIXTURE_PAIR,
      EXPECTED,
    );
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    expect(plan.steps[0]!.role).toBe("prerequisite");
    expect(plan.steps[0]!.step.plan.title).toBe("Add a layout row: requireToPassMessage");
    expect(plan.steps[0]!.step.plan.data).toBe(send);
  });
});

describe("cleared rows keyed by calldata (fix f983930)", () => {
  const row = (data: Hex, role: DeliveryStep["role"] = "prerequisite"): DeliveryStep => ({
    role,
    reason: null,
    step: { plan: { data } as never, disclosure: {} as never },
  });

  it("ATTACK evidence re-read reorders rows so a cleared row would shift onto another: BLOCKED", () => {
    const a = row("0xaa"), b = row("0xbb"), execute = row("0xee", "execute");
    const steps = chosenDeliverySteps([b, a, execute], ["0xaa"]);
    expect(steps.map((step) => step.plan.data)).toEqual(["0xbb", "0xee"]);
  });

  it("ATTACK evidence re-read makes the execute row equal to a cleared calldata: the execute row stays", () => {
    const steps = chosenDeliverySteps([row("0xee", "execute")], ["0xee"]);
    expect(steps.map((step) => step.plan.data)).toEqual(["0xee"]);
  });
});

const board = (datas: Hex[]) => ({ jsonrpc: "2.0", id: 1, result: { a: datas.map((data) => ({ category: proofCategory("eth-pls", "first-to-second"), data, hash: word("0") })) } });

describe("latest proof from msgboard sources", () => {
  const panel = (fetch: PanelTransport["fetchJson"], post: PanelTransport["postJson"] = async () => ({ status: 200, body: {} })): PanelTransport => ({ fetchJson: fetch, postJson: post });

  it("ATTACK indexer serves a proof for the other direction: BLOCKED", async () => {
    const payload = encodeProofMessage(proof({ direction: "second-to-first" }));
    const answer = await readLatestProof({ endpoints: endpoints({ msgboardIndexerUrl: "https://ix.test" }), pair: "eth-pls", direction: "first-to-second", headSlot: 100n, transport: panel(async () => ({ status: 200, body: { payload } })) });
    expect(answer.kind).toBe("none");
  });

  it("ATTACK indexer serves an oracle (version 2) proof: BLOCKED", async () => {
    const payload = encodeProofMessage(proof({ version: 2, proof: `0x${"cd".repeat(ORACLE_PROOF_BYTES)}` }), { acceptOracleProof: true });
    const answer = await readLatestProof({ endpoints: endpoints({ msgboardIndexerUrl: "https://ix.test" }), pair: "eth-pls", direction: "first-to-second", headSlot: 100n, transport: panel(async () => ({ status: 200, body: { payload } })) });
    expect(answer.kind).toBe("none");
  });

  it("ATTACK SUCCEEDS indexer serves a stale proof (does not start at the head): it is shown as found", async () => {
    const payload = encodeProofMessage(proof({ startSlot: 50n, newSlot: 60n }));
    const answer = await readLatestProof({ endpoints: endpoints({ msgboardIndexerUrl: "https://ix.test" }), pair: "eth-pls", direction: "first-to-second", headSlot: 100n, transport: panel(async () => ({ status: 200, body: { payload } })) });
    // The indexer answer is not filtered by the head; only the post button re-reads the head (proofStartProblem).
    expect(answer.kind).toBe("found");
  });

  it("ATTACK msgboard node holds a proof that does not start at the head: BLOCKED", async () => {
    const stale = encodeProofMessage(proof({ startSlot: 50n, newSlot: 900n }));
    const answer = await readLatestProof({
      endpoints: endpoints({ msgboardUrl: "https://board.test" }), pair: "eth-pls", direction: "first-to-second", headSlot: 100n,
      transport: panel(async () => ({ status: 404, body: {} }), async () => ({ status: 200, body: board([stale]) })),
    });
    expect(answer.kind).toBe("none");
    // Control: the same board answer with a proof at the head is found, so the refusal above is the head filter.
    const good = encodeProofMessage(proof({ startSlot: 100n, newSlot: 300n }));
    const control = await readLatestProof({
      endpoints: endpoints({ msgboardUrl: "https://board.test" }), pair: "eth-pls", direction: "first-to-second", headSlot: 100n,
      transport: panel(async () => ({ status: 404, body: {} }), async () => ({ status: 200, body: board([stale, good]) })),
    });
    expect(control.kind).toBe("found");
  });
});
