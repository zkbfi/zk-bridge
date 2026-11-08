import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FeedItem } from "@terminal/model/types";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { groupOf, NEEDS_YOU_AFTER_SECONDS, positionOf, stepsOf, stepWords, txUrl } from "../../src/bridge/activity-model";
import { ActivityPulse } from "../../src/bridge/ActivityScreen";
import { addPending, clearPending } from "../../src/bridge/pending";
import { buildTestServices } from "../render";
import { connectedWallet, renderWithWallet } from "../app/support";

const NOW = Math.floor(Date.now() / 1000);
const item = (overrides: Partial<FeedItem>): FeedItem =>
  ({
    id: `0x${"aa".repeat(32)}`,
    kind: "token",
    direction: "first-to-second",
    status: "sent",
    sender: "0x52908400098527886E0F7030069857D2E4169EE7",
    recipient: "0x52908400098527886E0F7030069857D2E4169EE7",
    token: FIXTURE_TOKENS[0]!,
    amount: 10n ** 18n,
    sentAt: NOW - 120,
    deliveredAt: null,
    sourceTransactionHash: `0x${"11".repeat(32)}`,
    destinationTransactionHash: null,
    ...overrides,
  }) as FeedItem;

beforeEach(() => clearPending());
afterEach(() => clearPending());

describe("the activity model", () => {
  it("groups transfers: in flight, needs you (proven and stuck, or failed), delivered", () => {
    expect(groupOf(item({ status: "waiting_for_finality" }), NOW)).toBe("in-flight");
    expect(stepWords(item({ status: "covered", sentAt: NOW - 3 * 86_400 }), FIXTURE_PAIR.second, NOW)).toBe("Proven · waiting for a deliverer for 3 days");
    expect(groupOf(item({ status: "covered", sentAt: NOW - NEEDS_YOU_AFTER_SECONDS - 1 }), NOW)).toBe("needs-you");
    expect(groupOf(item({ status: "release_failed" }), NOW)).toBe("needs-you");
    expect(groupOf(item({ status: "delivered", deliveredAt: NOW }), NOW)).toBe("delivered");
    expect(positionOf("delivered")).toBe(1);
  });

  it("links reached steps to the chain's explorer and leaves future steps without a link", () => {
    const detail = stepsOf(item({ status: "covered" }), FIXTURE_PAIR);
    expect(detail.current).toBe(2);
    expect(detail.steps[0]!.href).toBe(txUrl(FIXTURE_PAIR.first.chainId, `0x${"11".repeat(32)}`));
    expect(detail.steps.at(-1)!.href).toBeUndefined();
  });
});

describe("the pulse at real pixel size", () => {
  it("is drawn in solid colours: the lit part ends at the pill; the destination lights when delivered", () => {
    const { container, rerender } = render(<ActivityPulse position={0.5} label="Final" />);
    expect(container.innerHTML).not.toMatch(/opacity/);
    expect(container.querySelector(".zb-apulse-pill")).not.toBeNull();
    expect(container.querySelector('[data-end="destination"]')?.getAttribute("data-lit")).toBe("false");
    rerender(<ActivityPulse position={1} label="Delivered" />);
    expect(container.querySelector(".zb-apulse-pill")).toBeNull();
    expect(container.querySelector('[data-end="destination"]')?.getAttribute("data-lit")).toBe("true");
  });
});

describe("the Activity screen", () => {
  const feed = [
    item({ id: `0x${"01".repeat(32)}`, status: "waiting_for_finality" }),
    item({ id: `0x${"02".repeat(32)}`, status: "covered", sentAt: NOW - 41 * 60 }),
    item({ id: `0x${"03".repeat(32)}`, status: "delivered", sentAt: NOW - 3600, deliveredAt: NOW - 3000, destinationTransactionHash: `0x${"22".repeat(32)}` }),
  ];
  const renderActivity = () => {
    window.history.replaceState(null, "", "#/activity");
    const base = buildTestServices();
    return renderWithWallet(<Shell />, { wallet: connectedWallet(), services: { dataSource: { ...base.dataSource, getFeed: async () => ({ items: feed, hasMore: false }) } } });
  };

  it("names the screen, shows flat tabs with the needs-you count, a card per transfer in flight, and delivered rows", async () => {
    renderActivity();
    expect(screen.getByTestId("page-name")).toHaveTextContent("Activity");
    await waitFor(() => expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["All", "In flight", "Needs you1", "Delivered"]));
    await waitFor(() => expect(document.querySelectorAll(".zb-acard")).toHaveLength(2));
    expect(screen.getByText(/waiting for a deliverer for 41 min/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Deliver it yourself/ })).toBeInTheDocument();
  });

  it("says that a failed release is final and offers no delivery for it", async () => {
    window.history.replaceState(null, "", "#/activity");
    const base = buildTestServices();
    const failed = [item({ id: `0x${"04".repeat(32)}`, status: "release_failed", sentAt: NOW - 3600 })];
    renderWithWallet(<Shell />, { wallet: connectedWallet(), services: { dataSource: { ...base.dataSource, getFeed: async () => ({ items: failed, hasMore: false }) } } });
    await waitFor(() => expect(screen.getByText(/the release failed\. This is final/)).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /Deliver it yourself/ })).toBeNull();
  });

  it("opens a delivered row in place to the joined steps with explorer links, and Bridge again", async () => {
    renderActivity();
    const row = await screen.findByRole("button", { expanded: false, name: /ago/ });
    await userEvent.click(row);
    const links = await screen.findAllByRole("link", { name: /on the explorer/ });
    expect(links.length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Bridge again" })).toBeInTheDocument();
  });

  it("opens a delivered row to its delivery fee line when a delivery router delivered it", async () => {
    window.history.replaceState(null, "", "#/activity");
    const base = buildTestServices();
    const token = FIXTURE_TOKENS[0]!;
    const unit = 10n ** BigInt(token.decimals);
    const delivered = [
      item({ id: `0x${"05".repeat(32)}`, status: "delivered", amount: (123n * unit) / 10n, sentAt: NOW - 3600, deliveredAt: NOW - 3000, delivery: { token, fee: (123n * unit) / 10_000n, received: (122_877n * unit) / 10_000n } }),
    ];
    renderWithWallet(<Shell />, { wallet: connectedWallet(), services: { dataSource: { ...base.dataSource, getFeed: async () => ({ items: delivered, hasMore: false }) } } });
    await userEvent.click(await screen.findByRole("button", { expanded: false, name: /ago/ }));
    expect(await screen.findByText(/^12\.3 \S+ sent · 0\.0123 \S+ fee \(0\.1%\) · 12\.2877 \S+ received$/)).toBeInTheDocument();
  });

  it("shows a just-submitted transfer as sent before the indexer has it", async () => {
    addPending({ sourceTransactionHash: `0x${"99".repeat(32)}`, direction: "first-to-second", token: FIXTURE_TOKENS[0]!, amount: 5n * 10n ** 18n, sentAt: NOW });
    renderActivity();
    await waitFor(() => expect(screen.getAllByText(/Sent · waiting for finality/).length).toBeGreaterThan(0));
  });
});

describe("the sideways slide", () => {
  it("moves between Activity, Bridge and Explore with the arrow keys, and the address follows", async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}`);
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    await screen.findByRole("region", { name: /You send from/ });
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(window.location.hash).toBe("#/activity"));
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    await waitFor(() => expect(window.location.hash).toBe("#/explore"));
    expect(within(document.body).getByTestId("page-name")).toHaveTextContent("Explore");
  });
});
