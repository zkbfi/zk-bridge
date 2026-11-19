import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedItem } from "@terminal/model/types";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { ActivityScreen } from "../../src/bridge/ActivityScreen";
import { addPending, clearPending } from "../../src/bridge/pending";
import { buildTestServices } from "../render";
import { connectedWallet, disconnectedWallet, renderWithWallet } from "../app/support";

const NOW = Math.floor(Date.now() / 1000);
const item = (overrides: Partial<FeedItem>): FeedItem =>
  ({
    id: `0x${"aa".repeat(32)}`,
    kind: "token",
    direction: "first-to-second",
    status: "delivered",
    sender: "0x52908400098527886E0F7030069857D2E4169EE7",
    recipient: "0x52908400098527886E0F7030069857D2E4169EE7",
    token: FIXTURE_TOKENS[0]!,
    amount: 10n ** 18n,
    sentAt: NOW - 3600,
    deliveredAt: NOW - 3000,
    sourceTransactionHash: `0x${"11".repeat(32)}`,
    destinationTransactionHash: `0x${"22".repeat(32)}`,
    ...overrides,
  }) as FeedItem;

const renderFeed = (feed: readonly FeedItem[], extra: { readonly nativeBalance?: bigint; readonly wallet?: ReturnType<typeof connectedWallet> } = {}) => {
  const base = buildTestServices();
  return renderWithWallet(<ActivityScreen />, {
    wallet: extra.wallet ?? connectedWallet(),
    services: {
      dataSource: { ...base.dataSource, getFeed: async () => ({ items: feed, hasMore: false }) },
      ...(extra.nativeBalance === undefined
        ? {}
        : { chainAccess: { ...base.chainAccess, readSnapshots: async () => FIXTURE_PAIR.first && [{ status: "ok" as const, snapshot: { chain: FIXTURE_PAIR.second, nativeBalance: extra.nativeBalance!, positions: [] } }] } }),
    },
  });
};

beforeEach(() => clearPending());
afterEach(() => clearPending());

