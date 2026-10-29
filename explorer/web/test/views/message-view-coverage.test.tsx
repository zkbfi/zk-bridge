import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildFixtureFeed, FIXTURE_NOW } from "@terminal/data/fixtures";
import { createFixtureIndexerClient } from "../../src/data/fixture-indexer-client";
import type { MessageDetail } from "../../src/data/message-detail";
import { MessageView } from "../../src/views/MessageView";
import { buildTestServices } from "../render";
import { never, renderWithServices } from "./support";

const feed = buildFixtureFeed(FIXTURE_NOW);
const fixtureClient = createFixtureIndexerClient();

const tokenItem = feed.find((item) => item.kind === "token" && item.status === "delivered")!;
const messageItem = feed.find((item) => item.kind === "message")!;

const detailOf = async (id: MessageDetail["id"]): Promise<MessageDetail> => (await fixtureClient.message(id))!;

const renderDetail = (detail: MessageDetail | null) =>
  renderWithServices(<MessageView messageId={detail?.id ?? tokenItem.id} />, { indexer: { ...buildTestServices().indexer, message: async () => detail } });

describe("the message view", () => {
  it("says Loading while the message is in flight", () => {
    renderWithServices(<MessageView messageId={tokenItem.id} />, { indexer: { ...buildTestServices().indexer, message: never } });
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows the error when the message does not load", async () => {
    renderWithServices(<MessageView messageId={tokenItem.id} />, {
      indexer: {
        ...buildTestServices().indexer,
        message: async () => {
          throw new Error("indexer down");
        },
      },
    });
    expect(await screen.findByText("The message did not load: indexer down")).toBeInTheDocument();
  });

  it("says that the indexer does not know a message that it has not seen", async () => {
    renderDetail(null);
    expect(await screen.findByText(/The indexer does not know the message/)).toHaveTextContent(tokenItem.id);
  });

  it("shows a delivered transfer with every fact of both chains", async () => {
    const detail = await detailOf(tokenItem.id);
    renderDetail(detail);
    expect(await screen.findByRole("heading", { name: "Transfer", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Sent on " + (detail.sourceChainId === 1 ? "Ethereum" : "PulseChain") })).toBeInTheDocument();
    expect(screen.getByText("succeeded")).toBeInTheDocument();
    expect(screen.getByText("Amounts and recipient")).toBeInTheDocument();
    expect(screen.getByText("Head slot")).toBeInTheDocument();
    expect(screen.getByText("no")).toBeInTheDocument();
    expect(screen.getAllByText(detail.executedBy!).length).toBeGreaterThan(0);
  });

  it("shows a message with its target and gas, and says unknown for a missing gas limit", async () => {
    const detail = await detailOf(messageItem.id);
    const first = renderDetail({ ...detail, gasLimit: null });
    expect(await screen.findByRole("heading", { name: "Message", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Target and gas")).toBeInTheDocument();
    expect(screen.getByText("Gas").nextSibling).toHaveTextContent("unknown");
    first.unmount();
    renderDetail({ ...detail, gasLimit: 2_000_000 });
    expect(await screen.findByText("2000000")).toBeInTheDocument();
  });

  it("says a send is not yet covered and not yet delivered", async () => {
    const detail = await detailOf(tokenItem.id);
    renderDetail({ ...detail, coveredByHeadSlot: null, coveredAt: null, deliveredAt: null, destinationTransactionHash: null, deliverySucceeded: null, executedBy: null });
    expect(await screen.findByText(/Not yet\. The light client on/)).toBeInTheDocument();
    expect(screen.getByText("Not delivered yet.")).toBeInTheDocument();
  });

  it("says unknown for the facts that the indexer did not record, and shows a reverted call", async () => {
    const detail = await detailOf(tokenItem.id);
    const transfer = { ...detail.transfer!, deliveredValue: null };
    renderDetail({ ...detail, coveredAt: null, destinationTransactionHash: null, deliverySucceeded: false, executedBy: null, transfer });
    expect(await screen.findByText("reverted")).toBeInTheDocument();
    expect(screen.getAllByText("unknown")).toHaveLength(3);
    expect(screen.getByText("not yet")).toBeInTheDocument();
  });

  it("says unknown for a call outcome that the indexer did not record", async () => {
    const detail = await detailOf(tokenItem.id);
    renderDetail({ ...detail, deliverySucceeded: null, transfer: { ...detail.transfer!, hasCallback: true } });
    expect(await screen.findByText("unknown")).toBeInTheDocument();
    expect(screen.getByText("yes")).toBeInTheDocument();
  });

  it("shows no fallback row and no claim row when the release was paid", async () => {
    const detail = await detailOf(tokenItem.id);
    renderDetail({ ...detail, releaseFailed: false });
    expect(await screen.findByText("Amounts and recipient")).toBeInTheDocument();
    expect(screen.queryByText("Fallback")).toBeNull();
    expect(screen.queryByText("Claim")).toBeNull();
    expect(screen.queryByText("Release")).toBeNull();
  });

  it("says that a failed release is final and that the tokens stay in the mediator", async () => {
    const detail = await detailOf(tokenItem.id);
    renderDetail({ ...detail, releaseFailed: true });
    const row = (await screen.findByText("Release")).nextSibling;
    expect(row).toHaveTextContent("The release failed and is final. The tokens stay in the mediator.");
    expect(screen.queryByText("Claim")).toBeNull();
    expect(screen.queryByText(/claim\(/)).toBeNull();
  });

  it("names a chain that is not in the pair by its identifier", async () => {
    const detail = await detailOf(tokenItem.id);
    renderDetail({ ...detail, sourceChainId: 56 });
    expect(await screen.findByRole("region", { name: "Sent on chain 56" })).toBeInTheDocument();
  });

  it("shows the proof panel with the stage of the message", async () => {
    const detail = await detailOf(tokenItem.id);
    renderDetail({ ...detail, status: "waiting_for_finality" });
    expect(await screen.findByRole("region", { name: "Proof and delivery" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request a proof" })).toBeInTheDocument();
  });
});
