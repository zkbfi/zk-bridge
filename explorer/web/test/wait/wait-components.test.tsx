import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { FeedItem } from "@terminal/model/types";
import { ServicesProvider, type Services } from "../../src/app/services";
import type { DeliveredCounts } from "../../src/explore/explore-source";
import { DirectionWait, ExploreWaits, TransferWaitLine, TransferWaitTime, WaitTimeline } from "../../src/wait/WaitTimeline";
import { WAIT_REFRESH_MILLISECONDS, useTimeline } from "../../src/wait/use-wait";
import { buildTimeline } from "../../src/wait/wait-model";
import { buildTestServices } from "../render";

/** Dollars as USD × 1e18. */
const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 1e6)) * 10n ** 12n;

const NOW = 1_800_000_000;
const spread = (median: number, p90: number) => ({ avg: null, median, p90 });
const window = (count: number) => ({ count, sentToDelivered: spread(900, 4000), steps: [spread(760, 790), spread(600, 3600), spread(30, 200)] as const });
const delivered = (sourceChainId: number, count: number): DeliveredCounts => ({ sourceChainId, last24h: count, last7d: count, timing: { last24h: window(count), last7d: window(count) } });

const BENCHMARK_STEPS = ["workerWait", "remote", "workerQueue", "workerProve", "total", "webhookToBoard", "boardPost", "proofToOnChain", "coveredToDelivered", "sentToDelivered"];
const stat = (count: number, medianMs: number | null, p90Ms: number | null) => ({ count, medianMs, p90Ms });
const steps = (total: ReturnType<typeof stat>) => Object.fromEntries(BENCHMARK_STEPS.map((step) => [step, step === "total" ? total : stat(0, null, null)]));
const benchmarks = { window: "7d", windowSeconds: 604_800, from: 0, to: 1, steps: steps(stat(9, 100_000, 160_000)), byDirection: { "first-to-second": steps(stat(9, 100_000, 160_000)), "second-to-first": steps(stat(0, null, null)) }, recent: [], indexer: "ok" };
const pipeline = (direction: string, rule?: object) => ({ direction, now: 1, batch: null, job: null, latestJob: null, latestProof: null, head: null, decision: null, ...(rule === undefined ? {} : { rule }) });
const TESTNET_RULE = { minIntervalSeconds: 3600, lookaheadSeconds: 768, profitMargin: 1, proofCostUsd: "0.025000", priced: false };

type Backend = { readonly rule?: object; readonly fail?: boolean };

/** Services with an indexer that answers `rows` and a backend that answers like a real one (or fails). */
const servicesWith = (rows: readonly DeliveredCounts[] | Error, backend: Backend | null): { services: Services; fetchJson: ReturnType<typeof vi.fn> } => {
  const base = buildTestServices();
  const fetchJson = vi.fn(async (url: string) => {
    if (backend?.fail === true) throw new Error("down");
    if (url.endsWith("/benchmarks?window=7d")) return { status: 200, body: benchmarks };
    const direction = /directions\/(.+)\/pipeline/.exec(url)?.[1] ?? "?";
    return { status: 200, body: pipeline(direction, backend?.rule) };
  });
  const services: Services = {
    ...base,
    now: () => NOW,
    explore: { ...base.explore, delivered: async () => (rows instanceof Error ? Promise.reject(rows) : rows) },
    endpoints: () => (backend === null ? base.endpoints() : ({ ...base.endpoints(), backendUrl: { value: "https://prove.example", source: "environment" } } as unknown as ReturnType<Services["endpoints"]>)),
    transport: { ...base.transport, fetchJson: fetchJson as unknown as Services["transport"]["fetchJson"] },
  };
  return { services, fetchJson };
};

const renderWith = (ui: ReactElement, services: Services) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })}>
      <ServicesProvider services={services}>{ui}</ServicesProvider>
    </QueryClientProvider>,
  );

