import { readFileSync } from "node:fs";
import { join } from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { encodeAbiParameters, encodeFunctionData, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { PROOF_BYTES, encodeProofMessage, proofCategory, type ProofMessage, type ResolvedSetting } from "@zk-bridge/shared";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { messageBridgeAbi } from "@terminal/tx/abis";
import { buildFixtureFeed, FIXTURE_NOW } from "@terminal/data/fixtures";
import { createFixtureIndexerClient } from "../../src/data/fixture-indexer-client";
import type { MessageDetail } from "../../src/data/message-detail";
import { chosenDeliverySteps, messageStage, NO_ENDPOINTS, planProofUpdate, planDelivery, readEvidence, readLatestProof, requestProofAvailability, type DeliveryStep, type PanelEndpoints, type PanelTransport } from "../../src/views/proof-panel-model";
import { MessageView } from "../../src/views/MessageView";
import { renderWithServices } from "./support";

const word = (digit: string): Hex => `0x${digit.repeat(64)}`;
const HEAD = 14_100_000n;

const outputParameters = [
  { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" },
  { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" },
] as const;

const proofMessage = (overrides: Partial<ProofMessage> = {}): ProofMessage => {
  const startSlot = overrides.startSlot ?? HEAD;
  const newSlot = overrides.newSlot ?? HEAD + 64n;
  return {
    version: 1, pair: "eth-pls", direction: "first-to-second", programKey: word("9"), startSlot, startRoot: word("a"), newSlot, newRoot: word("b"),
    publicValues: encodeAbiParameters(outputParameters, [word("1"), word("a"), startSlot, word("3"), word("4"), word("b"), newSlot, word("5"), 123n, word("6"), word("7")]),
    proof: `0x${"ab".repeat(PROOF_BYTES)}`,
    ...overrides,
  };
};

const setting = (value: string): ResolvedSetting => ({ value, source: "user" });
const endpoints = (set: Partial<Record<keyof PanelEndpoints, string>> = {}): PanelEndpoints => ({
  backendUrl: set.backendUrl === undefined ? null : setting(set.backendUrl),
  msgboardIndexerUrl: set.msgboardIndexerUrl === undefined ? null : setting(set.msgboardIndexerUrl),
  archiveUrl: set.archiveUrl === undefined ? null : setting(set.archiveUrl),
  msgboardUrl: set.msgboardUrl === undefined ? null : setting(set.msgboardUrl),
});

type Answer = { status: number; body: unknown };
const fakeTransport = (answers: { get?: (url: string) => Promise<Answer>; post?: (url: string, body: string) => Promise<Answer> }) => {
  const gets: string[] = [];
  const posts: string[] = [];
  const transport: PanelTransport = {
    fetchJson: async (url) => {
      gets.push(url);
      if (answers.get === undefined) throw new Error("no get expected");
      return answers.get(url);
    },
    postJson: async (url, init) => {
      posts.push(url);
      if (answers.post === undefined) throw new Error("no post expected");
      return answers.post(url, init?.body ?? "");
    },
  };
  return { transport, gets, posts };
};

const boardAnswer = (payloads: readonly Hex[]): Answer => {
  const category = proofCategory("eth-pls", "first-to-second");
  return { status: 200, body: { jsonrpc: "2.0", id: 1, result: { [category]: payloads.map((data, index) => ({ category, data, hash: `0x${index.toString(16).padStart(64, "0")}` })) } } };
};

const header = (slot: bigint) => ({ slot, proposerIndex: 5n, parentRoot: word("1"), stateRoot: word("2"), bodyRoot: word("3") });
const bridge = FIXTURE_PAIR.second.contracts.messageBridge;
// A contract test vector of the light client: real executeMessage calldata and the message that it delivers.
const vector = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../../light-client/tests/fixtures/message/electra_accept_second_message_in_same_receipt.json"), "utf8"),
) as { calldata: Hex; expected: { message: { messageId: Hex; sourceTransactionHash: Hex } } };
const evidenceOf = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 2,
  route: "ethereum_to_pulsechain",
  sourceTransactionHash: vector.expected.message.sourceTransactionHash,
  logIndex: 2,
  message: { messageId: vector.expected.message.messageId, sender: "0x00000000000000000000000000000000000000c3", executor: "0x00000000000000000000000000000000000000d4", gasLimit: 300000, dataType: 0, data: "0xabcdef", sourceBlockNumber: 15, sourceBlockHash: word("d"), sourceSlot: 14099000 },
  destination: { chainId: 369, bridge, lightClient: FIXTURE_PAIR.second.contracts.lightClient },
  anchor: { slot: 14100000, root: word("e") },
  deliveryStatus: "notDelivered",
  alreadyDelivered: false,
  execute: { to: bridge, data: vector.calldata },
  prerequisites: [
    {
      function: "addBlockHashLayout",
      reason: "no validated block hash row covers the source slot",
      to: bridge,
      data: encodeFunctionData({ abi: messageBridgeAbi, functionName: "addBlockHashLayout", args: [(2n ** 4n + 9n) * 2n ** 4n + 12n, { header: header(14099840n), branch: [word("7"), word("8")] }] }),
    },
  ],
  createdAt: "2026-10-24T09:31:00Z",
  ...changes,
});

