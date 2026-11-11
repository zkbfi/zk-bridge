import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { FIXTURE_NOW, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { FeedItem } from "@terminal/model/types";
import { ChainTiming, chainTotals, InFlightOrbits, planetLabel, SunTip, usePrefersReducedMotion } from "../../src/explore/InFlightOrbits";
import type { DirectionTiming, Spread } from "../../src/explore/explore-source";
import { orbitTracks, type OrbitTrack } from "../../src/explore/orbit-model";

const usdc = FIXTURE_TOKENS[0]!;
const id = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const row = (n: number, status: FeedItem["status"], over: Partial<FeedItem> = {}): FeedItem => ({
  id: id(n),
  kind: "token",
  direction: "first-to-second",
  status,
  sender: `0x${"1".repeat(40)}` as Hex,
  recipient: `0xabcdef${"2".repeat(30)}1234` as Hex,
  token: usdc,
  amount: 1_500_000_000n,
  sentAt: FIXTURE_NOW - 600,
  deliveredAt: null,
  sourceTransactionHash: `0x${"3".repeat(64)}` as Hex,
  destinationTransactionHash: null,
  ...over,
});
const message = (n: number, over: Partial<FeedItem> = {}): FeedItem => row(n, "sent", { kind: "message", token: null, amount: null, ...over });
const tracksOf = (inFlight: readonly FeedItem[], priceOf: (token: { readonly symbol: string }) => number | null = () => 1): readonly OrbitTrack[] =>
  orbitTracks({ pair: FIXTURE_PAIR, inFlight, delivered: [], priceOf, now: FIXTURE_NOW });

const spread = (over: Partial<Spread> = {}): Spread => ({ avg: 40, median: 30, p90: 50, ...over });
const windowOf = (steps: Spread, total: Spread = spread()) => ({ count: 4, sentToDelivered: total, steps: [steps, steps, steps] as const });
const timingOf = (steps: Spread, steps7d: Spread = steps): DirectionTiming => ({ last24h: windowOf(steps), last7d: windowOf(steps7d) });

beforeEach(() => {
  window.location.hash = "#/explore";
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("usePrefersReducedMotion", () => {
  const stubMedia = (matches: boolean) => {
    const listeners = new Set<() => void>();
    const media = {
      matches,
      addEventListener: vi.fn((_: string, listener: () => void) => void listeners.add(listener)),
      removeEventListener: vi.fn((_: string, listener: () => void) => void listeners.delete(listener)),
    };
    vi.spyOn(window, "matchMedia").mockReturnValue(media as unknown as MediaQueryList);
    return { media, listeners };
  };

  it("reads the setting and follows its changes, and lets go of the listener", () => {
    const { media, listeners } = stubMedia(false);
    const { result, unmount } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    media.matches = true;
    act(() => listeners.forEach((listener) => listener()));
    expect(result.current).toBe(true);
    unmount();
    expect(media.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    expect(listeners.size).toBe(0);
  });

  it("starts reduced when the user already asked for it, and the loop then runs no frames", () => {
    stubMedia(true);
    render(<InFlightOrbits tracks={tracksOf([row(1, "sent")])} now={FIXTURE_NOW} />);
    expect(document.querySelector("svg.zb-orb-svg")).toHaveAttribute("data-reduced", "true");
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });
});

describe("a planet's label", () => {
  it("names a message, a priceless transfer and one due any moment", () => {
    const [planet] = tracksOf([message(1)], () => null)[0]!.planets;
    expect(planetLabel({ ...planet!, leftSeconds: 0 }, FIXTURE_NOW)).toMatch(/^Message, .* to .*, to 0xabcd…1234, Sent, waiting for finality, sent 10 min ago, any moment now$/);
    const [priced] = tracksOf([row(1, "sent")])[0]!.planets;
    expect(planetLabel({ ...priced!, leftSeconds: 120 }, FIXTURE_NOW)).toMatch(/^1500 USDC \(about \$1,500\.00\), .*, ~2 min left$/);
  });
});

describe("chain totals", () => {
  it("adds up each chain's own lane and the lane arriving at it", () => {
    const tracks = tracksOf([row(1, "sent"), message(2)]);
    const pair = [tracks[0]!, tracks[1]!] as const;
    expect(chainTotals(pair, 0)).toMatchObject({ out: { inFlight: 2, usd: 1500 }, in: { inFlight: 0, usd: null } });
    expect(chainTotals(pair, 1)).toMatchObject({ out: { inFlight: 0 }, in: { inFlight: 2 } });
  });
});

describe("the section with no tracks", () => {
  it("draws nothing before the pair's two tracks are known", () => {
    const { container } = render(<InFlightOrbits tracks={[]} now={FIXTURE_NOW} reducedMotion />);
    expect(container).toBeEmptyDOMElement();
    const one = render(<InFlightOrbits tracks={tracksOf([]).slice(0, 1)} now={FIXTURE_NOW} reducedMotion />);
    expect(one.container).toBeEmptyDOMElement();
  });
});

describe("the loop's size", () => {
  it("follows the column's width when it changes, and keeps the loop when the width stays", () => {
    let measure: () => void = () => undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          measure = callback;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    let width = 0;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    const { container } = render(<InFlightOrbits tracks={tracksOf([row(1, "sent")])} now={FIXTURE_NOW} reducedMotion />);
    const svg = container.querySelector("svg.zb-orb-svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 780 440");
    const before = svg.getAttribute("viewBox");
    act(() => {
      width = 800;
      measure();
    });
    expect(svg.getAttribute("viewBox")).toBe(before);
    act(() => {
      width = 400;
      measure();
    });
    expect(svg.getAttribute("viewBox")!.startsWith("0 0 400 ")).toBe(true);
  });
});

describe("tooltips", () => {
  const planet = () => document.querySelector<SVGGElement>(".zb-orb-planet")!;

  it("moves the planet's tooltip with the pointer, and puts it above the pointer near the bottom of the window", () => {
    render(<InFlightOrbits tracks={tracksOf([row(1, "sent")])} now={FIXTURE_NOW} reducedMotion />);
    const enter = new Event("pointerenter", { bubbles: true });
    Object.assign(enter, { clientX: 100, clientY: window.innerHeight - 20, pointerType: "mouse" });
    act(() => void planet().dispatchEvent(enter));
    const tip = screen.getByRole("tooltip");
    expect(parseFloat(tip.style.top)).toBeLessThan(window.innerHeight - 20);
    const move = new Event("pointermove", { bubbles: true });
    Object.assign(move, { clientX: 300, clientY: 50 });
    act(() => void planet().dispatchEvent(move));
    expect(tip.style.left).toBe("314px");
    expect(tip.style.top).toBe("64px");
  });

  it("ignores a pointer move over a planet while no tooltip is shown", () => {
    render(<InFlightOrbits tracks={tracksOf([row(1, "sent")])} now={FIXTURE_NOW} reducedMotion />);
    act(() => void planet().dispatchEvent(new Event("pointermove", { bubbles: true })));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows a message with no amount and no price in its tooltip, and keeps it when a refresh drops the planet", () => {
    const { rerender } = render(<InFlightOrbits tracks={tracksOf([message(1)], () => null)} now={FIXTURE_NOW} reducedMotion />);
    act(() => planet().focus());
    const tip = screen.getByRole("tooltip");
    expect(within(tip).getByText("Message")).toBeInTheDocument();
    expect(tip.querySelector(".zb-orb-tip-amt")).not.toHaveTextContent("≈");
    rerender(<InFlightOrbits tracks={tracksOf([])} now={FIXTURE_NOW} reducedMotion />);
    // The planet is gone from the data: the open tooltip still has its last values.
    expect(screen.getByRole("tooltip")).toHaveTextContent("Message");
  });

  it("shows the newest data of a planet in its open tooltip after a refresh", () => {
    const { rerender } = render(<InFlightOrbits tracks={tracksOf([row(1, "sent")])} now={FIXTURE_NOW} reducedMotion />);
    act(() => planet().focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent("At: Sent");
    rerender(<InFlightOrbits tracks={tracksOf([row(1, "covered")])} now={FIXTURE_NOW} reducedMotion />);
    expect(screen.getByRole("tooltip")).toHaveTextContent("At: Proof ready");
  });

  it("lists a message in the list without a token icon", () => {
    render(<InFlightOrbits tracks={tracksOf([message(1)])} now={FIXTURE_NOW} reducedMotion />);
    const item = screen.getAllByRole("listitem")[0]!;
    expect(item.querySelector(".zb-tok-icon")).toBeNull();
    expect(item).toHaveTextContent(/^Message, /);
  });

  it("toggles a chain's totals by clicking its node, and puts them away on a second click", () => {
    render(<InFlightOrbits tracks={tracksOf([row(1, "sent")])} now={FIXTURE_NOW} reducedMotion />);
    const node = screen.getAllByRole("button", { name: /in flight, in .* in flight/ })[0]!;
    fireEvent.click(node);
    expect(screen.getByRole("tooltip")).toHaveTextContent(FIXTURE_PAIR.first.nativeSymbol);
    fireEvent.click(node);
    expect(screen.queryByRole("tooltip")).toBeNull();
    // A click on the other chain's node while the first is open shows the other's.
    fireEvent.click(node);
    fireEvent.click(screen.getAllByRole("button", { name: /in flight, in .* in flight/ })[1]!);
    expect(screen.getByRole("tooltip")).toHaveTextContent(FIXTURE_PAIR.second.nativeSymbol);
  });

  it("shows the second lane's summary from its sun, with both chains' timing in the chain tooltip", () => {
    const tracks = tracksOf([row(1, "sent", { direction: "second-to-first", token: FIXTURE_TOKENS[4]! }), row(2, "sent")]).map((track) => ({ ...track, timing: timingOf(spread()) }));
    render(<InFlightOrbits tracks={tracks} now={FIXTURE_NOW} reducedMotion />);
    const sun = screen.getAllByRole("button", { name: /^Sent, .* to .*: totals$/ })[1]!;
    act(() => sun.focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent(/1 transfer/);
    act(() => sun.blur());
    fireEvent.click(screen.getAllByRole("button", { name: /in flight, in .* in flight/ })[1]!);
    expect(within(screen.getByRole("tooltip")).getByRole("table", { name: "Sent → delivered" })).toHaveTextContent("Out 24 h");
  });
});

describe("a step's summary", () => {
  const sunTip = (track: OrbitTrack, step: 0 | 1 | 2 = 0) => render(<SunTip track={track} step={step} now={FIXTURE_NOW} />);

  it("says one transfer in the singular, and a message line without an amount, value or fee", () => {
    sunTip(tracksOf([message(1)], () => null)[0]!);
    expect(screen.getByText(/^1 transfer · —$/)).toBeInTheDocument();
    const line = within(screen.getByRole("table")).getAllByRole("row")[1]!;
    expect(line).toHaveTextContent(/^1× message———$/);
    // No timing for it: no usual line; the wait now has no usual time to be slower than.
    expect(document.querySelector(".zb-orb-tip-usual")).toBeNull();
    expect(document.querySelector(".zb-orb-tip-wait")).toHaveTextContent(/^Waiting here now: 10 min avg · 10 min median · 10 min longest$/);
    expect(screen.queryByText(/slower than usual/)).toBeNull();
  });

  it("shows no table and no waiting time for an empty step", () => {
    sunTip(tracksOf([row(1, "sent")])[0]!, 2);
    expect(screen.getByText(/^0 transfers · —$/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelector(".zb-orb-tip-wait")).toBeNull();
    expect(document.querySelector(".zb-orb-tip-fees")).toHaveTextContent(/cost to deliver all: —$/);
  });

  it("compares the wait with the usual time here: the median and p90 of 24 h and the median of 7 d, and says when it is slower", () => {
    const [track] = tracksOf([row(1, "sent")]);
    sunTip({ ...track!, timing: timingOf(spread({ median: 45, p90: 55 }), spread({ median: 30 })) });
    expect(document.querySelector(".zb-orb-tip-usual")).toHaveTextContent("Usual time at this step: 45 s median · 55 s p90 (24 h); 30 s median (7 d)");
    expect(screen.getByText(/slower than usual/)).toBeInTheDocument();
  });

  it("leaves out the p90 and the 7 d median the indexer does not give, and the whole line without a 24 h median", () => {
    const [track] = tracksOf([row(1, "sent")]);
    const first = sunTip({ ...track!, timing: timingOf(spread({ median: 700, p90: null }), spread({ median: null })) });
    expect(document.querySelector(".zb-orb-tip-usual")!.textContent).toBe("Usual time at this step: 12 min median · — p90 (24 h)");
    expect(screen.queryByText(/slower than usual/)).toBeNull();
    first.unmount();
    sunTip({ ...track!, timing: timingOf(spread({ median: null })) });
    expect(document.querySelector(".zb-orb-tip-usual")).toBeNull();
  });
});

describe("a chain's timing table", () => {
  it("is not drawn without any timing, and has dashes for the direction without one", () => {
    const none = render(<ChainTiming out={null} back={null} />);
    expect(none.container).toBeEmptyDOMElement();
    render(<ChainTiming out={timingOf(spread())} back={null} />);
    const rows = within(screen.getByRole("table")).getAllByRole("row").map((tr) => tr.textContent);
    expect(rows).toEqual(["Sent → deliveredavgmedianp90", "Out 24 h40 s30 s50 s", "Out 7 d40 s30 s50 s", "In 24 h———", "In 7 d———"]);
  });
});
