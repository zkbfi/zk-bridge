import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ChainLog, ChainReader, HistoryFilters, JsonFetcher, JsonResponse } from "@zk-bridge/shared";
import type { Route } from "../../src/app/route";
import { HistoryPage, HistoryView } from "../../src/views/HistoryView";
import { EMPTY_HISTORY_FILTERS, unkeptScan, type HistoryDependencies } from "../../src/views/history-model";
import { fakeConnections, liveServices, sharedPairForTests } from "../support/live";
import { renderWithServices } from "./support";

const hash = (byte: string): `0x${string}` => `0x${byte.repeat(32)}`;
const MESSAGE = hash("ab");

const sentEvent = { kind: "sent", chainId: 1, timestamp: 1_800_000_100, transactionHash: hash("a1"), messageId: MESSAGE, slot: null, status: "covered" };
const deliveredEvent = { kind: "delivered", chainId: 369, timestamp: 1_800_000_200, transactionHash: hash("b2"), messageId: MESSAGE, slot: null, status: "delivered" };
const headEvent = { kind: "head-update", chainId: 369, timestamp: 1_800_000_300, transactionHash: hash("c3"), messageId: null, slot: 4_000, status: null };

const answer = (items: unknown[], nextCursor: string | null = null): JsonResponse => ({ status: 200, body: { items, nextCursor, partial: false } });

/** Records every URL and answers with the page of the test. */
const indexerFetcher = (respond: (url: string) => JsonResponse) => {
  const urls: string[] = [];
  const fetchJson: JsonFetcher = async (url) => {
    urls.push(url);
    return respond(url);
  };
  return { urls, fetchJson };
};

/** A chain that holds the given logs, at head 200 with one second per block. */
const readerWith = (logs: readonly Omit<ChainLog, "address" | "logIndex">[]): ChainReader => ({
  getChainId: async () => 1,
  getBlock: async (selector) => ("tag" in selector ? { number: 200n, timestamp: 2_000n, baseFeePerGas: null } : { number: selector.blockNumber, timestamp: 1_800_000_000n + selector.blockNumber, baseFeePerGas: null }),
  getLogs: async (request) => {
    const names = new Set(request.events.map((event) => event.name));
    return logs
      .filter((log) => names.has(log.eventName) && log.blockNumber >= request.fromBlock && log.blockNumber <= request.toBlock)
      .map((log, logIndex) => ({ ...log, address: request.address, logIndex }));
  },
  readContract: async () => undefined,
  getTransactionReceipt: async () => {
    throw new Error("not used");
  },
});

/** Counts the log requests of every reader that a page makes. */
const countingDependencies = (base: HistoryDependencies) => {
  const counter = { requests: 0 };
  const dependencies: HistoryDependencies = {
    ...base,
    createReader: (input) => {
      const reader = base.createReader(input);
      return {
        ...reader,
        getLogs: async (request) => {
          counter.requests += 1;
          return reader.getLogs(request);
        },
      };
    },
  };
  return { counter, dependencies };
};

const firstChainLogs = [{ eventName: "UserRequestForAffirmation", blockNumber: 150n, transactionHash: hash("a1"), args: { messageId: MESSAGE } }];
const secondChainLogs = [
  { eventName: "AffirmationCompleted", blockNumber: 160n, transactionHash: hash("b2"), args: { messageId: MESSAGE, status: true } },
  { eventName: "HeadUpdated", blockNumber: 170n, transactionHash: hash("c3"), args: { slot: 4_000n } },
];

const dependenciesWith = (fetchJson: JsonFetcher): HistoryDependencies => ({
  fetchJson,
  createReader: (input) => readerWith(input.chainId === 1 ? firstChainLogs : secondChainLogs),
  loadPair: async () => sharedPairForTests(),
  scanOf: unkeptScan,
});

const LIVE_VARIABLES = { VITE_EXPLORER_RPC_URL_1: "https://rpc-one.example.org" };