describe("the Activity screen without a wallet", () => {
  it("asks to connect and connects on the button", async () => {
    const connect = vi.fn(async () => undefined);
    renderFeed([], { wallet: disconnectedWallet({ connect }) });
    expect(screen.getByText("Connect a wallet to see your transfers.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(connect).toHaveBeenCalledOnce();
  });
});

describe("the Activity screen after a disconnect", () => {
  it("shows no transfers, not even one just submitted", () => {
    addPending({ sourceTransactionHash: `0x${"98".repeat(32)}`, direction: "first-to-second", token: FIXTURE_TOKENS[0]!, amount: 1n, sentAt: NOW });
    renderFeed([], { wallet: disconnectedWallet() });
    expect(screen.queryByText(/Sent · /)).toBeNull();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeInTheDocument();
  });
});

describe("the Activity screen with a wallet", () => {
  it("says there are no transfers when the feed is empty", async () => {
    renderFeed([]);
    expect(await screen.findByText("No transfers yet.")).toBeInTheDocument();
  });

  it("shows a message with no token as a card named Message, and filters by tab", async () => {
    renderFeed([
      item({ id: `0x${"01".repeat(32)}`, kind: "message", status: "waiting_for_finality", token: null, amount: null, deliveredAt: null } as Partial<FeedItem>),
      item({ id: `0x${"02".repeat(32)}`, status: "delivered" }),
    ]);
    const card = await screen.findByRole("region", { name: /^Message from / });
    expect(within(card).getByText("Message", { selector: "b" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Delivered" }));
    expect(screen.queryByRole("region", { name: /^Message from / })).toBeNull();
    expect(screen.getByRole("button", { name: /ago/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "In flight" }));
    expect(screen.getByRole("region", { name: /^Message from / })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ago/ })).toBeNull();
  });

  it("groups delivered rows by day, falls back to the send time when there is no delivery time, and opens and closes a row", async () => {
    renderFeed([
      item({ id: `0x${"03".repeat(32)}` }),
      item({ id: `0x${"04".repeat(32)}`, sentAt: NOW - 3 * 86_400, deliveredAt: NOW - 3 * 86_400 + 60 }),
      item({ id: `0x${"05".repeat(32)}`, sentAt: NOW - 3 * 86_400 - 600, deliveredAt: null }),
      item({ id: `0x${"06".repeat(32)}`, kind: "message", token: null, amount: null, sentAt: NOW - 3 * 86_400 - 900, deliveredAt: null } as Partial<FeedItem>),
    ]);
    expect(await screen.findByText("Today")).toBeInTheDocument();
    const rows = screen.getAllByRole("button", { expanded: false });
    expect(rows).toHaveLength(4);
    await userEvent.click(rows[3]!);
    const again = screen.getByRole("link", { name: "Bridge again" });
    expect(again.getAttribute("href")).not.toContain("token");
    await userEvent.click(rows[3]!);
    expect(screen.queryByRole("link", { name: "Bridge again" })).toBeNull();
    await userEvent.click(rows[0]!);
    expect(screen.getByRole("link", { name: "Bridge again" }).getAttribute("href")).toContain("token");
    expect(screen.queryByText(/ fee \(/)).toBeNull();
  });

  it("does not show a delivery that left the tokens in the router, or handed them off, as a plain delivery", async () => {
    const delivery = { token: null, fee: null, received: null, handOffReason: null, handOffRefused: false, callFailed: null } as const;
    renderFeed([
      item({ id: `0x${"0a".repeat(32)}`, callbackFailed: true, delivery }),
      item({ id: `0x${"0b".repeat(32)}`, delivery: { ...delivery, received: 0n, handOffReason: "PayoutRefused" } }),
      item({ id: `0x${"0c".repeat(32)}`, delivery: { ...delivery, received: 5n, callFailed: { target: "0x00000000000000000000000000000000000000c1", recipient: "0x00000000000000000000000000000000000000c2", callGas: 50_000n } } }),
      item({ id: `0x${"0d".repeat(32)}` }),
    ]);
    await screen.findByText("Today");
    expect(screen.getAllByTestId("activity-outcome-tag").map((tag) => tag.textContent)).toEqual(["Tokens in the router", "Handed off", "Call failed"]);
    const rows = screen.getAllByRole("button", { expanded: false });
    await userEvent.click(rows[0]!);
    expect(screen.getByTestId("activity-outcome")).toHaveTextContent("the recipient received nothing. They wait in the router until anyone calls sweep");
    expect(screen.getByRole("img", { name: /^Tokens reached the router on .*, its callback failed$/ })).toBeInTheDocument();
  });

  it("lists a transfer just submitted, and drops it once the feed has its transaction", async () => {
    const hash = `0x${"99".repeat(32)}` as const;
    addPending({ sourceTransactionHash: hash, direction: "first-to-second", token: FIXTURE_TOKENS[0]!, amount: 5n * 10n ** 18n, sentAt: NOW });
    renderFeed([item({ id: hash, sourceTransactionHash: hash.toUpperCase().replace("0X", "0x") as typeof hash })]);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /ago/ })).toHaveLength(1));
    expect(screen.queryByText(/Sent · waiting for finality/)).toBeNull();
  });

  it("holds the delivery link back with the reason when the destination balance is short, shown on hover and focus", async () => {
    renderFeed([item({ id: `0x${"07".repeat(32)}`, status: "covered", sentAt: NOW - 41 * 60, deliveredAt: null })], { nativeBalance: 0n });
    const link = (await screen.findByText(/Deliver it yourself/)).closest("a")!;
    await waitFor(() => expect(link).toHaveAttribute("aria-disabled", "true"));
    expect(link).not.toHaveAttribute("href");
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.hover(link);
    expect(screen.getByRole("tooltip")).toHaveTextContent(/Add .* on .* to deliver it yourself/);
    await userEvent.unhover(link);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => link.focus());
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    act(() => link.blur());
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("links the delivery to the message when the destination balance covers the gas, with no tooltip", async () => {
    const id = `0x${"08".repeat(32)}` as const;
    renderFeed([item({ id, status: "covered", sentAt: NOW - 41 * 60, deliveredAt: null })], { nativeBalance: 10n ** 20n });
    const link = await screen.findByRole("link", { name: /Deliver it yourself/ });
    await waitFor(() => expect(link).toHaveAttribute("href"));
    expect(link.getAttribute("href")).toContain(id);
    await userEvent.hover(link);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
