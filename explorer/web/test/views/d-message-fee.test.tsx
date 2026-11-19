import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildFixtureFeed, FIXTURE_NOW } from "@terminal/data/fixtures";
import { createFixtureIndexerClient } from "../../src/data/fixture-indexer-client";
import type { MessageDetail } from "../../src/data/message-detail";
import { MessageView } from "../../src/views/MessageView";
import { buildTestServices } from "../render";
import { renderWithServices } from "./support";

const feed = buildFixtureFeed(FIXTURE_NOW);
const tokenItem = feed.find((item) => item.kind === "token" && item.status === "delivered" && item.direction === "first-to-second")!;
const router = "0x00000000000000000000000000000000000000e7";

const renderWithDelivery = async (delivery: NonNullable<NonNullable<MessageDetail["transfer"]>["delivery"]>) => {
  const detail = (await createFixtureIndexerClient().message(tokenItem.id))!;
  const shown: MessageDetail = { ...detail, transfer: { ...detail.transfer!, delivery } };
  renderWithServices(<MessageView messageId={tokenItem.id} />, { indexer: { ...buildTestServices().indexer, message: async () => shown } });
  return screen.findByRole("button", { name: /^Fee/ });
};

describe("the fee line of a router delivery", () => {
  it("says the indexer does not record the fee when a delivery read from the logs has none", async () => {
    const fee = await renderWithDelivery({ router, amount: 5n, fee: null, received: null, deliverer: null, recipient: null, source: "logs", handOffReason: null, handOffRefused: false, callFailed: null });
    expect(fee.querySelector(".zb-xv b span")).toHaveAttribute("title", "The indexer does not record this yet");
  });

  it("shows the fee without a share when what the recipient received is not known", async () => {
    const fee = await renderWithDelivery({ router, amount: 5n, fee: 5n, received: null, deliverer: null, recipient: null, source: "logs", handOffReason: null, handOffRefused: false, callFailed: null });
    const figure = fee.querySelector(".zb-xv b")!;
    expect(figure.textContent).not.toContain("%");
    expect(figure.textContent).toMatch(/\d/);
  });
});