/** A page that keeps its filters in state, as the shell keeps them in the address. */
const Harness = ({ dependencies, onFilters, initial = EMPTY_HISTORY_FILTERS }: { readonly dependencies: HistoryDependencies; readonly onFilters?: (filters: HistoryFilters) => void; readonly initial?: HistoryFilters }) => {
  const [route, setRoute] = useState<Extract<Route, { name: "history" }>>({ name: "history", filters: initial });
  return (
    <HistoryPage
      route={route}
      dependencies={dependencies}
      onNavigate={(next) => {
        onFilters?.(next.filters);
        setRoute(next);
      }}
      onUpdate={setRoute}
    />
  );
};

const renderLive = (dependencies: HistoryDependencies, options: { readonly fallback?: boolean; readonly onFilters?: (filters: HistoryFilters) => void; readonly initial?: HistoryFilters } = {}) => {
  const fake = fakeConnections();
  const services = liveServices({ fake, variables: LIVE_VARIABLES });
  const connection = fake.made[0]!;
  if (options.fallback === true) {
    connection.run = vi.fn(async (operations) => {
      try {
        return await operations.viaIndexer();
      } catch {
        return operations.viaRpc();
      }
    });
  }
  return renderWithServices(<Harness dependencies={dependencies} {...(options.onFilters === undefined ? {} : { onFilters: options.onFilters })} {...(options.initial === undefined ? {} : { initial: options.initial })} />, services);
};

/** A slow machine renders Chakra slowly, so every wait on a request gets a long limit. */
const PATIENCE = { timeout: 20_000 };

const eventRows = (): HTMLElement[] => within(screen.getByRole("table", { name: "History events" })).getAllByRole("row").slice(1);