const item = (overrides: Partial<FeedItem>): FeedItem =>
  ({ id: `0x${"aa".repeat(32)}`, kind: "token", direction: "first-to-second", status: "sent", sender: "0x52908400098527886E0F7030069857D2E4169EE7", recipient: "0x52908400098527886E0F7030069857D2E4169EE7", token: FIXTURE_TOKENS[0]!, amount: 1n, sentAt: NOW - 120, deliveredAt: null, sourceTransactionHash: `0x${"11".repeat(32)}`, destinationTransactionHash: null, ...overrides }) as FeedItem;

const inputs = { sourceChainId: FIXTURE_PAIR.first.chainId, timing: null, rule: { minIntervalSeconds: 3600, profitMargin: 1, proofCostUsd: 0.025, priced: false }, proving: null };

describe("the timeline panel (2026-11-07)", () => {
  it("lists the four steps with a typical and a worst case each, the total on top, and what it rests on", () => {
    const { container } = render(<WaitTimeline timeline={buildTimeline(inputs, { kind: "unknown" })} sourceName="Sepolia" />);
    // Final by the chain's rule: 81.5 to 97 slots after the send (expectedFinalityAt, the backend's watcher too).
    expect(screen.getByText(/^typical 49 min · up to 89 min$/)).toBeInTheDocument();
    const rows = within(container.querySelector(".zb-wait-steps") as HTMLElement).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector(".zb-wait-label")?.firstChild?.textContent)).toEqual(["Sent", "Final on Sepolia", "Proved", "Delivered"]);
    expect(rows[2]).toHaveTextContent("Testnet: proofs run at least hourly");
    expect(rows[2]!.querySelector(".zb-wait-typical")).toHaveTextContent("32 min");
    expect(rows[2]!.querySelector(".zb-wait-worst")).toHaveTextContent("64 min");
    expect(screen.getByText(/Based on the chain and the proof rule\. Request a proof starts one now\./)).toBeInTheDocument();
  });

  it("names Request a proof only when the proof may wait for a batch", () => {
    render(<WaitTimeline timeline={buildTimeline({ ...inputs, rule: { ...inputs.rule, priced: true } }, { kind: "known", feeUsd: usd(1), costUsd: usd(0.1) })} sourceName="Ethereum" />);
    expect(screen.getByText("A proof starts at finality")).toBeInTheDocument();
    expect(screen.queryByText(/Request a proof/)).toBeNull();
  });
});

describe("the data behind the timeline (2026-11-07)", () => {
  it("a direction with 20 deliveries and a backend: measured steps and the backend's rule and proving time", async () => {
    const { services, fetchJson } = servicesWith([delivered(FIXTURE_PAIR.first.chainId, 20)], { rule: TESTNET_RULE });
    const { container } = renderWith(<DirectionWait direction="first-to-second" pair={FIXTURE_PAIR} />, services);
    await waitFor(() => expect(screen.getByText(/Based on 20 transfers in the last 7 days/)).toBeInTheDocument());
    expect(fetchJson).toHaveBeenCalledWith("https://prove.example/directions/first-to-second/pipeline");
    expect(fetchJson).toHaveBeenCalledWith("https://prove.example/benchmarks?window=7d");
    // Observed: the proof step is the measured wait of 10 to 60 minutes.
    expect(container.querySelector('[data-step="proved"] .zb-wait-typical')).toHaveTextContent("10 min");
    expect(container.querySelector('[data-step="proved"] .zb-wait-worst')).toHaveTextContent("60 min");
    expect(screen.getByRole("region", { name: `Wait from ${FIXTURE_PAIR.first.name} to ${FIXTURE_PAIR.second.name}` })).toBeInTheDocument();
  });

  it("a backend with a rule gives the pill the proof rule's wait and the proving time it measured", async () => {
    const { services } = servicesWith([], { rule: TESTNET_RULE });
    const Probe = () => {
      const timeline = useTimeline("first-to-second", { kind: "unknown" });
      return <p>{`${timeline.start} ${timeline.steps[2].range.typical}`}</p>;
    };
    renderWith(<Probe />, services);
    // 3600 / 2 + 100 s total proving; the answer arrives after the first render's fallback of 120 s.
    await waitFor(() => expect(screen.getByText("testnet 1900")).toBeInTheDocument());
  });

  it("an older backend that reports no rule leaves the rule out", async () => {
    const { services } = servicesWith([], {});
    const Probe = () => <p>{useTimeline("first-to-second", { kind: "unknown" }).start}</p>;
    renderWith(<Probe />, services);
    await waitFor(() => expect(screen.getByText("unknown")).toBeInTheDocument());
  });

  it("with no backend set and an indexer that fails, the timeline is the chain's and the rule's own", async () => {
    const { services, fetchJson } = servicesWith(new Error("indexer down"), null);
    const Probe = () => <p>{useTimeline("second-to-first", { kind: "unknown" }).basis}</p>;
    renderWith(<Probe />, services);
    await waitFor(() => expect(screen.getByText("derived")).toBeInTheDocument());
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("a backend that fails leaves both the rule and the proving time out, and the page still draws", async () => {
    const { services, fetchJson } = servicesWith([delivered(FIXTURE_PAIR.first.chainId, 20)], { fail: true });
    renderWith(<DirectionWait direction="first-to-second" pair={FIXTURE_PAIR} />, services);
    await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/Based on 20 transfers/)).toBeInTheDocument());
  });

  it("is read once per five minutes", () => {
    expect(WAIT_REFRESH_MILLISECONDS).toBe(300_000);
  });
});

