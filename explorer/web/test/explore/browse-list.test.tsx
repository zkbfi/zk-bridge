import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { BrowseAddress, BrowseClient, BrowseCounts, BrowseMessage, BrowsePage, BrowseProof, BrowseToken } from "@zk-bridge/shared";
import { Shell } from "../../src/app/Shell";
import { createFixtureExploreSource } from "../../src/explore/explore-fixture";
import type { ExploreSource } from "../../src/explore/explore-source";
import { connectedWallet, renderWithWallet } from "../app/support";

const pair = FIXTURE_PAIR;
const ADDRESS = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const NOW = 1_800_000_000;

const page = <T,>(items: T[], total: number, offset = 0, asOf = NOW - 120): BrowsePage<T> => ({ items, total, limit: 50, offset, asOf });

const message = (n: number, overrides: Partial<BrowseMessage> = {}): BrowseMessage => ({
  id: hash(n),
  kind: "token",
  status: "delivered",
  sourceChainId: pair.first.chainId,
  destinationChainId: pair.second.chainId,
  sender: ADDRESS,
  recipient: ADDRESS,
  token: { chainId: pair.first.chainId, address: ADDRESS, symbol: "USDT", decimals: 6 },
  amount: 46_610_000n,
  sentAt: NOW - 3600,
  deliveredAt: NOW - 1800,
  sourceTransactionHash: hash(1000 + n),
  ...overrides,
});

const counts: BrowseCounts = {
  asOf: NOW,
  messages: { total: 1284, inFlight: 3, transfers: 1200, plain: 84, byStatus: {}, directions: [] },
  lightClientUpdates: { total: 221, chains: [] },
  addresses: { total: 412, senders: 200, recipients: 300, posters: 2 },
  tokens: { total: 9, chains: [] },
  contracts: 12,
  gates: { total: 2, open: 1 },
  escrow: { entries: 5 },
};

type Fakes = { messages: ReturnType<typeof vi.fn>; proofs: ReturnType<typeof vi.fn>; tokens: ReturnType<typeof vi.fn>; addresses: ReturnType<typeof vi.fn>; counts: ReturnType<typeof vi.fn> };

const fakes = (): Fakes => ({
  counts: vi.fn(async () => counts),
  messages: vi.fn(async () => page([message(1), message(2, { kind: "message", token: null, amount: null, status: "sent", sourceTransactionHash: null })], 1284)),
  proofs: vi.fn(async () =>
    page<BrowseProof>(
      [
        { number: 221, chainId: pair.second.chainId, slot: 11_521_312n, timestamp: NOW - 700, transactionHash: hash(5), poster: ADDRESS, costWei: 1n },
        { number: 140, chainId: pair.first.chainId, slot: 11_263_392n, timestamp: NOW - 4000, transactionHash: hash(6), poster: ADDRESS, costWei: 1n },
      ],
      221,
    ),
  ),
  tokens: vi.fn(async () => page<BrowseToken>([{ chainId: pair.second.chainId, address: ADDRESS, symbol: "zUSDT", name: null, decimals: 6, isBridgedCopy: true, transfers: 1 }, { chainId: pair.first.chainId, address: ADDRESS, symbol: null, name: null, decimals: null, isBridgedCopy: false, transfers: 3 }], 9)),
  addresses: vi.fn(async () =>
    page<BrowseAddress>([{ address: ADDRESS, sent: 2, received: 1, posted: 3, lastActive: NOW - 90_000 }, { address: "0x00000000000000000000000000000000000000aa", sent: 0, received: 0, posted: 1, lastActive: null }, { address: "0x00000000000000000000000000000000000000bb", sent: 4, received: 0, posted: 0, lastActive: NOW - 10 }], 412),
  ),
});