const feed = buildFixtureFeed(FIXTURE_NOW);
const item = feed.find((candidate) => candidate.kind === "token")!;
const detailWith = async (changes: Partial<MessageDetail>): Promise<MessageDetail> => ({
  ...(await createFixtureIndexerClient().message(item.id))!,
  // The default evidence is for this identifier and this transaction.
  id: vector.expected.message.messageId,
  sourceTransactionHash: vector.expected.message.sourceTransactionHash,
  sourceChainId: 1,
  destinationChainId: 369,
  ...changes,
});

const renderPanel = async (input: { changes?: Partial<MessageDetail>; endpoints?: PanelEndpoints; transport?: PanelTransport; head?: (chainId: number) => Promise<bigint>; connected?: boolean }) => {
  const detail = await detailWith(input.changes ?? {});
  const { buildTestServices } = await import("../render");
  const indexer = { ...buildTestServices().indexer, message: async () => detail };
  const set = input.endpoints ?? NO_ENDPOINTS;
  return renderWithServices(
    <MessageView messageId={detail.id} />,
    { indexer, endpoints: () => set, ...(input.transport === undefined ? {} : { transport: input.transport }), readLightClientHead: input.head ?? (async () => HEAD) },
    undefined,
    { connected: input.connected ?? true },
  );
};

const INDEXER = "https://indexer.example.test";
const NODE = "https://node.example.test";
const BACKEND = "https://backend.example.test";
const ARCHIVE = "https://archive.example.test";

describe("messageStage", () => {
  it.each([
    ["sent", null, null, "sent"],
    ["waiting_for_finality", null, null, "waiting-for-finality"],
    ["covered", null, null, "covered"],
    ["delivered", null, null, "delivered"],
    ["failed_call", null, null, "delivered"],
    ["release_failed", null, null, "delivered"],
    ["sent", 10n, 10n, "covered"],
    ["waiting_for_finality", 11n, 10n, "covered"],
    ["waiting_for_finality", 9n, 10n, "waiting-for-finality"],
    ["sent", null, 10n, "sent"],
    ["sent", 10n, null, "sent"],
  ] as const)("status %s, head %s, source %s is %s", (status, headSlot, sourceSlot, expected) => {
    expect(messageStage({ status, headSlot, sourceSlot })).toBe(expected);
  });
});