describe("a transfer in flight (2026-11-07)", () => {
  const { services } = servicesWith([], null);
  it("shows the time left and when it usually finishes, up to when", async () => {
    renderWith(
      <>
        <TransferWaitTime row={item({ status: "waiting_for_finality", sentAt: NOW - 600 })} now={NOW} />
        <TransferWaitLine row={item({ status: "waiting_for_finality", sentAt: NOW - 600 })} now={NOW} pair={FIXTURE_PAIR} />
      </>,
      services,
    );
    expect(screen.getByText(/^\d+ min left$/)).toBeInTheDocument();
    expect(screen.getByText(/^Usually done by \d\d:\d\d, up to \d\d:\d\d\.$/)).toBeInTheDocument();
  });

  it("a proven transfer has the delivery step left", () => {
    renderWith(<TransferWaitTime row={item({ status: "covered" })} now={NOW} />, services);
    expect(screen.getByText("1 min left")).toBeInTheDocument();
  });

  it("a transfer past its worst case says so, and names the destination", () => {
    renderWith(
      <>
        <TransferWaitTime row={item({ status: "waiting_for_finality", sentAt: NOW - 10 * 86_400 })} now={NOW} />
        <TransferWaitLine row={item({ status: "waiting_for_finality", sentAt: NOW - 10 * 86_400 })} now={NOW} pair={FIXTURE_PAIR} />
      </>,
      services,
    );
    expect(screen.getByText("past the worst case")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`^Past the worst case of \\d+ min for ${FIXTURE_PAIR.second.name}`))).toBeInTheDocument();
  });

  it("a delivered transfer shows nothing", () => {
    const { container } = renderWith(
      <>
        <TransferWaitTime row={item({ status: "delivered", deliveredAt: NOW })} now={NOW} />
        <TransferWaitLine row={item({ status: "delivered", deliveredAt: NOW })} now={NOW} pair={FIXTURE_PAIR} />
      </>,
      services,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Explore (2026-11-07)", () => {
  it("shows both directions of the pair", async () => {
    const { services } = servicesWith([], null);
    renderWith(<ExploreWaits pair={FIXTURE_PAIR} />, services);
    expect(screen.getByRole("heading", { name: "How long a transfer takes" })).toBeInTheDocument();
    expect(screen.getAllByRole("region", { name: /^Wait from / })).toHaveLength(2);
    expect(screen.getAllByText("Based on the chain and the proof rule.")).toHaveLength(2);
  });
});