describe("the history view", () => {
  it("lists events with links to the message page", async () => {
    const { fetchJson, urls } = indexerFetcher(() => answer([headEvent, deliveredEvent, sentEvent]));
    renderLive(dependenciesWith(fetchJson));
    await screen.findByRole("table", { name: "History events" });
    expect(eventRows()).toHaveLength(3);
    const links = screen.getAllByRole("link", { name: /^Open message/ });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toHaveAttribute("href", `#/message/${MESSAGE}`);
    expect(within(eventRows()[0]!).getByText("Slot 4000")).toBeInTheDocument();
    const delivery = within(eventRows()[1]!).getAllByRole("cell");
    expect(delivery.map((cell) => cell.textContent).slice(1, 3)).toEqual(["Delivered", "PulseChain"]);
    expect(delivery[4]).toHaveTextContent("Delivered");
    expect(urls[0]).toBe("http://localhost:42069/api/history?");
    expect(screen.queryByText(/Partial history/)).not.toBeInTheDocument();
  });

  it("filters by pair, chain, event, kind and status", async () => {
    const { fetchJson, urls } = indexerFetcher(() => answer([sentEvent]));
    renderLive(dependenciesWith(fetchJson));
    await screen.findByRole("table", { name: "History events" }, PATIENCE);
    const choose = async (label: string, value: string, expected: string) => {
      await userEvent.selectOptions(screen.getByLabelText(label), value);
      await waitFor(() => expect(urls.at(-1)).toContain(expected), PATIENCE);
    };

    await choose("Pair and direction", "1>369", "direction=1%3E369");
    await choose("Chain", "369", "chain=369");
    await choose("Event", "sent", "eventKind=sent");
    await choose("Kind of message", "token", "kind=token");
    await choose("Status", "covered", "status=covered");

    for (const label of ["Pair and direction", "Chain", "Event", "Kind of message", "Status"]) await userEvent.selectOptions(screen.getByLabelText(label), "any");
    await waitFor(() => expect(urls.at(-1)).toBe("http://localhost:42069/api/history?"), PATIENCE);
  });

  it("filters by address, token and time, and clears them", async () => {
    const { fetchJson, urls } = indexerFetcher(() => answer([sentEvent]));
    renderLive(dependenciesWith(fetchJson));
    await screen.findByRole("table", { name: "History events" }, PATIENCE);
    await userEvent.type(screen.getByLabelText("Address"), "0x52908400098527886E0F7030069857D2E4169EE7");
    await waitFor(() => expect(urls.at(-1)).toContain("address=0x52908400098527886e0f7030069857d2e4169ee7"), PATIENCE);
    await userEvent.type(screen.getByLabelText("Token"), "0x52908400098527886E0F7030069857D2E4169EE8");
    await waitFor(() => expect(urls.at(-1)).toContain("token=0x52908400098527886e0f7030069857d2e4169ee8"), PATIENCE);
    fireEvent.change(screen.getByLabelText("From date (UTC)"), { target: { value: "2026-10-28" } });
    await waitFor(() => expect(urls.at(-1)).toContain("from=1793145600"), PATIENCE);
    fireEvent.change(screen.getByLabelText("To date (UTC)"), { target: { value: "2026-10-29" } });
    await waitFor(() => {
      expect(urls.at(-1)).toContain("from=1793145600");
      expect(urls.at(-1)).toContain("to=1793318399");
    }, PATIENCE);
    fireEvent.change(screen.getByLabelText("From date (UTC)"), { target: { value: "" } });
    await waitFor(() => expect(urls.at(-1)).not.toContain("from="), PATIENCE);

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(urls.at(-1)).toBe("http://localhost:42069/api/history?"), PATIENCE);
    expect(screen.getByLabelText("Address")).toHaveValue("");
    expect(screen.getByLabelText("Token")).toHaveValue("");
  });

  it("keeps the filters unchanged while an address or a token is still being typed", async () => {
    const { fetchJson } = indexerFetcher(() => answer([sentEvent]));
    const seen: HistoryFilters[] = [];
    renderLive(dependenciesWith(fetchJson), { onFilters: (filters) => seen.push(filters) });
    await screen.findByRole("table", { name: "History events" });
    await userEvent.type(screen.getByLabelText("Address"), "0x12");
    await userEvent.type(screen.getByLabelText("Token"), "0x34");
    expect(seen).toEqual([]);
    expect(screen.getAllByText("This is not an address yet. The list is not filtered by it.")).toHaveLength(2);
    await userEvent.clear(screen.getByLabelText("Address"));
    await userEvent.clear(screen.getByLabelText("Token"));
    expect(seen).toHaveLength(2);
  });

  it("asks for the next page with nextCursor, and goes back to the newest events", async () => {
    const cursor = `1800000100:sent:${MESSAGE}`;
    const { fetchJson, urls } = indexerFetcher((url) => (url.includes("cursor=") ? answer([sentEvent]) : answer([deliveredEvent], cursor)));
    renderLive(dependenciesWith(fetchJson));
    await screen.findByRole("table", { name: "History events" });
    expect(screen.queryByRole("button", { name: "Newest events" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Older events" }));
    await waitFor(() => expect(urls.at(-1)).toContain(`cursor=${encodeURIComponent(cursor)}`));
    await screen.findByRole("button", { name: "Newest events" });
    expect(screen.queryByRole("button", { name: "Older events" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Newest events" }));
    await waitFor(() => expect(urls.at(-1)).not.toContain("cursor="));
  });

  it("says plainly that head updates are left out while a filter on messages is on", async () => {
    const { fetchJson } = indexerFetcher(() => answer([sentEvent]));
    renderLive(dependenciesWith(fetchJson));
    await screen.findByRole("table", { name: "History events" });
    expect(screen.queryByText(/Head updates are not listed/)).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Status"), "covered");
    expect(await screen.findByText(/Head updates are not listed while a filter on message kind, status, token or address is on/)).toBeInTheDocument();
    expect(screen.getByText(/Head updates are not missing/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Status"), "any");
    await userEvent.selectOptions(screen.getByLabelText("Chain"), "369");
    await waitFor(() => expect(screen.queryByText(/Head updates are not listed/)).not.toBeInTheDocument());
  });

  it("with the indexer down the view shows RPC events and the words Partial history", async () => {
    const { fetchJson } = indexerFetcher(() => ({ status: 503, body: null }));
    renderLive(dependenciesWith(fetchJson), { fallback: true });
    expect(await screen.findByText(/Partial history/)).toBeInTheDocument();
    await screen.findByRole("table", { name: "History events" });
    const rows = eventRows();
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("Slot 4000")).toBeInTheDocument();
    // The delivery was found, so the send carries its outcome. Without the indexer the page does not guess more.
    expect(within(rows[2]!).getAllByRole("cell")[4]).toHaveTextContent("Delivered");
  });

  it("names the filters that the chains cannot apply when it falls back", async () => {
    const { fetchJson } = indexerFetcher(() => ({ status: 503, body: null }));
    renderLive(dependenciesWith(fetchJson), { fallback: true });
    await screen.findByRole("table", { name: "History events" });
    await userEvent.selectOptions(screen.getByLabelText("Status"), "covered");
    expect(await screen.findByText(/The chains cannot apply these filters, so they are off: status\./)).toBeInTheDocument();
  });

  it("with the chains answering, drops head updates under a message filter and says so, as with the indexer", async () => {
    const { fetchJson } = indexerFetcher(() => ({ status: 503, body: null }));
    renderLive(dependenciesWith(fetchJson), { fallback: true });
    await screen.findByRole("table", { name: "History events" }, PATIENCE);
    expect(screen.getByText("Slot 4000")).toBeInTheDocument();
    expect(screen.queryByText(/Head updates are not listed/)).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Kind of message"), "token");
    expect(await screen.findByText(/Head updates are not listed while a filter on message kind/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Slot 4000")).not.toBeInTheDocument(), PATIENCE);
    expect(eventRows()).toHaveLength(2);
  });

  it("does not read the chains again for a new filter or a new page", async () => {
    const { fetchJson } = indexerFetcher(() => ({ status: 503, body: null }));
    const { counter, dependencies } = countingDependencies(dependenciesWith(fetchJson));
    renderLive(dependencies, { fallback: true, initial: { ...EMPTY_HISTORY_FILTERS, limit: 1 } });
    await screen.findByRole("table", { name: "History events" }, PATIENCE);
    const afterFirstRead = counter.requests;
    expect(afterFirstRead).toBeGreaterThan(0);

    await userEvent.click(await screen.findByRole("button", { name: "Older events" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Newest events" })).toBeInTheDocument(), PATIENCE);
    await userEvent.selectOptions(screen.getByLabelText("Chain"), "369");
    await waitFor(() => expect(screen.getByLabelText("Chain")).toHaveValue("369"), PATIENCE);
    await screen.findByRole("table", { name: "History events" }, PATIENCE);
    expect(counter.requests).toBe(afterFirstRead);
  });

  it("says how far back the chains were read and reads further on request", async () => {
    const { fetchJson } = indexerFetcher(() => ({ status: 503, body: null }));
    const longChain = (input: { chainId: number }): ChainReader => ({
      ...readerWith([]),
      getBlock: async (selector) => ({ number: "tag" in selector ? 1_000_000n : selector.blockNumber, timestamp: 1_800_000_000n, baseFeePerGas: null }),
      getChainId: async () => input.chainId,
    });
    const { counter, dependencies } = countingDependencies({ ...dependenciesWith(fetchJson), createReader: longChain });
    renderLive(dependencies, { fallback: true });
    expect(await screen.findByText(/Read back to block 800001 on Ethereum\. Read back to block 800001 on PulseChain\./, undefined, PATIENCE)).toBeInTheDocument();
    const firstRead = counter.requests;
    await userEvent.click(screen.getByRole("button", { name: "Read further back" }));
    expect(await screen.findByText(/Read back to block 600001 on Ethereum/, undefined, PATIENCE)).toBeInTheDocument();
    expect(counter.requests).toBeGreaterThan(firstRead);
  });

  it("keeps a running scan alive when a filter changes, and the new read gets its result", async () => {
    const { fetchJson } = indexerFetcher(() => ({ status: 503, body: null }));
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let requests = 0;
    const gatedChain = (input: { chainId: number }): ChainReader => {
      const inner = readerWith(input.chainId === 1 ? firstChainLogs : secondChainLogs);
      return {
        ...inner,
        getLogs: async (request) => {
          requests += 1;
          await gate;
          return inner.getLogs(request);
        },
      };
    };
    renderLive({ ...dependenciesWith(fetchJson), createReader: gatedChain }, { fallback: true });
    await waitFor(() => expect(requests).toBeGreaterThan(0), PATIENCE);
    // The first read is still waiting for the chains. Edit a filter: a new read starts and joins the scan.
    await userEvent.selectOptions(screen.getByLabelText("Chain"), "369");
    await waitFor(() => expect(screen.getByLabelText("Chain")).toHaveValue("369"), PATIENCE);
    const requestsAtEdit = requests;
    open();
    await screen.findByRole("table", { name: "History events" }, PATIENCE);
    expect(screen.queryByText(/The history did not load/)).not.toBeInTheDocument();
    // Only events on chain 369 remain: the delivery and the head update.
    expect(eventRows()).toHaveLength(2);
    expect(requests).toBe(requestsAtEdit);
  });

  it("stops the scan of the chains when the reader leaves the page", async () => {
    const { fetchJson } = indexerFetcher(() => ({ status: 503, body: null }));
    let requests = 0;
    let leave: () => void = () => undefined;
    const slowChain = (): ChainReader => ({
      ...readerWith([]),
      getBlock: async (selector) => ({ number: "tag" in selector ? 1_000_000n : selector.blockNumber, timestamp: 1_800_000_000n, baseFeePerGas: null }),
      getLogs: async () => {
        requests += 1;
        if (requests === 4) leave();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [];
      },
    });
    const view = renderLive({ ...dependenciesWith(fetchJson), createReader: slowChain }, { fallback: true });
    leave = () => view.unmount();
    await waitFor(() => expect(requests).toBeGreaterThanOrEqual(4), PATIENCE);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const settled = requests;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requests).toBe(settled);
    expect(settled).toBeLessThan(80);
  });

  it("says when a send has no known status because its delivery is outside the blocks read", async () => {
    const { fetchJson } = indexerFetcher(() => ({ status: 503, body: null }));
    const dependencies: HistoryDependencies = { ...dependenciesWith(fetchJson), createReader: (input) => readerWith(input.chainId === 1 ? firstChainLogs : []) };
    renderLive(dependencies, { fallback: true });
    await screen.findByRole("table", { name: "History events" });
    expect(within(eventRows()[0]!).getByText("Not read from the chains")).toBeInTheDocument();
  });

  it("shows the problem when neither the indexer nor the chains answer", async () => {
    const { fetchJson } = indexerFetcher(() => ({ status: 503, body: null }));
    const dependencies: HistoryDependencies = { ...dependenciesWith(fetchJson), loadPair: async () => null };
    renderLive(dependencies, { fallback: true });
    expect(await screen.findByText(/The history did not load: The page has no deployment file/)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "History events" })).not.toBeInTheDocument();
  });

  it("does not send the form, so pressing Enter keeps the page", async () => {
    const { fetchJson } = indexerFetcher(() => answer([sentEvent]));
    renderLive(dependenciesWith(fetchJson));
    await screen.findByRole("table", { name: "History events" });
    expect(fireEvent.submit(screen.getByRole("search", { name: "History filters" }))).toBe(false);
  });

  it("reads the deployment file of the page for the chains when it has no other source of the pair", async () => {
    const fetchStub = vi.fn(async () => new Response("this is not json", { status: 503 }));
    vi.stubGlobal("fetch", fetchStub);
    try {
      const fake = fakeConnections();
      const services = liveServices({ fake, variables: LIVE_VARIABLES });
      fake.made[0]!.run = vi.fn(async (operations) => {
        try {
          return await operations.viaIndexer();
        } catch {
          return operations.viaRpc();
        }
      });
      renderWithServices(<HistoryView filters={EMPTY_HISTORY_FILTERS} onChange={() => undefined} scanBlocks={null} onScanBlocks={() => undefined} />, services);
      expect(await screen.findByText(/The history did not load:/)).toBeInTheDocument();
      expect(fetchStub).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("says when no event matches", async () => {
    const { fetchJson } = indexerFetcher(() => answer([]));
    renderLive(dependenciesWith(fetchJson));
    expect(await screen.findByText("No events match these filters.")).toBeInTheDocument();
  });

  it("on a sample page, says that the sample data has no history", () => {
    renderWithServices(<HistoryView filters={EMPTY_HISTORY_FILTERS} onChange={() => undefined} scanBlocks={null} onScanBlocks={() => undefined} />);
    expect(screen.getByText(/the sample data has no history/)).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
});