describe("the proof panel", () => {
  it("shows where the message is", async () => {
    await renderPanel({ changes: { status: "waiting_for_finality" } });
    const list = await screen.findByTestId("stage-list");
    expect(within(list).getByText("Waiting for finality")).toHaveAttribute("aria-current", "step");
    expect(within(list).getByText("Sent")).not.toHaveAttribute("aria-current");
    expect(screen.getByTestId("stage-meaning")).toHaveTextContent("no head that covers it");
  });

  it("shows the latest proof from the msgboard indexer, or from the board when the indexer is unset", async () => {
    const message = proofMessage();
    const indexed = fakeTransport({ get: async () => ({ status: 200, body: { payload: encodeProofMessage(message), headCheckedAt: 1 } }) });
    const first = await renderPanel({ changes: { status: "waiting_for_finality" }, endpoints: endpoints({ msgboardIndexerUrl: INDEXER, msgboardUrl: NODE }), transport: indexed.transport });
    const proof = await screen.findByTestId("latest-proof");
    await waitFor(() => expect(proof).toHaveTextContent("msgboard indexer"));
    expect(proof).toHaveTextContent(`from slot ${HEAD} to slot ${HEAD + 64n}`);
    expect(proof).toHaveTextContent("reads it again before it posts");
    expect(indexed.gets).toContain(`${INDEXER}/proofs/latest/first-to-second`);
    expect(indexed.posts).toEqual([]);
    first.unmount();

    const board = fakeTransport({ post: async () => boardAnswer([encodeProofMessage(proofMessage({ newSlot: HEAD + 32n })), encodeProofMessage(message), "0xdead"]) });
    await renderPanel({ changes: { status: "waiting_for_finality" }, endpoints: endpoints({ msgboardUrl: NODE }), transport: board.transport });
    await waitFor(() => expect(screen.getByTestId("latest-proof")).toHaveTextContent("msgboard node"));
    expect(screen.getByTestId("latest-proof")).toHaveTextContent(`to slot ${HEAD + 64n}`);
    expect(screen.getByTestId("latest-proof")).not.toHaveTextContent("reads it again");
  });

  it("request a proof posts once and then shows the status", async () => {
    const user = userEvent.setup();
    const requests: string[] = [];
    const { transport } = fakeTransport({
      get: async (url) =>
        url.includes("/requests/r1")
          ? { status: 200, body: { jobId: "j1", direction: "first-to-second", status: "proving", createdAt: 1, updatedAt: 2, startSlot: null, newSlot: null, error: null, requestId: "r1", reason: "message", messageId: null, requestedAt: 1 } }
          : { status: 404, body: null },
      post: async (url, body) => {
        requests.push(`${url} ${body}`);
        return { status: 202, body: { requestId: "r1", jobId: "j1" } };
      },
    });
    await renderPanel({ changes: { status: "waiting_for_finality" }, endpoints: endpoints({ backendUrl: BACKEND }), transport });
    const button = await screen.findByRole("button", { name: "Request a proof" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByText("The prover is working on the proof.")).toBeInTheDocument();
    await user.click(button);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain(`${BACKEND}/requests`);
    expect(requests[0]).toContain('"direction":"first-to-second"');
    expect(requests[0]).toContain('"reason":"message"');
  });

  it("says when the backend limits requests, fails, or fails to show the status", async () => {
    const user = userEvent.setup();
    const limited = fakeTransport({ get: async () => ({ status: 404, body: null }), post: async () => ({ status: 429, body: { error: "rate-limited", retryAfterSeconds: 30 } }) });
    const first = await renderPanel({ changes: { status: "waiting_for_finality" }, endpoints: endpoints({ backendUrl: BACKEND }), transport: limited.transport });
    await user.click(await screen.findByRole("button", { name: "Request a proof" }));
    expect(await screen.findByText(/Try again in 30 seconds/)).toBeInTheDocument();
    first.unmount();

    const broken = fakeTransport({ get: async () => ({ status: 404, body: null }), post: async () => ({ status: 500, body: null }) });
    const second = await renderPanel({ changes: { status: "waiting_for_finality" }, endpoints: endpoints({ backendUrl: BACKEND }), transport: broken.transport });
    await user.click(await screen.findByRole("button", { name: "Request a proof" }));
    expect(await screen.findByText(/did not accept the request/)).toBeInTheDocument();
    second.unmount();

    const unreadable = fakeTransport({ get: async () => ({ status: 500, body: null }), post: async () => ({ status: 202, body: { requestId: "r2", jobId: "j" } }) });
    await renderPanel({ changes: { status: "waiting_for_finality" }, endpoints: endpoints({ backendUrl: BACKEND }), transport: unreadable.transport });
    await user.click(await screen.findByRole("button", { name: "Request a proof" }));
    expect(await screen.findByText("The status of the request did not load.")).toBeInTheDocument();
  });

  it("says when the backend sees nothing to prove, or cannot check its chain indexer", async () => {
    const user = userEvent.setup();
    const nothing = fakeTransport({ get: async () => ({ status: 404, body: null }), post: async () => ({ status: 409, body: { error: "nothing-to-prove" } }) });
    const first = await renderPanel({ changes: { status: "waiting_for_finality" }, endpoints: endpoints({ backendUrl: BACKEND }), transport: nothing.transport });
    await user.click(await screen.findByRole("button", { name: "Request a proof" }));
    expect(await screen.findByText(/The backend sees no message waiting for a proof/)).toBeInTheDocument();
    first.unmount();

    const unknown = fakeTransport({ get: async () => ({ status: 404, body: null }), post: async () => ({ status: 503, body: { error: "cannot-check", retryAfterSeconds: 30 } }) });
    await renderPanel({ changes: { status: "waiting_for_finality" }, endpoints: endpoints({ backendUrl: BACKEND }), transport: unknown.transport });
    await user.click(await screen.findByRole("button", { name: "Request a proof" }));
    expect(await screen.findByText(/could not check whether a proof is needed\. Try again in 30 seconds/)).toBeInTheDocument();
  });

  it("shows a failed request with its reason", async () => {
    const user = userEvent.setup();
    const { transport } = fakeTransport({
      get: async (url) =>
        url.includes("/requests/")
          ? { status: 200, body: { jobId: "j1", direction: "first-to-second", status: "failed", createdAt: 1, updatedAt: 2, startSlot: null, newSlot: null, error: "no capacity", requestId: "r1", reason: "message", messageId: null, requestedAt: 1 } }
          : { status: 404, body: null },
      post: async () => ({ status: 202, body: { requestId: "r1", jobId: "j1" } }),
    });
    await renderPanel({ changes: { status: "waiting_for_finality" }, endpoints: endpoints({ backendUrl: BACKEND }), transport });
    await user.click(await screen.findByRole("button", { name: "Request a proof" }));
    expect(await screen.findByText("The request failed.")).toBeInTheDocument();
    expect(screen.getByText("no capacity")).toBeInTheDocument();
  });

  it("post the light-client update sends update at the light client", async () => {
    const user = userEvent.setup();
    const { transport } = fakeTransport({ get: async () => ({ status: 200, body: { payload: encodeProofMessage(proofMessage()) } }) });
    await renderPanel({ changes: { status: "waiting_for_finality" }, endpoints: endpoints({ msgboardIndexerUrl: INDEXER }), transport });
    const button = await screen.findByRole("button", { name: "Post the light client update" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const review = await screen.findByTestId("confirm-review");
    expect(review).toHaveTextContent("update(bytes,bytes)");
    expect(review).toHaveTextContent(FIXTURE_PAIR.second.contracts.lightClient);
    expect(review).toHaveTextContent("BeaconLightClient (PulseChain)");
  });

  it("refuses to post when the light client head moved, and says so", async () => {
    const user = userEvent.setup();
    const { transport } = fakeTransport({ get: async () => ({ status: 200, body: { payload: encodeProofMessage(proofMessage()) } }) });
    const first = await renderPanel({ changes: { status: "waiting_for_finality" }, endpoints: endpoints({ msgboardIndexerUrl: INDEXER }), transport, head: async () => HEAD + 16n });
    const button = await screen.findByRole("button", { name: "Post the light client update" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByText(/head is now at slot 14100016, but this proof starts at slot 14100000/)).toBeInTheDocument();
    expect(screen.queryByTestId("confirm-review")).toBeNull();
    first.unmount();

    await renderPanel({ changes: { status: "waiting_for_finality" }, endpoints: endpoints({ msgboardIndexerUrl: INDEXER }), transport, head: async () => HEAD + 64n });
    const again = await screen.findByRole("button", { name: "Post the light client update" });
    await waitFor(() => expect(again).toBeEnabled());
    await user.click(again);
    expect(await screen.findByText(/already holds slot 14100064/)).toBeInTheDocument();
  });

  it("says plainly when the head cannot be read, or the proof cannot be planned", async () => {
    const user = userEvent.setup();
    const { transport } = fakeTransport({ get: async () => ({ status: 200, body: { payload: encodeProofMessage(proofMessage()) } }) });
    const first = await renderPanel({
      changes: { status: "waiting_for_finality" },
      endpoints: endpoints({ msgboardIndexerUrl: INDEXER }),
      transport,
      head: async () => {
        throw new Error("rpc down");
      },
    });
    const button = await screen.findByRole("button", { name: "Post the light client update" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByText(/could not read the head of the light client/)).toBeInTheDocument();
    first.unmount();
  });

  it("shows an error when the latest proof cannot be looked up, and lets the user clear and set a layout row twice", async () => {
    const user = userEvent.setup();
    const { buildTestServices } = await import("../render");
    const detail = await detailWith({ status: "covered" });
    const unknownPair = { ...FIXTURE_PAIR, id: "unknown-pair" };
    const { transport } = fakeTransport({ get: async (url) => (url.includes("/evidence/") ? { status: 200, body: evidenceOf() } : { status: 404, body: null }) });
    renderWithServices(<MessageView messageId={detail.id} />, {
      pair: unknownPair,
      indexer: { ...buildTestServices().indexer, message: async () => detail },
      endpoints: () => endpoints({ msgboardUrl: NODE, archiveUrl: ARCHIVE }),
      transport,
    });
    expect(await screen.findByText("The latest proof did not load.")).toBeInTheDocument();
    const box = within(await screen.findByTestId("delivery-steps")).getAllByRole("checkbox")[0]!;
    await user.click(box);
    expect(box).not.toBeChecked();
    await user.click(box);
    expect(box).toBeChecked();
  });

  it("deliver the message runs the prerequisites and then executeMessage from archive evidence", async () => {
    const user = userEvent.setup();
    const { transport, gets } = fakeTransport({ get: async (url) => (url.includes("/evidence/") ? { status: 200, body: evidenceOf() } : { status: 404, body: null }) });
    await renderPanel({ changes: { status: "covered" }, endpoints: endpoints({ archiveUrl: ARCHIVE }), transport });
    const button = await screen.findByRole("button", { name: "Deliver the message" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(gets.some((url) => url.startsWith(`${ARCHIVE}/evidence/`))).toBe(true);
    await user.click(button);
    expect(await screen.findByText("Step 1 of 2")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-review")).toHaveTextContent("addBlockHashLayout");
    await user.click(screen.getByRole("button", { name: "Send to wallet" }));
    expect(await screen.findByText("Step 2 of 2")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-review")).toHaveTextContent("executeMessage");
  });

  it("lets the user clear a layout row that the chain already holds", async () => {
    const user = userEvent.setup();
    const { transport } = fakeTransport({ get: async (url) => (url.includes("/evidence/") ? { status: 200, body: evidenceOf() } : { status: 404, body: null }) });
    await renderPanel({ changes: { status: "covered" }, endpoints: endpoints({ archiveUrl: ARCHIVE }), transport });
    const steps = await screen.findByTestId("delivery-steps");
    const boxes = within(steps).getAllByRole("checkbox");
    expect(boxes[1]).toBeDisabled();
    await user.click(boxes[0]!);
    await user.click(screen.getByRole("button", { name: "Deliver the message" }));
    expect(await screen.findByTestId("confirm-review")).toHaveTextContent("executeMessage");
    expect(screen.queryByText(/Step 1 of/)).toBeNull();
  });

  it("uses the backend for evidence when no archive is set", async () => {
    const { transport, gets } = fakeTransport({ get: async (url) => (url.includes("/evidence/") ? { status: 200, body: evidenceOf({ prerequisites: [] }) } : { status: 404, body: null }) });
    await renderPanel({ changes: { status: "covered" }, endpoints: endpoints({ backendUrl: BACKEND }), transport });
    await waitFor(() => expect(screen.getByRole("button", { name: "Deliver the message" })).toBeEnabled());
    expect(gets.some((url) => url.startsWith(`${BACKEND}/evidence/`))).toBe(true);
    expect(screen.queryByTestId("delivery-steps")).toBeNull();
  });

  it.each([
    ["a 404", { status: 404, body: null }, "The archive holds no evidence for this message."],
    ["a 503", { status: 503, body: null }, "The archive is not running on this backend."],
    ["another status", { status: 500, body: null }, "The archive answered with status 500."],
    ["a body that is not an object", { status: 200, body: "text" }, "The archive answered with status 200."],
    ["evidence for another chain", { status: 200, body: evidenceOf({ destination: { chainId: 56, bridge, lightClient: bridge } }) }, "The evidence cannot be used:"],
  ])("explains %s in plain words and does not crash", async (_name, answer, text) => {
    const { transport } = fakeTransport({ get: async (url) => (url.includes("/evidence/") ? answer : { status: 404, body: null }) });
    await renderPanel({ changes: { status: "covered" }, endpoints: endpoints({ archiveUrl: ARCHIVE }), transport });
    await waitFor(() => expect(screen.getByTestId("why-deliver-off")).toHaveTextContent(text));
    expect(screen.getByRole("button", { name: "Deliver the message" })).toBeDisabled();
  });

  it("explains an archive that does not answer", async () => {
    const { transport } = fakeTransport({
      get: async (url) => {
        if (url.includes("/evidence/")) throw new Error("offline");
        return { status: 404, body: null };
      },
    });
    await renderPanel({ changes: { status: "covered" }, endpoints: endpoints({ archiveUrl: ARCHIVE }), transport });
    await waitFor(() => expect(screen.getByTestId("why-deliver-off")).toHaveTextContent("The archive did not answer."));
  });

  it("with no backend set, the buttons explain which setting is missing", async () => {
    await renderPanel({ changes: { status: "waiting_for_finality" } });
    expect(await screen.findByRole("button", { name: "Request a proof" })).toBeDisabled();
    expect(screen.getByTestId("why-request-off")).toHaveTextContent("Set the Backend URL in Connections");
    expect(screen.getByRole("button", { name: "Post the light client update" })).toBeDisabled();
    expect(screen.getByTestId("why-update-off")).toHaveTextContent("Msgboard indexer URL");
    expect(screen.getByRole("button", { name: "Deliver the message" })).toBeDisabled();
    expect(screen.getByTestId("why-deliver-off")).toHaveTextContent("does not cover this message yet");
    await waitFor(() => expect(screen.getByTestId("latest-proof")).toHaveTextContent("No msgboard indexer is set."));
    expect(screen.getByTestId("latest-proof")).toHaveTextContent("No msgboard node is set.");
  });

  it("says why each button is off at each stage", async () => {
    const first = await renderPanel({ changes: { status: "sent" }, endpoints: endpoints({ backendUrl: BACKEND }), transport: fakeTransport({ get: async () => ({ status: 404, body: null }) }).transport });
    expect(await screen.findByTestId("why-request-off")).toHaveTextContent("not final yet");
    first.unmount();
    const second = await renderPanel({ changes: { status: "covered" }, endpoints: endpoints({ backendUrl: BACKEND }), transport: fakeTransport({ get: async () => ({ status: 404, body: null }) }).transport });
    expect(await screen.findByTestId("why-request-off")).toHaveTextContent("already covers");
    expect(screen.getByTestId("why-update-off")).toHaveTextContent("already covers");
    second.unmount();
    // A delivered message has nothing left to prove or deliver: the page leaves the panel out.
    await renderPanel({ changes: { status: "delivered" }, endpoints: endpoints({ backendUrl: BACKEND }), transport: fakeTransport({ get: async () => ({ status: 404, body: null }) }).transport });
    expect(await screen.findByText("Delivered on PulseChain")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Proof and delivery" })).toBeNull();
  });

  it("asks for a wallet before a write action", async () => {
    const { transport } = fakeTransport({ get: async (url) => (url.includes("/evidence/") ? { status: 200, body: evidenceOf() } : { status: 200, body: { payload: encodeProofMessage(proofMessage()) } }) });
    const first = await renderPanel({ changes: { status: "waiting_for_finality" }, endpoints: endpoints({ msgboardIndexerUrl: INDEXER }), transport, connected: false });
    await waitFor(() => expect(screen.getByTestId("why-update-off")).toHaveTextContent("Connect a wallet to post the update."));
    first.unmount();
    await renderPanel({ changes: { status: "covered" }, endpoints: endpoints({ archiveUrl: ARCHIVE }), transport, connected: false });
    await waitFor(() => expect(screen.getByTestId("why-deliver-off")).toHaveTextContent("Connect a wallet to deliver the message."));
  });

  it("says the evidence is loading, and that the proof did not load", async () => {
    const hang = fakeTransport({ get: () => new Promise<Answer>(() => undefined) });
    const first = await renderPanel({ changes: { status: "covered" }, endpoints: endpoints({ archiveUrl: ARCHIVE, msgboardIndexerUrl: INDEXER }), transport: hang.transport });
    expect(await screen.findByTestId("why-deliver-off")).toHaveTextContent("The evidence is loading.");
    expect(screen.getByText("Looking for the latest proof…")).toBeInTheDocument();
    first.unmount();
  });

  it("falls back to the board when the indexer is unreachable, and ends at the indexer when it holds nothing", async () => {
    const onBoard = proofMessage();
    const fallback = fakeTransport({
      get: async () => {
        throw new Error("offline");
      },
      post: async () => boardAnswer([encodeProofMessage(onBoard)]),
    });
    const first = await renderPanel({ changes: { status: "waiting_for_finality" }, endpoints: endpoints({ msgboardIndexerUrl: INDEXER, msgboardUrl: NODE }), transport: fallback.transport });
    await waitFor(() => expect(screen.getByTestId("latest-proof")).toHaveTextContent("msgboard node"));
    first.unmount();

    const empty = fakeTransport({ get: async () => ({ status: 404, body: null }), post: async () => boardAnswer([encodeProofMessage(onBoard)]) });
    await renderPanel({ changes: { status: "waiting_for_finality" }, endpoints: endpoints({ msgboardIndexerUrl: INDEXER, msgboardUrl: NODE }), transport: empty.transport });
    await waitFor(() => expect(screen.getByTestId("latest-proof")).toHaveTextContent("holds no usable proof"));
    expect(empty.posts).toEqual([]);
  });
});


const read = (set: Partial<Record<keyof PanelEndpoints, string>>, transport: PanelTransport, headSlot: bigint | null = HEAD, direction: "first-to-second" | "second-to-first" = "first-to-second") =>
  readLatestProof({ endpoints: endpoints(set), pair: "eth-pls", direction, headSlot, transport });

describe("the other direction", () => {
  it("asks for the proof that follows the chain of the send, posts it to the first chain, and closes the review on Cancel", async () => {
    const user = userEvent.setup();
    const heads: number[] = [];
    const reverse = proofMessage({ direction: "second-to-first" });
    const { transport, gets } = fakeTransport({ get: async () => ({ status: 200, body: { payload: encodeProofMessage(reverse) } }) });
    await renderPanel({
      changes: { status: "waiting_for_finality", sourceChainId: 369, destinationChainId: 1 },
      endpoints: endpoints({ msgboardIndexerUrl: INDEXER }),
      transport,
      head: async (chainId) => {
        heads.push(chainId);
        return HEAD;
      },
    });
    const button = await screen.findByRole("button", { name: "Post the light client update" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(gets).toContain(`${INDEXER}/proofs/latest/second-to-first`);
    await user.click(button);
    expect(await screen.findByTestId("confirm-review")).toHaveTextContent(FIXTURE_PAIR.first.contracts.lightClient);
    expect(heads).toEqual([1]);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("confirm-review")).toBeNull());
  });
});

describe("readLatestProof", () => {
  it.each([
    ["a 503", async () => ({ status: 503, body: null }), "The msgboard indexer cannot tell now. Try again later."],
    ["another status", async () => ({ status: 500, body: null }), "The msgboard indexer answered with status 500."],
    ["a body that is not an object", async () => ({ status: 200, body: "x" }), "The msgboard indexer gave an answer of an unknown shape."],
    ["a body with no payload", async () => ({ status: 200, body: { nothing: true } }), "The msgboard indexer gave an answer of an unknown shape."],
    ["a payload that does not decode", async () => ({ status: 200, body: { payload: "0x1234" } }), "The msgboard indexer gave a proof that does not decode (wrong-version)."],
    ["a proof for the other direction", async () => ({ status: 200, body: { payload: encodeProofMessage(proofMessage({ direction: "second-to-first" })) } }), "The msgboard indexer gave a proof for another route."],
  ])("names %s, then asks the board", async (_name, answer, note) => {
    const onBoard = proofMessage({ newSlot: HEAD + 32n });
    const { transport } = fakeTransport({ get: answer, post: async () => boardAnswer([encodeProofMessage(onBoard)]) });
    expect(await read({ msgboardIndexerUrl: INDEXER, msgboardUrl: NODE }, transport)).toEqual({ kind: "found", source: "msgboard node", message: onBoard, headCheckedAt: null, notes: [note] });
  });

  it("keeps the proof that starts at the head and reaches furthest, in any order, and drops the rest", async () => {
    const far = proofMessage({ newSlot: HEAD + 64n });
    const short = proofMessage({ newSlot: HEAD + 16n });
    const wrongStart = proofMessage({ startSlot: HEAD - 100n, newSlot: HEAD + 500n });
    const wrongDirection = proofMessage({ direction: "second-to-first", newSlot: HEAD + 900n });
    const { transport } = fakeTransport({ post: async () => boardAnswer([short, far, short, wrongStart, wrongDirection].map((message) => encodeProofMessage(message))) });
    const reading = await read({ msgboardUrl: NODE }, transport);
    expect(reading).toMatchObject({ kind: "found", message: far, notes: ["No msgboard indexer is set."] });
  });

  it("with no head known, the proof that reaches furthest wins", async () => {
    const far = proofMessage({ startSlot: HEAD - 100n, newSlot: HEAD + 500n });
    const { transport } = fakeTransport({ post: async () => boardAnswer([encodeProofMessage(proofMessage()), encodeProofMessage(far)]) });
    expect(await read({ msgboardUrl: NODE }, transport, null)).toMatchObject({ kind: "found", message: far });
  });

  it("says when the board holds no proof at the head, or does not answer", async () => {
    const stale = fakeTransport({ post: async () => boardAnswer([encodeProofMessage(proofMessage({ startSlot: HEAD - 100n }))]) });
    expect(await read({ msgboardUrl: NODE }, stale.transport)).toEqual({ kind: "none", notes: ["No msgboard indexer is set.", "The msgboard node holds no proof that starts at the stored head."] });
    const down = fakeTransport({ post: async () => Promise.reject(new Error("offline")) });
    expect(await read({ msgboardUrl: NODE }, down.transport)).toEqual({ kind: "none", notes: ["No msgboard indexer is set.", "The msgboard node did not give its messages."] });
  });

  it("names no URL in any note", async () => {
    const down = fakeTransport({ get: async () => Promise.reject(new Error(`cannot reach ${INDEXER}`)), post: async () => Promise.reject(new Error(`cannot reach ${NODE}`)) });
    const reading = await read({ msgboardIndexerUrl: INDEXER, msgboardUrl: NODE }, down.transport);
    expect(JSON.stringify(reading)).not.toContain("example.test");
  });
});

describe("readEvidence", () => {
  it("refuses a message identifier that is not 32 bytes, without asking the network", async () => {
    const { transport, gets } = fakeTransport({});
    expect(await readEvidence({ endpoints: endpoints({ archiveUrl: ARCHIVE }), messageId: "0x12", transport })).toEqual({ kind: "none", note: "A message identifier is 0x and 64 hex digits." });
    expect(gets).toEqual([]);
  });

  it("names the missing setting when neither an archive nor a backend is set", async () => {
    const { transport } = fakeTransport({});
    expect(await readEvidence({ endpoints: NO_ENDPOINTS, messageId: word("c"), transport })).toEqual({ kind: "none", note: "No archive is set. Set the Archive URL in Connections." });
  });
});

const EXPECTED = { messageId: vector.expected.message.messageId, sourceTransactionHash: vector.expected.message.sourceTransactionHash };

describe("planDelivery against the message that the user views", () => {
  const found = (changes: Record<string, unknown> = {}) => ({ kind: "found", text: JSON.stringify(evidenceOf(changes)) }) as const;
  const otherMessage = { message: { ...(evidenceOf().message as Record<string, unknown>), messageId: word("f") } };

  it("refuses evidence for another message identifier and gives the reason", () => {
    expect(planDelivery(found(), FIXTURE_PAIR, { ...EXPECTED, messageId: word("f") })).toEqual({ kind: "unavailable", reason: "The evidence is for a different message." });
  });

  it("refuses evidence whose labels name another message than its proof delivers", () => {
    expect(planDelivery(found(otherMessage), FIXTURE_PAIR, { ...EXPECTED, messageId: word("f") })).toMatchObject({ kind: "unavailable", reason: expect.stringContaining("messageId in the file") });
  });

  it("refuses evidence with the same identifier but another source transaction", () => {
    expect(planDelivery(found(), FIXTURE_PAIR, { ...EXPECTED, sourceTransactionHash: word("9") })).toEqual({ kind: "unavailable", reason: "The evidence is for a different source transaction." });
  });

  it("compares the identifier in lowercase", () => {
    const upper = `0x${EXPECTED.messageId.slice(2).toUpperCase()}`;
    expect(planDelivery(found(), FIXTURE_PAIR, { ...EXPECTED, messageId: upper }).kind).toBe("ready");
  });

  it("skips the transaction check when the detail has no transaction hash", () => {
    expect(planDelivery(found(), FIXTURE_PAIR, { ...EXPECTED, sourceTransactionHash: null }).kind).toBe("ready");
  });

  it("stays ready for matching evidence", () => {
    expect(planDelivery(found(), FIXTURE_PAIR, EXPECTED).kind).toBe("ready");
  });

  it("keeps the deliver button off in the panel when the archive sends another message", async () => {
    const { transport } = fakeTransport({ get: async (url) => (url.includes("/evidence/") ? { status: 200, body: evidenceOf() } : { status: 404, body: null }) });
    await renderPanel({ changes: { status: "covered", id: word("f") }, endpoints: endpoints({ archiveUrl: ARCHIVE }), transport });
    await waitFor(() => expect(screen.getByTestId("why-deliver-off")).toHaveTextContent("The evidence is for a different message."));
    expect(screen.getByRole("button", { name: "Deliver the message" })).toBeDisabled();
  });
});

describe("the plans", () => {
  it("plans the update on the first chain for the other direction", () => {
    const message = proofMessage({ direction: "second-to-first" });
    expect(planProofUpdate(message, FIXTURE_PAIR).plan.to).toBe(FIXTURE_PAIR.first.contracts.lightClient);
    expect(planProofUpdate(proofMessage(), FIXTURE_PAIR).plan.to).toBe(FIXTURE_PAIR.second.contracts.lightClient);
  });

  it("refuses a proof whose public values disagree with its slots", () => {
    expect(() => planProofUpdate({ ...proofMessage(), newRoot: word("f") }, FIXTURE_PAIR)).toThrow(/newHeadRoot/);
  });

  it("turns a file that is not JSON into a reason, not a crash", () => {
    expect(planDelivery({ kind: "found", text: "{" }, FIXTURE_PAIR, EXPECTED)).toEqual({ kind: "unavailable", reason: "The evidence cannot be used: The file is not valid JSON." });
  });

  it("asks for a backend before it allows a proof request", () => {
    expect(requestProofAvailability({ stage: "waiting-for-finality", backendSet: false, walletConnected: true, proof: null, delivery: null })).toEqual({ enabled: false, reason: "Set the Backend URL in Connections to ask for a proof." });
  });
});

describe("chosenDeliverySteps", () => {
  const row = (data: Hex, role: "prerequisite" | "execute" = "prerequisite") => ({ step: { plan: { data } }, role, reason: null }) as unknown as DeliveryStep;
  const a = row("0xaa");
  const b = row("0xbb");
  const run = row("0xee", "execute");

  it("leaves out the rows that the user cleared, by their calldata", () => {
    expect(chosenDeliverySteps([a, b, run], ["0xaa"]).map((step) => step.plan.data)).toEqual(["0xbb", "0xee"]);
  });

  it("keeps a needed row when the list changes under a cleared one", () => {
    // The user cleared row a. The next read of the evidence drops a and puts b first: b must still run.
    expect(chosenDeliverySteps([b, run], ["0xaa"]).map((step) => step.plan.data)).toEqual(["0xbb", "0xee"]);
  });

  it("always keeps the execution", () => {
    expect(chosenDeliverySteps([a, run], ["0xaa", "0xee"]).map((step) => step.plan.data)).toEqual(["0xee"]);
  });
});