let browse: Fakes;
const open = (hashText: string, patch: Partial<Fakes> = {}) => {
  browse = { ...fakes(), ...patch };
  const explore: ExploreSource = { ...createFixtureExploreSource(), browse: browse as unknown as BrowseClient };
  window.history.replaceState(null, "", hashText);
  return renderWithWallet(<Shell />, { wallet: connectedWallet(), services: { pair, explore, now: () => NOW } });
};
const go = (hashText: string) =>
  act(() => {
    window.location.hash = hashText;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
/** A pill that opens a menu: its name starts with the filter's label ("Status", or "Status: In flight" once set). */
const pill = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}(:|\\d|$)`) });
/** Opens the pill's menu and picks one row of it. */
const choose = async (name: string, row: string | RegExp) => {
  await userEvent.click(pill(name));
  await userEvent.click(within(screen.getByRole("menu", { name })).getByRole("menuitemradio", { name: row }));
};
/** Opens the Filters menu, then one filter's page of it. */
const openFilter = async (label: string) => {
  await userEvent.click(pill("Filters"));
  await userEvent.click(within(screen.getByRole("menu", { name: "Filters" })).getByRole("menuitem", { name: new RegExp(`^${label}`) }));
};
const lastRequest = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0] as Record<string, unknown>;

beforeEach(() => window.localStorage.clear());

describe("the transfers list", () => {
  it("shows the total in the header, each row linking to its transaction, and a message without a transaction linking to the message", async () => {
    open("#/explore/browse/transfers");
    const amount = await screen.findByRole("link", { name: /46\.61 USDT/ });
    expect(screen.getByRole("heading", { name: /Transfers & messages/ })).toHaveTextContent("1,284 in total");
    expect(amount).toHaveAttribute("href", `#/explore/tx/${pair.first.chainId}/${hash(1001)}`);
    expect(within(amount).getByText("delivered")).toHaveClass("zb-xstatus");
    expect(within(amount).getByText("1 h ago")).toBeInTheDocument();
    const plain = screen.getByRole("link", { name: /Message 0x00000000…0002/ });
    expect(plain).toHaveAttribute("href", `#/message/${hash(2)}`);
    expect(screen.getByRole("status")).toHaveTextContent("1–2 of 1,284 · as of 2 min ago");
    expect(browse.messages).toHaveBeenCalledWith(expect.objectContaining({ limit: 50, offset: 0, sort: "newest", asOf: undefined }));
  });

  it("pages by 50 with First, Previous, Next, Last and 'Page x of y', each a link that holds the page in the address", async () => {
    open("#/explore/browse/transfers");
    const pager = await screen.findByRole("navigation", { name: "Pages" });
    expect(pager).toHaveTextContent("Page 1 of 26");
    expect(within(pager).getByText("First")).toHaveAttribute("aria-disabled", "true");
    expect(within(pager).getByText("Previous")).toHaveAttribute("aria-disabled", "true");
    expect(within(pager).getByRole("link", { name: "Next" })).toHaveAttribute("href", "#/explore/browse/transfers?page=2");
    expect(within(pager).getByRole("link", { name: "Last" })).toHaveAttribute("href", "#/explore/browse/transfers?page=26");
  });

  it("keeps the snapshot while paging, so rows that arrive meanwhile do not shift the pages", async () => {
    open("#/explore/browse/transfers");
    await screen.findByRole("navigation", { name: "Pages" });
    go("#/explore/browse/transfers?page=2");
    await waitFor(() => expect(lastRequest(browse.messages)).toMatchObject({ offset: 50, asOf: NOW - 120 }));
    const pager = await screen.findByRole("navigation", { name: "Pages" });
    await waitFor(() => expect(pager).toHaveTextContent("Page 2 of 26"));
    expect(within(pager).getByRole("link", { name: "First" })).toHaveAttribute("href", "#/explore/browse/transfers");
    expect(within(pager).getByRole("link", { name: "Previous" })).toHaveAttribute("href", "#/explore/browse/transfers");
  });

  it("takes a new snapshot on refresh", async () => {
    open("#/explore/browse/transfers?page=2");
    await screen.findByRole("navigation", { name: "Pages" });
    await userEvent.click(screen.getByRole("button", { name: "refresh" }));
    await waitFor(() => expect(browse.messages).toHaveBeenCalledTimes(2));
    expect(lastRequest(browse.messages).asOf).toBeUndefined();
  });

  it("filters by a menu, writes it to the address, and starts again from page 1", async () => {
    open("#/explore/browse/transfers?page=3");
    await screen.findByRole("navigation", { name: "Pages" });
    await choose("Status", "In flight");
    expect(window.location.hash).toBe("#/explore/browse/transfers?status=inflight");
    go(window.location.hash);
    await waitFor(() => expect(lastRequest(browse.messages)).toMatchObject({ status: "inflight", offset: 0 }));
    expect(await screen.findByRole("heading", { name: /Transfers & messages/ })).toHaveTextContent("1,284 match");
    expect(pill("Status")).toHaveTextContent("Status: In flight");
    // The active filter shows as a removable chip, and the pill closed after the pick, giving focus back to itself.
    expect(screen.getByRole("button", { name: "Remove filter Status: In flight" })).toBeInTheDocument();
    expect(screen.queryByRole("menu")).toBeNull();
    // With in-flight rows the oldest first sort is the one that shows what waited longest.
    await userEvent.click(pill("Sort"));
    expect(within(screen.getByRole("menu", { name: "Sort" })).getByRole("menuitemradio", { name: "Waiting longest first" })).toBeEnabled();
  });

  it("has no native select anywhere, and offers the filters in sequence: pills for the primary ones, the rest in a Filters menu", async () => {
    open("#/explore/browse/transfers");
    await screen.findByRole("navigation", { name: "Pages" });
    expect(document.querySelector("select")).toBeNull();
    for (const name of ["Sent from", "Status", "Filters", "Sort"]) expect(pill(name)).toHaveAttribute("aria-haspopup", "menu");
    // Type, Token, Time and Address wait inside the Filters menu, in that order, each opening its own options.
    await userEvent.click(pill("Filters"));
    const rows = within(screen.getByRole("menu", { name: "Filters" })).getAllByRole("menuitem");
    expect(rows.map((row) => row.textContent?.replace(/Any$/, ""))).toEqual(["Type", "Token", "Time", "Address"]);
    await userEvent.click(rows[0] as HTMLElement);
    const options = within(screen.getByRole("menu", { name: "Filters" })).getAllByRole("menuitemradio");
    expect(options.map((option) => option.textContent)).toEqual(["Transfers and messages", "Transfers", "Messages"]);
  });

  it("holds the amount sorts back until a token is chosen", async () => {
    open("#/explore/browse/transfers");
    await screen.findByRole("navigation", { name: "Pages" });
    await userEvent.click(pill("Sort"));
    const sort = within(screen.getByRole("menu", { name: "Sort" }));
    expect(sort.getByRole("menuitemradio", { name: "Largest amount first (choose a token)" })).toHaveAttribute("aria-disabled", "true");
    expect(sort.getByRole("menuitemradio", { name: "Newest first" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(sort.getByRole("menuitemradio", { name: "Largest amount first (choose a token)" }));
    expect(window.location.hash).toBe("#/explore/browse/transfers");
    await userEvent.keyboard("{Escape}");
    await openFilter("Token");
    const token = within(screen.getByRole("menu", { name: "Filters" })).getAllByRole("menuitemradio")[1] as HTMLElement;
    await userEvent.click(token);
    expect(window.location.hash).toContain("token=");
    go(window.location.hash);
    await userEvent.click(pill("Sort"));
    expect(within(screen.getByRole("menu", { name: "Sort" })).getByRole("menuitemradio", { name: "Largest amount first" })).not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(within(screen.getByRole("menu", { name: "Sort" })).getByRole("menuitemradio", { name: "Largest amount first" }));
    expect(window.location.hash).toContain("sort=amount-high");
  });

  it("works from the keyboard: Down opens, arrows move, Enter picks, Escape closes and gives focus back to the pill", async () => {
    open("#/explore/browse/transfers");
    await screen.findByRole("navigation", { name: "Pages" });
    const status = pill("Status");
    status.focus();
    await userEvent.keyboard("{ArrowDown}");
    const menu = screen.getByRole("menu", { name: "Status" });
    expect(within(menu).getByRole("menuitemradio", { name: "Any status" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(within(menu).getByRole("menuitemradio", { name: "Delivered" })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(status).toHaveFocus();
    expect(window.location.hash).toBe("#/explore/browse/transfers");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(window.location.hash).toBe("#/explore/browse/transfers?status=inflight");
    expect(status).toHaveFocus();
    // In the Filters menu Right opens a filter and Left goes back to the list.
    pill("Filters").focus();
    await userEvent.keyboard("{ArrowDown}{ArrowRight}");
    expect(within(screen.getByRole("menu", { name: "Filters" })).getByRole("menuitem", { name: "Filters" })).toBeInTheDocument();
    await userEvent.keyboard("{ArrowLeft}");
    expect(within(screen.getByRole("menu", { name: "Filters" })).getByRole("menuitem", { name: /^Type/ })).toBeInTheDocument();
  });

  it("moves to the first and last row with Home and End, closes on Tab, and closes when focus leaves", async () => {
    open("#/explore/browse/transfers");
    await screen.findByRole("navigation", { name: "Pages" });
    await userEvent.click(pill("Status"));
    const menu = within(screen.getByRole("menu", { name: "Status" }));
    await userEvent.keyboard("{End}");
    expect(menu.getByRole("menuitemradio", { name: "Failed" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(menu.getByRole("menuitemradio", { name: "Any status" })).toHaveFocus();
    await userEvent.keyboard("{Tab}");
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(pill("Sort"));
    expect(screen.getByRole("menu", { name: "Sort" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("heading", { name: /Transfers & messages/ }));
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(pill("Sort"));
    await userEvent.click(pill("Sort"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("types an address start in the Filters menu: Home and End move the caret in the box, and a refused value cannot be applied", async () => {
    open("#/explore/browse/addresses");
    await screen.findByRole("navigation", { name: "Pages" }).catch(() => undefined);
    await openFilter("Starts with");
    const box = screen.getByRole("textbox", { name: "Starts with" });
    await userEvent.type(box, "zz");
    await userEvent.keyboard("{Home}{End}");
    expect(box).toHaveFocus();
    await userEvent.click(screen.getByRole("menuitem", { name: "Apply" }));
    expect(window.location.hash).toBe("#/explore/browse/addresses");
    expect(screen.getByRole("menu", { name: "Filters" })).toBeInTheDocument();
  });

  it("shows a filter value the menu does not list (a token this release does not carry) as it was written", async () => {
    const unknown = `first:0x${"0".repeat(39)}1`;
    open(`#/explore/browse/transfers?token=${unknown}`);
    expect(await screen.findByRole("button", { name: `Remove filter Token: ${unknown}` })).toBeInTheDocument();
  });

  it("shows active filters as chips that remove one at a time, and a counter on the Filters pill", async () => {
    open("#/explore/browse/transfers?status=delivered&kind=token");
    const chips = within(await screen.findByRole("list", { name: "Active filters" }));
    expect(chips.getByRole("button", { name: "Remove filter Status: Delivered" })).toBeInTheDocument();
    expect(pill("Filters")).toHaveTextContent("Filters1");
    await userEvent.click(chips.getByRole("button", { name: "Remove filter Type: Transfers" }));
    expect(window.location.hash).toBe("#/explore/browse/transfers?status=delivered");
  });

  it("filters by an address typed in full, and says why a short one is refused", async () => {
    open("#/explore/browse/transfers");
    await screen.findByRole("navigation", { name: "Pages" });
    await openFilter("Address");
    const box = screen.getByRole("textbox", { name: "Address" });
    await userEvent.type(box, "0x12");
    expect(await screen.findByRole("alert")).toHaveTextContent("An address is 0x followed by 40 hex characters.");
    await userEvent.type(box, "{Enter}");
    expect(window.location.hash).toBe("#/explore/browse/transfers");
    await userEvent.clear(box);
    await userEvent.type(box, `${ADDRESS}{Enter}`);
    expect(window.location.hash).toBe(`#/explore/browse/transfers?account=${ADDRESS}`);
    go(window.location.hash);
    await waitFor(() => expect(lastRequest(browse.messages)).toMatchObject({ address: ADDRESS }));
    expect(screen.getByRole("button", { name: /^Remove filter Address: 0x709979…79c8$/ })).toBeInTheDocument();
    await openFilter("Address");
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue(ADDRESS);
    await userEvent.clear(screen.getByRole("textbox", { name: "Address" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Apply" }));
    expect(window.location.hash).toBe("#/explore/browse/transfers");
  });

  it("clears every filter at once", async () => {
    open("#/explore/browse/transfers?status=delivered&kind=token");
    await userEvent.click(await screen.findByRole("button", { name: "Clear all" }));
    expect(window.location.hash).toBe("#/explore/browse/transfers");
  });

  it("says what an empty list means, with and without filters", async () => {
    open("#/explore/browse/transfers", { messages: vi.fn(async () => page<BrowseMessage>([], 0)) });
    expect(await screen.findByText(/No transfers and messages on this pair yet\. They appear here as the indexer reads them from the chains\./)).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
  });

  it("says when filters match nothing and offers to clear them", async () => {
    open("#/explore/browse/transfers?status=failed", { messages: vi.fn(async () => page<BrowseMessage>([], 0)) });
    expect(await screen.findByText(/No transfers and messages match these filters/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "clear them" }));
    expect(window.location.hash).toBe("#/explore/browse/transfers");
  });

  it("says when the page asked for is past the end, and links to the last page", async () => {
    open("#/explore/browse/transfers?page=9", { messages: vi.fn(async () => page<BrowseMessage>([], 120, 400)) });
    expect(await screen.findByText(/Page 9 is past the end: these filters match 120 transfers and messages, 3 pages\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the last page" })).toHaveAttribute("href", "#/explore/browse/transfers?page=3");
  });

  it("says 1 page when the page asked for is past the end of a short list", async () => {
    open("#/explore/browse/transfers?page=3", { messages: vi.fn(async () => page<BrowseMessage>([], 10, 100)) });
    expect(await screen.findByText(/these filters match 10 transfers and messages, 1 page\./)).toBeInTheDocument();
  });

  it("says it is loading, and what failed when the indexer does not answer, and tries again on request", async () => {
    let calls = 0;
    const messages = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) throw new Error("The indexer answered 503 for /api/browse/messages.");
      return page([message(1)], 1);
    });
    open("#/explore/browse/transfers?status=delivered", { messages });
    expect(screen.getByText(/Loading transfers and messages…/)).toBeInTheDocument();
    const alert = await screen.findByRole("alert", {}, { timeout: 4000 });
    expect(alert).toHaveTextContent("The indexer did not answer (The indexer answered 503 for /api/browse/messages.). Your filters are kept.");
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: /46\.61 USDT/ })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1–1 of 1");
  }, 10_000);

  it("names an error that is not an Error", async () => {
    open("#/explore/browse/transfers", { messages: vi.fn(async () => Promise.reject("down")) });
    expect(await screen.findByRole("alert", {}, { timeout: 4000 })).toHaveTextContent("unknown error");
  }, 10_000);

  it("keeps the rows of the last answer when a refresh fails, and says so", async () => {
    let calls = 0;
    const messages = vi.fn(async () => {
      calls += 1;
      if (calls > 1) throw new Error("down");
      return page([message(1)], 1);
    });
    open("#/explore/browse/transfers", { messages });
    await screen.findByRole("link", { name: /46\.61 USDT/ });
    await userEvent.click(screen.getByRole("button", { name: "refresh" }));
    expect(await screen.findByText(/The last refresh failed; these rows are from the last answer\./, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /46\.61 USDT/ })).toBeInTheDocument();
  }, 10_000);

  it("shows a transfer whose token facts are unknown as a message", async () => {
    open("#/explore/browse/transfers", { messages: vi.fn(async () => page([message(3, { token: { chainId: 1, address: ADDRESS, symbol: null, decimals: null } }), message(4, { sentAt: null, token: null })], 2)) });
    expect(await screen.findAllByRole("link", { name: /Message 0x00000000…000[34]/ })).toHaveLength(2);
  });
});

describe("the proofs list", () => {
  it("lists the proofs with their number, slot and age, filters by chain and poster, and sorts by slot", async () => {
    open("#/explore/browse/proofs");
    const row = await screen.findByRole("link", { name: /Proof #221/ });
    expect(row).toHaveAttribute("href", `#/explore/proof/${pair.second.chainId}/221`);
    expect(row).toHaveTextContent("slot 11,521,312 · 12 min ago");
    expect(screen.getByRole("link", { name: /Proof #140/ })).toHaveAttribute("href", `#/explore/proof/${pair.first.chainId}/140`);
    expect(screen.getByRole("heading", { name: /Proofs/ })).toHaveTextContent("221 in total");
    expect(pill("Posted on")).toBeInTheDocument();
    await choose("Sort", "Highest slot first");
    expect(window.location.hash).toBe("#/explore/browse/proofs?sort=slot-high");
    await openFilter("Poster");
    await userEvent.type(screen.getByRole("textbox", { name: "Poster" }), `${ADDRESS}{Enter}`);
    expect(window.location.hash).toContain(`poster=${ADDRESS}`);
    await choose("Posted on", pair.second.name);
    expect(window.location.hash).toContain("chain=second");
  });
});

describe("the tokens list", () => {
  it("lists tokens with their chain, kind and transfers, filters by chain and kind, and sorts by transfers", async () => {
    open("#/explore/browse/tokens");
    const copy = await screen.findByRole("link", { name: /zUSDT/ });
    expect(copy).toHaveAttribute("href", `#/explore/token/second/${ADDRESS}`);
    expect(copy).toHaveTextContent("bridged copy · 1 transfer");
    expect(screen.getByRole("link", { name: /3 transfers/ })).toHaveAttribute("href", `#/explore/token/first/${ADDRESS}`);
    expect(screen.getByRole("link", { name: /0x70997970…79c8/ })).toHaveTextContent("native");
    expect(screen.queryByRole("button", { name: "Filters" })).toBeNull();
    await choose("Kind", "Bridged copies");
    expect(window.location.hash).toBe("#/explore/browse/tokens?kind=copy");
    await choose("Sort", "Most transfers");
    expect(window.location.hash).toContain("sort=transfers");
  });
});

describe("the addresses list", () => {
  it("lists addresses with what they did, filters by role and start, and sorts by activity", async () => {
    open("#/explore/browse/addresses");
    const row = await screen.findByRole("link", { name: /0x70997970…79c8/ });
    expect(row).toHaveAttribute("href", `#/explore/address/${ADDRESS}`);
    expect(row).toHaveTextContent("2 sent · 1 received · 3 proofs posted · last yesterday");
    expect(screen.getByRole("link", { name: /0x00000000…00aa/ })).toHaveTextContent("1 proofs posted");
    await choose("Role", "Proof posters");
    expect(window.location.hash).toBe("#/explore/browse/addresses?role=poster");
    await openFilter("Starts with");
    await userEvent.type(screen.getByRole("textbox", { name: "Starts with" }), "zz{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Type the start of an address, hex characters only.");
    await userEvent.clear(screen.getByRole("textbox", { name: "Starts with" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Starts with" }), "0x70{Enter}");
    expect(window.location.hash).toContain("q=0x70");
  });
});

describe("the other browse pages keep their short lists", () => {
  it("lists the contracts of the pair without paging", async () => {
    open("#/explore/browse/contracts");
    expect(await screen.findByRole("heading", { name: /Contracts/ })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
  });
});

describe("the gates and the pages that are not lists", () => {
  it("lists the gates with their state, and says when a kind has none", async () => {
    open("#/explore/browse/gates");
    expect(await screen.findAllByRole("link", { name: /Gate on/ })).toHaveLength(2);
    window.history.replaceState(null, "", "#/explore/browse/releases");
    go("#/explore/browse/releases");
    expect(await screen.findByText("None yet on this pair.")).toBeInTheDocument();
    go("#/explore/browse/zebras");
    expect(await screen.findByRole("heading", { name: /zebras/ })).toBeInTheDocument();
  });
});

describe("the browse tiles", () => {
  it("show the all-time counts from the indexer, not the length of what the page loaded", async () => {
    open("#/explore");
    const transfers = await screen.findByRole("link", { name: /Transfers & messages/ });
    await waitFor(() => expect(transfers.querySelector(".zb-tile-n")).toHaveTextContent("1,284"));
    expect(transfers).toHaveTextContent("3 in flight");
    const text = (title: RegExp) => screen.getByRole("link", { name: title });
    expect(text(/Proofs/).querySelector(".zb-tile-n")).toHaveTextContent("221");
    expect(text(/Tokens/).querySelector(".zb-tile-n")).toHaveTextContent("9");
    expect(text(/Addresses/).querySelector(".zb-tile-n")).toHaveTextContent("412");
    expect(text(/Contracts/).querySelector(".zb-tile-n")).toHaveTextContent("12");
    expect(text(/Gates & escrow/)).toHaveTextContent("1 open · 5 escrowed");
  });

  it("show a dash while the counts load, and the numbers of what the page loaded, labelled, when the indexer has no counts", async () => {
    open("#/explore", { counts: vi.fn(async () => Promise.reject(new Error("The indexer answered 404 for /api/counts."))) });
    const transfers = await screen.findByRole("link", { name: /Transfers & messages/ });
    expect(transfers.querySelector(".zb-tile-n")).toHaveTextContent("—");
    await waitFor(() => expect(transfers).toHaveTextContent(/latest \d+ · \d+ in flight/), { timeout: 4000 });
    expect(screen.getByRole("link", { name: /Proofs/ })).toHaveTextContent(/latest \d+ · light-client updates/);
    expect(screen.getByRole("link", { name: /Addresses/ })).toHaveTextContent("in the latest transfers and proofs");
  }, 10_000);
});

describe("the browse bar on a phone", () => {
  it("wraps its pills and chips and stacks the pager under 520 px", async () => {
    const css = (await import("node:fs")).readFileSync(`${import.meta.dirname}/../../src/explore/explore.css`, "utf8");
    expect(css).toMatch(/\.zb-bbar \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.zb-bpager \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.zb-bchips \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/@media \(max-width: 520px\) \{[^}]*\.zb-bpage/);
    fireEvent.resize(window);
  });
});
