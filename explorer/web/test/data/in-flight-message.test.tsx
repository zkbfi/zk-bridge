import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { parseMessageDetail, type MessageDetail } from "../../src/data/message-detail";
import { arrivingAs, MessageView } from "../../src/views/MessageView";
import { buildTestServices } from "../render";
import { renderWithServices } from "../views/support";

// rc17: `#/message/<id>` failed with "The transfer.destinationToken is not an object." for an in-flight transfer. The
// indexer, rebuilt on the new contracts, answers `destinationToken: null` until the first delivery deploys the copy, and
// null for every delivery-fee field until a router delivers. This is that answer from indexer.zkb.fi (943 → Sepolia,
// 30.5 tUSD, sent, not covered), with the user addresses replaced.
const answer: unknown = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "in-flight-message.json"), "utf8"));

describe("an in-flight transfer whose destination token is not known yet", () => {
  it("parses: the destination token and the delivery are null, the rest is read", () => {
    const detail = parseMessageDetail(answer);
    expect(detail.status).toBe("sent");
    expect(detail.deliveredAt).toBeNull();
    expect(detail.transfer).toMatchObject({ sourceToken: { symbol: "tUSD", decimals: 6, chainId: 943 }, destinationToken: null, value: 30_500_000n, deliveredValue: null, hasCallback: true, delivery: null });
    expect(arrivingAs(detail.transfer!)).toEqual({ symbol: "ztUSD", decimals: 6 });
  });

  it("reads an absent destination token and absent fee fields the same as null", () => {
    const { destinationToken: _token, fee: _fee, received: _received, deliverer: _deliverer, feeSource: _source, routerAmount: _amount, finalRecipient: _final, deliveryRouter: _router, ...transfer } = (answer as { transfer: Record<string, unknown> }).transfer;
    const detail = parseMessageDetail({ ...(answer as object), transfer });
    expect(detail.transfer).toMatchObject({ destinationToken: null, delivery: null });
  });

  it("reads null fee fields beside a router as unknown, not as an error", () => {
    const transfer = { ...(answer as { transfer: Record<string, unknown> }).transfer, deliveryRouter: "0x00000000000000000000000000000000000000d1" };
    expect(parseMessageDetail({ ...(answer as object), transfer }).transfer?.delivery).toEqual({ router: "0x00000000000000000000000000000000000000D1", amount: null, fee: null, received: null, deliverer: null, recipient: null, source: null });
  });

  it("a bridged copy going home arrives as its native token", () => {
    const detail = parseMessageDetail(answer);
    const copy = { ...detail.transfer!, sourceToken: { ...detail.transfer!.sourceToken, symbol: "zUSDC", isBridgedCopy: true } };
    expect(arrivingAs(copy).symbol).toBe("USDC");
  });

  it("the message page loads and says what it arrives as once delivered", async () => {
    const detail: MessageDetail = parseMessageDetail(answer);
    renderWithServices(<MessageView messageId={detail.id} />, { indexer: { ...buildTestServices().indexer, message: async () => detail } });
    expect(await screen.findByText("Token transfer")).toBeInTheDocument();
    expect(screen.queryByText(/did not load/)).toBeNull();
    expect(screen.getByText("arrives as ztUSD once delivered")).toBeInTheDocument();
  });

  it("a delivered transfer whose destination token is still unknown shows the amount with the copy's symbol", async () => {
    const parsed = parseMessageDetail(answer);
    const detail: MessageDetail = { ...parsed, status: "delivered", deliveredAt: parsed.sentAt + 600, transfer: { ...parsed.transfer!, deliveredValue: 30_500_000n } };
    renderWithServices(<MessageView messageId={detail.id} />, { indexer: { ...buildTestServices().indexer, message: async () => detail } });
    expect(await screen.findByText("Token transfer")).toBeInTheDocument();
    const received = screen.getByText("Received on", { exact: false }).closest(".zb-kv") as HTMLElement;
    expect(received).toHaveTextContent("30.5");
    expect(received).toHaveTextContent("ztUSD");
  });
});
